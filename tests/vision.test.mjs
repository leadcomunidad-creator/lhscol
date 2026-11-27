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

test('color de vestuario: uno por persona, repartido por igual, fijo y también en boletas antiguas', async () => {
  const key = 'v:edition/2027';
  const colors = async () => (await call('/admin/overview', { headers: K })).edition.groups.flatMap((g) => g.attendees.filter((a) => a.ticket).map((a) => ({ token: a.ticket.token, color: a.ticket.color, live: g.status !== 'cancelado' })));
  // Boletas emitidas antes del cambio: sin color guardado.
  const raw = JSON.parse(data.get(key).s);
  for (const g of raw.groups) for (const a of g.attendees) if (a.ticket) delete a.ticket.color;
  data.set(key, { s: JSON.stringify(raw) });
  const first = await colors();
  assert.ok(first.length >= 5);
  const n = new Map();
  for (const t of first) if (t.live) n.set(t.color, (n.get(t.color) || 0) + 1);
  assert.equal(n.size, 5);
  assert.ok(Math.max(...n.values()) - Math.min(...n.values()) <= 1);
  assert.deepEqual(await colors(), first);
  const v = await call('/t/' + first[0].token);
  assert.equal(v.color.name.toLowerCase(), first[0].color);
  assert.match(v.color.hex, /^#[0-9a-f]{6}$/);
  // Una inscripción nueva guarda su color y no cambia los anteriores.
  const add = await call('/admin/add', { method: 'POST', headers: K, body: { phone: '3105554433', adults: [{ firstName: 'Eva', lastName: 'Ríos' }], children: [] } });
  assert.ok(add.group.attendees[0].ticket.color);
  const after = await colors();
  for (const t of first) assert.equal(after.find((x) => x.token === t.token).color, t.color);
  assert.ok(JSON.parse(data.get(key).s).groups.every((g) => g.attendees.every((a) => !a.ticket || a.ticket.color)));
  // Al marcar las boletas como enviadas ya no hace falta avisar el color aparte.
  const sent = await call('/admin/flags', { method: 'POST', headers: K, body: { groupId: add.group.id, sentAt: true } });
  assert.ok(sent.group.colorAt);
});

test('voluntarios: clave propia, sin datos privados, y cada entrega una sola vez', async () => {
  const S = (key) => ({ 'x-staff-key': encodeURIComponent(key) });
  const KEY = 'montaña-2027';
  assert.equal((await call('/staff/check', { headers: S(KEY) })).error, 'not_configured');
  assert.equal((await call('/admin/staffkey', { method: 'POST', headers: K, body: { key: 'abc' } })).error, 'key');
  assert.equal((await call('/admin/staffkey', { method: 'POST', headers: K, body: { key: 'clave-de-prueba' } })).error, 'key');
  assert.equal((await call('/admin/staffkey', { method: 'POST', headers: S(KEY), body: { key: KEY } })).code, 401);
  assert.equal((await call('/admin/staffkey', { method: 'POST', headers: K, body: { key: KEY } })).ok, true);
  assert.equal((await call('/staff/check', { headers: S('otra-clave') })).code, 401);
  assert.equal((await call('/staff/check', { headers: S(KEY) })).ok, true);
  // La clave de voluntarios no abre el panel, y su huella no sale por ninguna parte.
  assert.equal((await call('/admin/overview', { headers: { 'x-admin-key': KEY } })).code, 401);
  const o = await call('/admin/overview', { headers: K });
  assert.equal(o.edition.hasStaffKey, true);
  assert.ok(!('staffKeyHash' in o.edition));
  assert.ok(!JSON.stringify(await call('/event')).includes('staffKey'));

  const add = await call('/admin/add', { method: 'POST', headers: K, body: { phone: '3112223344', adults: [{ firstName: 'Marta', lastName: 'Gil' }, { firstName: 'Pedro', lastName: 'Gil' }], children: [{ firstName: 'Tomás', lastName: 'Gil', age: 6 }] } });
  const [marta, pedro, tomas] = add.group.attendees;
  const scan = (code, station) => call('/staff/scan', { method: 'POST', headers: S(KEY), body: { code, station, by: 'Ana' } });
  assert.equal((await scan(marta.ticket.code, 'postre')).error, 'station');
  assert.equal((await scan('VIS27-NADA-NADA', 'comida')).code, 404);
  const first = await scan('https://x/vision/boleta/?t=' + marta.ticket.token, 'comida');
  assert.equal(first.result, 'ok');
  assert.equal(first.personId, marta.id);
  assert.ok(!/3112223344|phone|expected|approvedAmount|proofs|token|75000/.test(JSON.stringify(first)));
  assert.equal((await scan(marta.ticket.code.toLowerCase(), 'comida')).result, 'already');
  assert.equal((await scan(marta.ticket.code, 'granizado')).result, 'ok');
  // Diez escaneos simultáneos de la misma boleta: solo uno entrega.
  const many = await Promise.all(Array.from({ length: 10 }, () => scan(tomas.ticket.code, 'comida')));
  assert.equal(many.filter((r) => r.result === 'ok').length, 1);
  assert.equal(many.filter((r) => r.result === 'already').length, 9);
  assert.equal(many[0].group.attendees.find((a) => a.id === tomas.id).type, 'child');

  const mark = (ids, value = true) => call('/staff/mark', { method: 'POST', headers: S(KEY), body: { groupId: add.group.id, ids, station: 'comida', value, by: 'Ana' } });
  const rest = await mark([marta.id, pedro.id, tomas.id]);
  assert.deepEqual(rest.changed, [pedro.id]);
  const c = (await call('/admin/overview', { headers: K })).edition.counts;
  assert.equal(c.comida, 3);
  assert.equal(c.comidaNinos, 1);
  assert.equal(c.granizado, 1);
  assert.deepEqual((await mark([pedro.id], false)).changed, [pedro.id]);
  assert.equal((await scan(pedro.ticket.code, 'ingreso')).result, 'ok');
  const t = await call('/t/' + pedro.ticket.token);
  assert.deepEqual(t.served, { ingreso: true, comida: false, granizado: false });

  const found = await call('/staff/search', { method: 'POST', headers: S(KEY), body: { q: 'tomas gil' } });
  assert.equal(found.groups.length, 1);
  assert.ok(!/3112223344|phone/.test(JSON.stringify(found)));

  // Grupo anulado: no entrega nada.
  await call('/admin/group', { method: 'POST', headers: K, body: { groupId: add.group.id, action: 'cancel' } });
  assert.equal((await scan(pedro.ticket.code, 'granizado')).result, 'blocked');
  assert.equal((await mark([pedro.id])).error, 'not_approved');

  await call('/admin/staffkey', { method: 'POST', headers: K, body: { key: '' } });
  assert.equal((await call('/staff/check', { headers: S(KEY) })).error, 'not_configured');
});

test('seguimiento de quien no ha subido comprobante: privado y sin cambiar el estado', async () => {
  await call('/admin/edition', { method: 'POST', headers: K, body: { date: '2026-12-19', time: '18:00', capacity: 1000, closeAt: '2026-12-15T23:59', priceAdult: 75000, priceChild: 40000 } });
  const r = await call('/register', { method: 'POST', body: { mesa: 'Juan y Lili', phone: '3123334455', consent: true, startedAt: old, adults: [{ firstName: 'Sara', lastName: 'Ruiz' }], children: [] } });
  assert.equal(r.ok, true, r.message);
  const find = async () => (await call('/admin/overview', { headers: K })).edition.groups.find((g) => g.token === r.token);
  const g = await find();
  const mark = (status, headers = K) => call('/admin/followup', { method: 'POST', headers, body: { groupId: g.id, status, by: 'Ana' } });
  assert.equal((await mark('interesado', {})).code, 401);
  assert.equal((await mark('otra')).error, 'status');
  assert.equal((await mark('pagado')).ok, true);
  const after = await find();
  assert.equal(after.followUp.status, 'pagado');
  assert.equal(after.followUp.by, 'Ana');
  assert.equal(after.eff, 'reservado');
  assert.ok(!JSON.stringify(await call('/g/' + r.token)).includes('followUp'));
  await mark('');
  assert.ok(!('followUp' in (await find())));
});

test('corregir nombres conserva la boleta; eliminar solo sirve para lo que nunca pagó', async () => {
  const act = (groupId, action, extra = {}) => call('/admin/group', { method: 'POST', headers: K, body: { groupId, action, by: 'Ana', ...extra } });
  const groups = async () => (await call('/admin/overview', { headers: K })).edition.groups;
  const add = await call('/admin/add', { method: 'POST', headers: K, body: { phone: '3134445566', adults: [{ firstName: 'Rita', lastName: 'Sol' }, { firstName: 'Rita', lastName: 'Sol' }], children: [] } });
  const [a, b] = add.group.attendees;
  assert.equal((await act(add.group.id, 'rename', { names: [{ id: b.id, firstName: 'x', lastName: '' }] })).error, 'name');
  const r = await act(add.group.id, 'rename', { names: [{ id: b.id, firstName: 'juan', lastName: 'garcía' }] });
  assert.equal(r.group.attendees[1].firstName, 'Juan');
  assert.equal(r.group.responsible, 'Rita Sol');
  assert.equal(r.group.attendees[1].ticket.token, b.ticket.token);
  assert.equal((await call('/t/' + b.ticket.token)).name, 'Juan García');
  assert.equal((await act(add.group.id, 'rename', { names: [{ id: a.id, firstName: 'Rosa', lastName: 'Sol' }] })).group.responsible, 'Rosa Sol');
  // Pagada: no se elimina ni anulándola.
  assert.equal((await act(add.group.id, 'delete')).error, 'state');
  await act(add.group.id, 'cancel');
  assert.equal((await act(add.group.id, 'delete')).error, 'state');

  const reg = await call('/register', { method: 'POST', body: { mesa: 'Juan y Lili', phone: '3145556677', consent: true, startedAt: old, adults: [{ firstName: 'Prueba', lastName: 'Vieja' }], children: [] } });
  const g = (await groups()).find((x) => x.token === reg.token);
  assert.equal((await act(g.id, 'delete')).error, 'state');
  await act(g.id, 'cancel');
  assert.equal((await act(g.id, 'delete')).ok, true);
  assert.ok(!(await groups()).some((x) => x.id === g.id));
  assert.equal((await call('/g/' + reg.token)).status, 'cancelado');
  assert.ok(JSON.parse(data.get('v:edition/2027').s).groups.some((x) => x.id === g.id && x.deletedAt));
});

test('la Mesa se pide siempre, usa la lista base de Todos a la Mesa y el panel puede completarla', async () => {
  const saved = data.get('m:config/mesas');
  data.delete('m:config/mesas');
  const ev = await call('/event');
  assert.ok(ev.mesas.includes('Camilo y Camila'));
  const body = { phone: '3156667788', consent: true, startedAt: old, adults: [{ firstName: 'Mesa', lastName: 'Prueba' }], children: [] };
  assert.equal((await call('/register', { method: 'POST', body })).error, 'mesa');
  assert.equal((await call('/register', { method: 'POST', body: { ...body, mesa: 'Inventada' } })).error, 'mesa');
  const r = await call('/register', { method: 'POST', body: { ...body, mesa: ev.noMesa } });
  assert.equal(r.ok, true, r.message);
  const g = (await call('/admin/overview', { headers: K })).edition.groups.find((x) => x.token === r.token);
  const set = (mesa) => call('/admin/group', { method: 'POST', headers: K, body: { groupId: g.id, action: 'mesa', mesa } });
  assert.equal((await set('Inventada')).error, 'mesa');
  const done = await set('Camilo y Camila');
  assert.equal(done.group.mesa, 'Camilo y Camila');
  assert.equal(done.group.status, 'reservado');
  data.set('m:config/mesas', saved);
});

test('caja: privada, valida valores, edita, quita sin destruir y guarda arqueos', async () => {
  const send = (body, headers = K) => call('/admin/caja', { method: 'POST', headers, body: { by: 'Ana', ...body } });
  assert.equal((await send({ op: 'save', type: 'gasto', concept: 'Bowls', budget: 100 }, {})).code, 401);
  assert.equal((await send({ op: 'save', type: 'otro', concept: 'Bowls', budget: 100 })).error, 'type');
  assert.equal((await send({ op: 'save', type: 'gasto', concept: 'Bowls', budget: '1.5' })).error, 'amount');
  assert.equal((await send({ op: 'save', type: 'gasto', concept: 'Bowls' })).error, 'amount');
  const a = await send({ op: 'save', type: 'gasto', concept: 'Bowls', budget: '3000000', amount: '' });
  const id = a.caja.items[0].id;
  const b = await send({ op: 'save', id, type: 'gasto', concept: 'Bowls', budget: 3000000, amount: 1000000 });
  assert.equal(b.caja.items.length, 1);
  assert.equal(b.caja.items[0].amount, 1000000);
  assert.ok((await send({ op: 'delete', id })).caja.items[0].deletedAt);
  const q = await send({ op: 'arqueo', real: 500000, expected: 525000 });
  assert.equal(q.caja.arqueos[0].expected, 525000);
  assert.equal((await call('/admin/overview', { headers: K })).edition.caja.arqueos.length, 1);
  for (const path of ['/event', '/equipo']) assert.ok(!/caja|arqueo|Bowls/.test(JSON.stringify(await call(path))), path);
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
  const before = e.groups.filter((g) => !g.deletedAt).map((g) => g.expected);
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
