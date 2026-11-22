// Pruebas de la API de VISIÓN con un almacenamiento simulado
// que imita las escrituras condicionales (ETag) de Netlify Blobs.
// Ejecutar: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const data = new Map();
const etagOf = (v) => '"' + createHash('sha1').update(typeof v === 'string' ? v : Buffer.from(v)).digest('hex') + '"';
const delay = () => new Promise((r) => setTimeout(r, Math.random() * 15));
const mkStore = (ns) => ({
  async getWithMetadata(key, { type } = {}) {
    await delay(); const v = data.get(ns + key); if (v === undefined) return null;
    return { data: type === 'arrayBuffer' ? v.buf : JSON.parse(v.s), etag: etagOf(v.s ?? v.buf), metadata: v.meta || {} };
  },
  async setJSON(key, value, opts = {}) {
    await delay();
    const cur = data.get(ns + key);
    if (opts.onlyIfNew && cur !== undefined) return { modified: false };
    if (opts.onlyIfMatch && (cur === undefined || etagOf(cur.s) !== opts.onlyIfMatch)) return { modified: false };
    const s = JSON.stringify(value); data.set(ns + key, { s }); return { modified: true, etag: etagOf(s) };
  },
  async set(key, buf, { metadata } = {}) { data.set(ns + key, { buf, meta: metadata }); return { modified: true }; },
});
globalThis.__visionTestStore = mkStore('v:');
globalThis.__mesaTestStore = mkStore('m:');
await globalThis.__mesaTestStore.setJSON('config/mesas', { mesas: ['Juan y Lili', 'Daniela y Esteban'] });
process.env.VISION_ADMIN_KEY = 'clave-de-prueba';
const { default: handler } = await import('../netlify/functions/vision.mjs');
const K = { 'x-admin-key': 'clave-de-prueba' };
async function call(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const init = { method, headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', ...headers } };
  if (raw) init.body = raw; else if (body) init.body = JSON.stringify(body);
  const res = await handler(new Request('http://x/api/vision' + path, init), { ip: '1.2.3.4' });
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? { code: res.status, ...(await res.json()) } : { code: res.status, ct, buf: await res.arrayBuffer() };
}
const old = Date.now() - 5000;
const fam = (i, extra = {}) => call('/register', { method: 'POST', body: {
  phone: '3001110' + String(i).padStart(3, '0'), mesa: 'Juan y Lili', consent: true, guardian: true, startedAt: old,
  adults: [{ firstName: 'adulto', lastName: 'uno ' + i }, { firstName: 'ADULTO', lastName: 'DOS ' + i }],
  children: [{ firstName: 'niño', lastName: 'uno', age: 5 }, { firstName: 'niña', lastName: 'dos', age: 11 }], ...extra } });
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);

test('crea la edición con los datos confirmados y sin cifras privadas', async () => {
  const r = await call('/event');
  assert.equal(r.ok, true);
  assert.equal(r.state, 'open');
  assert.equal(r.edition.date, '2026-12-19');
  assert.equal(r.edition.prices.adult, 75000);
  assert.equal(r.edition.prices.child, 40000);
  assert.equal(Date.parse(r.edition.closeAt), Date.parse('2026-12-15T23:59:59-05:00'));
  assert.match(r.edition.refundText, /fuerza mayor/);
  for (const k of ['waitlist', 'equipo']) assert.ok(!(k in r.edition), k);
  for (const k of ['capacity', 'groups', 'paymentUrl', 'holdMinutes']) assert.ok(!(k in r.edition), k);
  assert.deepEqual(r.mesas, ['Juan y Lili', 'Daniela y Esteban']);
});

test('admin requiere la contraseña', async () => {
  assert.equal((await call('/admin/overview')).code, 401);
  assert.equal((await call('/admin/overview', { headers: { 'x-admin-key': 'otra' } })).code, 401);
  assert.equal((await call('/admin/overview', { headers: K })).ok, true);
});

