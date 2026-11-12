// Pruebas de la API de Todos a la Mesa con un almacenamiento simulado
// que imita las escrituras condicionales (ETag) de Netlify Blobs.
// Ejecutar: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const data = new Map();
const etagOf = (v) => '"' + createHash('sha1').update(v).digest('hex') + '"';
const delay = () => new Promise((r) => setTimeout(r, Math.random() * 15));
globalThis.__mesaTestStore = {
  async getWithMetadata(key) { await delay(); const v = data.get(key); return v === undefined ? null : { data: JSON.parse(v), etag: etagOf(v), metadata: {} }; },
  async setJSON(key, value, opts = {}) {
    await delay();
    const cur = data.get(key); // comprobación y escritura atómicas, como en producción
    if (opts.onlyIfNew && cur !== undefined) return { modified: false };
    if (opts.onlyIfMatch && (cur === undefined || etagOf(cur) !== opts.onlyIfMatch)) return { modified: false };
    const v = JSON.stringify(value); data.set(key, v); return { modified: true, etag: etagOf(v) };
  },
};
process.env.MESA_ADMIN_KEY = 'clave-de-prueba';
const { default: handler } = await import('../netlify/functions/mesa.mjs');
const K = { 'x-admin-key': 'clave-de-prueba' };
async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await handler(new Request('http://x/api/mesa' + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) }), { ip: '1.2.3.4' });
  return { code: res.status, ...(await res.json()) };
}
const old = Date.now() - 5000;
const reg = (i, extra = {}) => call('/register', { method: 'POST', body: { name: 'Persona ' + i, phone: '30011100' + String(i).padStart(2, '0'), mesa: 'Líder ' + i, commit: true, startedAt: old, ...extra } });

test('crea la primera sesión (18 de noviembre, Pasión del Cielo) sin mostrar cupo', async () => {
  const r = await call('/session');
  assert.equal(r.state, 'open');
  assert.equal(r.session.id, '2026-11-18');
  assert.equal(r.session.price, 30000);
  assert.ok(!('capacity' in r.session));
  assert.ok(!JSON.stringify(r).includes('regs'));
});

test('admin requiere la contraseña', async () => {
  assert.equal((await call('/admin/overview')).code, 401);
  assert.equal((await call('/admin/overview', { headers: { 'x-admin-key': 'otra' } })).code, 401);
  assert.equal((await call('/admin/overview', { headers: K })).ok, true);
});

let regs;
test('20 inscripciones simultáneas con cupo 12 → 12 confirmadas y 8 en espera', async () => {
  await call('/admin/session', { method: 'POST', headers: K, body: { id: 't1', date: '2030-01-15', time: '19:00', capacity: 12, price: 30000, venue: 'Pasión del Cielo', address: 'X' } });
  regs = await Promise.all(Array.from({ length: 20 }, (_, i) => reg(i)));
  assert.ok(regs.every((r) => r.ok), JSON.stringify(regs.find((r) => !r.ok)));
  assert.equal(regs.filter((r) => r.status === 'confirmado').length, 12);
  assert.equal(regs.filter((r) => r.status === 'espera').length, 8);
  assert.equal((await call('/session')).state, 'waitlist');
});

test('no deja inscribir dos veces el mismo número ni filtra el enlace', async () => {
  const r = await call('/register', { method: 'POST', body: { name: 'Otra', phone: '+57 300 111 0001', mesa: 'x', commit: true, startedAt: old } });
  assert.equal(r.already, true);
  assert.equal(r.token, undefined);
});

test('rechaza sin compromiso, sin Mesa, número inválido y envíos instantáneos', async () => {
  assert.equal((await reg(90, { commit: false })).code, 400);
  assert.equal((await reg(91, { mesa: '' })).code, 400);
  assert.equal((await reg(92, { phone: '123' })).code, 400);
  assert.equal((await reg(93, { startedAt: Date.now() })).code, 400);
});

test('liberar un cupo pasa al primero de la lista de espera', async () => {
  const conf = regs.find((r) => r.status === 'confirmado');
  assert.equal((await call('/r/' + conf.token + '/confirm', { method: 'POST' })).reconfirmed, true);
  assert.equal((await call('/r/' + conf.token + '/cancel', { method: 'POST' })).status, 'cancelado');
  const s = (await call('/admin/session/t1', { headers: K })).session;
  assert.equal(s.counts.confirmado, 12);
  assert.equal(s.counts.espera, 7);
  const promoted = s.regs.filter((r) => r.needsNotice);
  assert.equal(promoted.length, 1);
  const firstWaiting = s.regs.filter((r) => r.status !== 'cancelado').filter((r) => r.promotedAt || r.status === 'espera').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  assert.equal(promoted[0].id, firstWaiting.id);
});

test('liberaciones simultáneas no sobrepasan el cupo', async () => {
  const conf = (await call('/admin/session/t1', { headers: K })).session.regs.filter((r) => r.status === 'confirmado').slice(0, 4);
  await Promise.all(conf.map((r) => call('/r/' + r.token + '/cancel', { method: 'POST' })));
  const s = (await call('/admin/session/t1', { headers: K })).session;
  assert.equal(s.counts.confirmado, 12);
  assert.equal(s.counts.espera, 3);
});

test('ampliar el cupo desde el panel hace entrar a la lista de espera', async () => {
  const r = await call('/admin/session', { method: 'POST', headers: K, body: { id: 't1', date: '2030-01-15', time: '19:00', capacity: 20, price: 30000, venue: 'Pasión del Cielo', address: 'X', makeCurrent: false } });
  assert.equal(r.promoted, 3);
});

test('reinscripción en un toque para la sesión siguiente', async () => {
  await call('/admin/session', { method: 'POST', headers: K, body: { id: 't2', date: '2030-02-12', time: '19:00', capacity: 85, price: 30000, venue: 'Pasión del Cielo', address: 'X' } });
  const p = await call('/p/' + regs[1].personToken);
  assert.equal(p.name, 'Persona 1');
  assert.equal(p.phoneHint, '•••• 0001');
  assert.equal(p.phone, undefined);
  const r = await call('/register', { method: 'POST', body: { personToken: regs[1].personToken, commit: true, startedAt: old } });
  assert.equal(r.status, 'confirmado');
});

test('panel: llegó, pagó, inscribir en la puerta e historial', async () => {
  const s = (await call('/admin/session/t2', { headers: K })).session;
  const r = await call('/admin/reg', { method: 'POST', headers: K, body: { sessionId: 't2', regId: s.regs[0].id, attended: true, paid: true } });
  assert.ok(r.reg.attended && r.reg.paid);
  assert.ok((await call('/admin/add', { method: 'POST', headers: K, body: { sessionId: 't2', name: 'Llegó sin cupo', phone: '3127778888', attended: true, paid: true } })).ok);
  const h = await call('/admin/history', { headers: K });
  assert.equal(h.people.length, 21);
  assert.ok(h.people.every((p) => p.personToken));
});

test('sesión pasada queda cerrada', async () => {
  await call('/admin/session', { method: 'POST', headers: K, body: { id: 't0', date: '2020-01-01', time: '19:00', capacity: 85, price: 30000, venue: 'P', address: 'X' } });
  assert.equal((await call('/session')).state, 'closed');
  assert.equal((await reg(70)).code, 409);
});