let g1;
test('2 adultos y 2 niños: total calculado en el servidor = $220.000 y nombres con mayúscula', async () => {
  const r = await fam(1, { adults: [{ firstName: 'adulto', lastName: 'uno' }, { firstName: 'ADULTO', lastName: 'DOS' }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.expected, 2 * 75000 + 2 * 40000);
  assert.ok(r.paymentUrl.startsWith('https://'));
  g1 = r.token;
  const v = await call('/g/' + g1);
  assert.equal(v.status, 'reservado');
  assert.deepEqual(v.attendees.map((a) => a.name), ['Adulto Uno', 'Adulto Dos', 'Niño Uno', 'Niña Dos']);
  assert.ok(!JSON.stringify(v).includes('3001110001'));
});

test('validaciones: edad de niño, adulto responsable, autorizaciones y máximo por grupo', async () => {
  assert.equal((await fam(2, { children: [{ firstName: 'Ana', lastName: 'Paz', age: 12 }] })).error, 'age');
  assert.equal((await fam(2, { adults: [] })).error, 'adult');
  assert.equal((await fam(2, { consent: false })).error, 'consent');
  assert.equal((await fam(2, { guardian: false })).error, 'guardian');
  const many = Array.from({ length: 11 }, (_, i) => ({ firstName: 'Per', lastName: 'Sona' + i }));
  assert.equal((await fam(2, { adults: many, children: [] })).error, 'max');
});

test('comprobante: rechaza tipos no permitidos y pasa a revisión con JPG', async () => {
  assert.equal((await call('/g/' + g1 + '/proof', { method: 'POST', raw: GIF })).error, 'type');
  const r = await call('/g/' + g1 + '/proof', { method: 'POST', raw: JPG });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.status, 'revision');
  assert.equal(r.hasProof, true);
});

let ticketToken, groupId;
test('aprobar emite 4 boletas, suma el recaudo una sola vez y el panel ve el comprobante', async () => {
  const o = await call('/admin/overview', { headers: K });
  const g = o.edition.groups.find((x) => x.eff === 'revision');
  groupId = g.id;
  const proof = await call(`/admin/proof/${g.id}/1`, { headers: K });
  assert.equal(proof.ct, 'image/jpeg');
  assert.equal((await call('/admin/group', { method: 'POST', headers: K, body: { groupId: g.id, action: 'approve', amount: 100000 } })).error, 'amount');
  const a = await call('/admin/group', { method: 'POST', headers: K, body: { groupId: g.id, action: 'approve' } });
  assert.equal(a.ok, true, a.message);
  await call('/admin/group', { method: 'POST', headers: K, body: { groupId: g.id, action: 'approve' } }); // doble toque
  const o2 = await call('/admin/overview', { headers: K });
  assert.equal(o2.edition.counts.recaudo, 230000);
  assert.equal(o2.edition.counts.confirmados, 4);
  const v = await call('/g/' + g1);
  assert.equal(v.status, 'aprobado');
  assert.equal(v.attendees.filter((x) => /^VIS27-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(x.code)).length, 4);
  assert.equal(new Set(v.attendees.map((x) => x.code)).size, 4);
  ticketToken = v.attendees[2].ticket;
  const t = await call('/t/' + ticketToken);
  assert.equal(t.valid, true);
  assert.equal(t.type, 'child');
});

test('llegada: por QR (URL de la boleta) y aviso si ya había llegado', async () => {
  const r = await call('/admin/checkin', { method: 'POST', headers: K, body: { code: 'https://lhscolweb.netlify.app/vision/boleta/?t=' + ticketToken } });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.already, false);
  assert.equal(r.group.arrived, 1);
  const again = await call('/admin/checkin', { method: 'POST', headers: K, body: { code: 'https://lhscolweb.netlify.app/vision/boleta/?t=' + ticketToken } });
  assert.equal(again.already, true);
  const v = await call('/g/' + g1);
  const code = v.attendees[0].code;
  assert.equal((await call('/admin/checkin', { method: 'POST', headers: K, body: { code: code.toLowerCase() } })).group.arrived, 2);
  assert.equal((await call('/admin/checkin', { method: 'POST', headers: K, body: { code: 'VIS27-AAAA-AAAA' } })).code, 404);
});

test('rechazar pide motivo y deja corregir; un grupo sin pago aprobado no entra', async () => {
  const r = await fam(3);
  const o = await call('/admin/overview', { headers: K });
  const g = o.edition.groups.find((x) => x.eff === 'reservado');
  assert.equal((await call('/admin/group', { method: 'POST', headers: K, body: { groupId: g.id, action: 'reject' } })).error, 'reason');
  const j = await call('/admin/group', { method: 'POST', headers: K, body: { groupId: g.id, action: 'reject', reason: 'El comprobante no se ve' } });
  assert.equal(j.group.status, 'rechazado');
  const v = await call('/g/' + r.token);
  assert.equal(v.reason, 'El comprobante no se ve');
  assert.ok(v.attendees.every((a) => !a.ticket));
  const up = await call('/g/' + r.token + '/proof', { method: 'POST', raw: new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2]) });
  assert.equal(up.status, 'revision');
});

test('comprobante repetido en otro grupo queda marcado', async () => {
  const r = await fam(4);
  await call('/g/' + r.token + '/proof', { method: 'POST', raw: JPG });
  const o = await call('/admin/overview', { headers: K });
  const g = o.edition.groups.find((x) => x.phone === '573001110004');
  assert.equal(g.proofs[0].duplicate, true);
});

test('aforo: 40 familias de 4 al mismo tiempo con aforo 60 → nunca se pasa', async () => {
  const o = await call('/admin/overview', { headers: K });
  const e = o.edition;
  const before = e.counts.ocupados;
  await call('/admin/edition', { method: 'POST', headers: K, body: { date: e.date, time: e.time, endTime: e.endTime, venue: e.venue, city: e.city, priceAdult: 75000, priceChild: 40000, closeAt: '2026-12-05T23:59', capacity: 60, paymentUrl: e.paymentUrl } });
  const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => fam(100 + i)));
  const okN = rs.filter((r) => r.ok).length;
  assert.equal(okN, Math.floor((60 - before) / 4));
  assert.ok(rs.filter((r) => !r.ok).every((r) => r.error === 'full'));
  const ev = await call('/event');
  assert.equal(ev.state, 'full');
  assert.ok(!JSON.stringify(ev).match(/"(ocupados|capacity)"/));
  const o2 = await call('/admin/overview', { headers: K });
  assert.ok(o2.edition.counts.ocupados <= 60);
});

test('lista de espera: solo con aforo lleno, sin repetir número, y el panel la ve', async () => {
  const w = (extra = {}) => call('/waitlist', { method: 'POST', body: { name: 'marta ruiz', phone: '3115556677', adults: 2, children: 1, consent: true, startedAt: old, ...extra } });
  const a = await w();
  assert.equal(a.ok, true, a.message);
  assert.equal((await w()).already, true);
  const o = await call('/admin/overview', { headers: K });
  const entry = o.edition.waitlist[0];
  assert.equal(entry.name, 'Marta Ruiz');
  const n = await call('/admin/waitlist', { method: 'POST', headers: K, body: { id: entry.id, notified: true } });
  assert.ok(n.entry.notifiedAt);
});

test('inscripción en la puerta: queda aprobada, con boletas y llegada', async () => {
  const r = await call('/admin/add', { method: 'POST', headers: K, body: { phone: '3109998877', atDoor: true, payMethod: 'efectivo', adults: [{ firstName: 'Luis', lastName: 'Mora' }], children: [] } });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.group.status, 'aprobado');
  assert.equal(r.group.approvedAmount, 75000);
  assert.ok(r.group.attendees[0].attended);
  assert.ok(r.group.attendees[0].ticket.code.startsWith('VIS27-'));
});

test('el nombre de la temporada no aparece en la API ni en las páginas', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = ['netlify/functions/vision.mjs', ...readdirSync('vision', { recursive: true }).filter((f) => f.endsWith('.html')).map((f) => 'vision/' + f)];
  const secret = Buffer.from('YSB0b2RvIGNvbG9y', 'base64').toString(); // se guarda codificado para no escribirlo
  for (const f of files) assert.ok(!plainText(readFileSync(f, 'utf8')).includes(secret), f);
});
function plainText(s) { return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

test('página del equipo: plan público sin cifras y hora real del día', async () => {
  const r = await call('/equipo');
  assert.equal(r.ok, true);
  assert.ok(r.plan.length >= 5);
  assert.ok(!/recaudo|capacity|paymentUrl|groups/.test(JSON.stringify(r)));
  assert.equal((await call('/admin/equipo', { method: 'POST', headers: K, body: { start: '25:00' } })).error, 'start');
  await call('/admin/equipo', { method: 'POST', headers: K, body: { start: '18:20', plan: [{ t: '18:00', title: 'Bienvenida', who: 'Coordinación' }, { t: 'xx', title: 'mal' }] } });
  const q = await call('/equipo');
  assert.equal(q.start, '18:20');
  assert.equal(q.plan.length, 1);
});

test('una edición guardada con el cierre viejo (5 de diciembre) pasa al 15 de diciembre', async () => {
  const k = 'v:edition/2027';
  const raw = JSON.parse(data.get(k).s);
  raw.closeAt = '2026-12-06T04:59:59.000Z'; delete raw.rev; delete raw.refundText;
  data.set(k, { s: JSON.stringify(raw) });
  const r = await call('/event');
  assert.equal(Date.parse(r.edition.closeAt), Date.parse('2026-12-15T23:59:59-05:00'));
  assert.match(r.edition.refundText, /devoluciones/);
});

test('migración del 21-11: niño a $40.000 y "Temporada 2027" sin tocar los totales ya inscritos', async () => {
  const key = [...data.keys()].find((k) => k.startsWith('v:edition/'));
  const e = JSON.parse(data.get(key).s);
  const before = e.groups.map((g) => g.expected);
  e.rev = 2; e.prices.child = 35000; e.highlights = 'Music · Mensaje · Tema 2027';
  if (e.equipo && Array.isArray(e.equipo.plan)) e.equipo.plan.push({ t: '20:15', title: 'Revelación del tema 2027' });
  data.set(key, { s: JSON.stringify(e) });
  const r = await call('/event');
  assert.equal(r.edition.prices.child, 40000);
  assert.equal(r.edition.highlights, 'Music · Mensaje · Temporada 2027');
  const eq = await call('/equipo');
  assert.ok(!JSON.stringify(eq).includes('tema 2027'));
  const o = await call('/admin/overview', { headers: K });
  assert.deepEqual(o.edition.groups ? o.edition.groups.map((g) => g.expected) : before, before);
});
