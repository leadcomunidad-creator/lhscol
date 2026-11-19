// VISIÓN · API de inscripciones con pago
// Netlify Function (v2) + Netlify Blobs, con la misma base de Todos a la Mesa.
// El nombre de la temporada es secreto: nunca va en este archivo ni en ninguna respuesta.
//
// Público:
//   GET  /api/vision/event                 Edición actual (sin cupo ni cifras)
//   GET  /api/vision/qr                    Imagen del QR de pago (si se subió en el panel)
//   POST /api/vision/register              Inscribir un grupo (familia): reserva el cupo mientras paga
//   GET  /api/vision/g/:token              Estado del grupo (enlace personal del responsable)
//   POST /api/vision/g/:token/proof        Subir el comprobante (cuerpo binario JPG, PNG o PDF)
//   GET  /api/vision/t/:token              Boleta de una persona
//
// Administración (cabecera x-admin-key = VISION_ADMIN_KEY; si no existe, MESA_ADMIN_KEY):
//   GET  /api/vision/admin/overview
//   GET  /api/vision/admin/proof/:groupId/:n   Ver un comprobante
//   POST /api/vision/admin/edition             Guardar la configuración de la edición
//   POST /api/vision/admin/qr                  Subir el QR de pago (imagen)
//   POST /api/vision/admin/group               Aprobar, rechazar, marcar incompleto, anular o reabrir
//   POST /api/vision/admin/flags               Marcar mensajes enviados (boletas, recordatorio, es hoy)
//   POST /api/vision/admin/checkin             Llegada por código de boleta o por persona
//   POST /api/vision/admin/add                 Inscribir en la puerta o a mano (queda aprobado)

import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const config = { path: '/api/vision/*' };

const TZ_OFFSET = '-05:00'; // America/Bogota
const MAX_RETRIES = 16;
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const MAX_ACTIVE_PER_PHONE = 3;

// Primera edición: se crea sola la primera vez. Todo se edita luego desde el panel.
const DEFAULT_EDITION = {
  id: '2027',
  name: 'Visión',
  year: '2027',
  date: '2026-12-19',
  time: '18:00',
  endTime: '21:00',
  venue: 'Auditorio Fundación Batuta',
  city: 'Manizales, Caldas',
  address: '',
  mapsUrl: '',
  tagline: 'Celebramos lo vivido. Descubrimos lo que viene.',
  includes: 'Incluye comida y dos bebidas por persona.',
  highlights: 'Music · Mensaje · Tema 2027',
  theme: 'claro', // 'claro' (blanco y azul) o 'negro' (negro y dorado)
  prices: { adult: 75000, child: 35000 },
  childAgeMin: 2,
  childAgeMax: 11,
  closeAt: '2026-12-05T23:59:59-05:00',
  maxGroup: 10,
  status: 'open',
  contactWhatsapp: '573043229348',
  // privado
  capacity: 300,
  holdMinutes: 60,
  correctionHours: 24,
  paymentUrl: 'https://checkout.wompi.co/l/VPOS_nEkNT7',
};
const PRIVATE_FIELDS = ['capacity', 'holdMinutes', 'correctionHours', 'paymentUrl', 'groups', 'hasQr'];

// ───────── utilidades ─────────
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
const fail = (status, error, message) => json({ ok: false, error, message }, status);
const token = (bytes = 16) => randomBytes(bytes).toString('base64url');
const nowIso = () => new Date().toISOString();
const clean = (v, max = 120) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const plain = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'da', 'di', 'van', 'von']);
function properName(raw) {
  return clean(raw, 60).split(' ').map((w, i) => {
    if (!w) return w;
    const lower = w.toLocaleLowerCase('es');
    const upper = w.toLocaleUpperCase('es');
    if (w !== lower && w !== upper) return w;
    if (i > 0 && PARTICLES.has(lower)) return lower;
    return lower.replace(/(^|[-'’])(\p{L})/gu, (m, sep, ch) => sep + ch.toLocaleUpperCase('es'));
  }).join(' ');
}

function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('3')) d = '57' + d;
  if (d.length === 12 && d.startsWith('573')) return d;
  if (!String(raw ?? '').trim().startsWith('+') && !String(raw ?? '').trim().startsWith('00')) return null;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

// Código de boleta sin caracteres ambiguos: VIS27-XXXX-XXXX
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function ticketCode(e) {
  const pick = () => Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('');
  return `VIS${String(e.year).slice(-2)}-${pick()}-${pick()}`;
}

const startDate = (e) => new Date(`${e.date}T${e.time}:00${TZ_OFFSET}`);
const endDate = (e) => new Date(`${e.date}T${e.endTime || e.time}:00${TZ_OFFSET}`);
const closeDate = (e) => (e.closeAt ? new Date(e.closeAt) : startDate(e));

// ───────── reglas del grupo ─────────
// Estados guardados: reservado (sin comprobante), revision, aprobado, rechazado, incompleto, cancelado.
// "vencido" se calcula: reservado/rechazado/incompleto cuyo plazo (holdUntil) ya pasó.
function effStatus(g, now = Date.now()) {
  if (['reservado', 'rechazado', 'incompleto'].includes(g.status) && g.holdUntil && now > Date.parse(g.holdUntil)) return 'vencido';
  return g.status;
}
const HOLDS = new Set(['reservado', 'revision', 'aprobado', 'rechazado', 'incompleto']);
const seats = (g) => g.attendees.length;

function counts(e, now = Date.now()) {
  const c = { grupos: 0, personas: 0, adultos: 0, ninos: 0, reservado: 0, revision: 0, aprobado: 0, rechazado: 0, incompleto: 0, vencido: 0, cancelado: 0,
    ocupados: 0, confirmados: 0, llegaron: 0, recaudo: 0, esperado: 0, boletasSinEnviar: 0 };
  for (const g of e.groups) {
    const st = effStatus(g, now);
    c[st] = (c[st] || 0) + seats(g);
    if (HOLDS.has(st)) c.ocupados += seats(g);
    if (st === 'aprobado') {
      c.grupos++;
      c.confirmados += seats(g);
      c.recaudo += g.approvedAmount || 0;
      for (const a of g.attendees) { if (a.type === 'child') c.ninos++; else c.adultos++; if (a.attended) c.llegaron++; }
      if (!g.sentAt) c.boletasSinEnviar++;
    }
    if (st === 'revision') c.esperado += g.expected;
  }
  c.personas = c.confirmados;
  return c;
}

function publicState(e, now = Date.now()) {
  if (!e) return 'none';
  if (e.status === 'closed' || now > closeDate(e).getTime()) return 'closed';
  if (now > endDate(e).getTime()) return 'closed';
  return counts(e, now).ocupados < e.capacity ? 'open' : 'full';
}

const OLD_INCLUDES = 'Incluye alimentación y un concierto de nuestro grupo musical.';
function withDefaults(e) {
  if (!e) return e;
  if (e.includes === OLD_INCLUDES) e.includes = DEFAULT_EDITION.includes;
  if (e.highlights === undefined) e.highlights = DEFAULT_EDITION.highlights;
  if (!e.theme) e.theme = DEFAULT_EDITION.theme;
  return e;
}

function publicEdition(e) {
  if (!e) return null;
  withDefaults(e);
  const out = {};
  for (const [k, v] of Object.entries(e)) if (!PRIVATE_FIELDS.includes(k) && k !== 'createdAt' && k !== 'updatedAt') out[k] = v;
  out.startsAt = startDate(e).toISOString();
  out.endsAt = endDate(e).toISOString();
  return out;
}

function priceOf(e, type) { return type === 'child' ? Number(e.prices.child) : Number(e.prices.adult); }
const expectedOf = (e, attendees) => attendees.reduce((s, a) => s + priceOf(e, a.type), 0);

// ───────── almacenamiento ─────────
const store = () => globalThis.__visionTestStore || getStore({ name: 'vision-lhscol', consistency: 'strong' });
const mesaStore = () => globalThis.__mesaTestStore || getStore({ name: 'todos-a-la-mesa', consistency: 'strong' });
const editionKey = (id) => `edition/${id}`;
const tokenKey = (t) => `token/${t}`;
const proofKey = (eid, gid, n) => `proof/${eid}/${gid}/${n}`;
const qrKey = (eid) => `qr/${eid}`;

async function read(key) {
  const r = await store().getWithMetadata(key, { type: 'json' });
  return r ? { data: r.data, etag: r.etag } : { data: null, etag: null };
}

async function mutate(key, fn) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const { data, etag } = await read(key);
    const draft = data ? structuredClone(data) : null;
    const out = await fn(draft);
    if (out.skipWrite) return out.result;
    const opts = etag ? { onlyIfMatch: etag } : data ? {} : { onlyIfNew: true };
    const w = await store().setJSON(key, out.value, opts);
    if (w.modified) return out.result;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * Math.min(i + 1, 6)));
  }
  throw new HttpError(503, 'busy', 'Hay muchas inscripciones al mismo tiempo. Intenta de nuevo en un momento.');
}

async function ensureIndex() {
  let { data: idx } = await read('index');
  if (idx) return idx;
  await store().setJSON(editionKey(DEFAULT_EDITION.id), { ...DEFAULT_EDITION, groups: [], createdAt: nowIso() }, { onlyIfNew: true });
  await store().setJSON('index', { currentId: DEFAULT_EDITION.id, editions: [DEFAULT_EDITION.id] }, { onlyIfNew: true });
  return (await read('index')).data;
}
async function currentEdition() {
  const idx = await ensureIndex();
  return idx?.currentId ? (await read(editionKey(idx.currentId))).data : null;
}

// Lista de Mesas: la misma del formulario de Todos a la Mesa (se edita en su panel).
const NO_MESA = 'Aún no asiste a una Mesa';
async function getMesas() {
  try {
    const r = await mesaStore().getWithMetadata('config/mesas', { type: 'json' });
    return Array.isArray(r?.data?.mesas) ? r.data.mesas : [];
  } catch { return []; }
}

// ───────── manejadores públicos ─────────
async function getEvent() {
  const [e, mesas] = await Promise.all([currentEdition(), getMesas()]);
  return json({ ok: true, state: publicState(e), edition: publicEdition(e), mesas, noMesa: NO_MESA });
}

function parseAttendees(e, body) {
  const adults = Array.isArray(body.adults) ? body.adults : [];
  const children = Array.isArray(body.children) ? body.children : [];
  const list = [];
  for (const a of adults) list.push({ type: 'adult', firstName: properName(a?.firstName), lastName: properName(a?.lastName) });
  for (const c of children) {
    const age = parseInt(c?.age, 10);
    if (!(age >= e.childAgeMin && age <= e.childAgeMax)) throw new HttpError(400, 'age', `La edad de cada niño debe estar entre ${e.childAgeMin} y ${e.childAgeMax} años. Desde los ${e.childAgeMax + 1} años se inscribe como adulto.`);
    list.push({ type: 'child', age, firstName: properName(c?.firstName), lastName: properName(c?.lastName) });
  }
  if (!list.some((a) => a.type === 'adult')) throw new HttpError(400, 'adult', 'Debe haber al menos un adulto responsable.');
  if (list.length > e.maxGroup) throw new HttpError(400, 'max', `Máximo ${e.maxGroup} personas por inscripción.`);
  for (const a of list) if (a.firstName.length < 2 || a.lastName.length < 2) throw new HttpError(400, 'name', 'Escribe nombre y apellido de cada persona.');
  return list.map((a) => ({ id: token(6), ...a, attended: false }));
}

async function register(req, context) {
  const body = await req.json().catch(() => ({}));
  if (body.website) return json({ ok: true, token: token(), expected: 0 }); // trampa antispam
  if (body.startedAt && Date.now() - Number(body.startedAt) < 3000) throw new HttpError(400, 'too_fast', 'Revisa tus datos e intenta de nuevo.');
  if (body.consent !== true) throw new HttpError(400, 'consent', 'Marca la autorización de datos para continuar.');
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'phone', 'Escribe un número de WhatsApp válido (10 dígitos, o con + y el indicativo del país).');

  const idx = await ensureIndex();
  const eid = idx?.currentId;
  if (!eid) throw new HttpError(409, 'none', 'No hay inscripciones abiertas en este momento.');
  const mesas = await getMesas();
  const mesaIn = clean(body.mesa, 80);
  const mesa = [NO_MESA, ...mesas].find((m) => plain(m) === plain(mesaIn)) || '';

  const result = await mutate(editionKey(eid), (e) => {
    if (!e) throw new HttpError(409, 'none', 'No hay inscripciones abiertas en este momento.');
    const state = publicState(e);
    if (state === 'closed') throw new HttpError(409, 'closed', 'Las inscripciones ya cerraron.');
    const attendees = parseAttendees(e, body);
    if (attendees.some((a) => a.type === 'child') && body.guardian !== true) throw new HttpError(400, 'guardian', 'Marca la autorización del acudiente de los niños.');
    const now = Date.now();
    const active = e.groups.filter((g) => g.phone === phone && HOLDS.has(effStatus(g, now)));
    if (active.length >= MAX_ACTIVE_PER_PHONE) throw new HttpError(409, 'too_many', 'Este WhatsApp ya tiene varias inscripciones activas. Escríbenos y te ayudamos.');
    if (counts(e, now).ocupados + attendees.length > e.capacity) throw new HttpError(409, 'full', 'No hay disponibilidad para ese número de personas. Escríbenos por WhatsApp y te ayudamos.');
    const keys = new Set(attendees.map((a) => plain(a.firstName + ' ' + a.lastName)));
    const dup = active.some((g) => g.attendees.some((a) => keys.has(plain(a.firstName + ' ' + a.lastName))));
    const g = {
      id: token(6),
      token: token(16),
      responsible: attendees[0].firstName + ' ' + attendees[0].lastName,
      phone,
      mesa,
      attendees,
      expected: expectedOf(e, attendees),
      status: 'reservado',
      holdUntil: new Date(now + e.holdMinutes * 60000).toISOString(),
      proofs: [],
      consent: { at: nowIso(), guardian: body.guardian === true },
      ...(dup ? { possibleDuplicate: true } : {}),
      createdAt: nowIso(),
      ipHash: createHash('sha256').update(String(context?.ip || '')).digest('hex').slice(0, 16),
      source: 'formulario',
    };
    e.groups.push(g);
    return { value: e, result: { g, e } };
  });
  const { g, e } = result;
  await store().setJSON(tokenKey(g.token), { type: 'group', editionId: eid, groupId: g.id });
  return json({ ok: true, token: g.token, expected: g.expected, holdUntil: g.holdUntil, paymentUrl: e.paymentUrl || '', hasQr: !!e.hasQr, edition: publicEdition(e) });
}

async function loadRef(t, type) {
  const ref = (await read(tokenKey(clean(t, 40)))).data;
  if (!ref || ref.type !== type) throw new HttpError(404, 'not_found', 'No encontramos este enlace. Revísalo o escríbenos por WhatsApp.');
  return ref;
}

function groupPublic(e, g) {
  const st = effStatus(g);
  return {
    ok: true,
    status: st,
    responsible: g.responsible,
    phoneHint: '•••• ' + g.phone.slice(-4),
    expected: g.expected,
    holdUntil: g.holdUntil,
    hasProof: g.proofs.length > 0,
    reason: ['rechazado', 'incompleto'].includes(g.status) ? g.review?.reason || '' : '',
    attendees: g.attendees.map((a) => ({ name: a.firstName + ' ' + a.lastName, type: a.type, age: a.age, ...(st === 'aprobado' && a.ticket ? { ticket: a.ticket.token, code: a.ticket.code } : {}) })),
    paymentUrl: st === 'aprobado' ? '' : e.paymentUrl || '',
    hasQr: !!e.hasQr,
    edition: publicEdition(e),
  };
}

async function groupView(t) {
  const ref = await loadRef(t, 'group');
  const e = (await read(editionKey(ref.editionId))).data;
  const g = e?.groups.find((x) => x.id === ref.groupId);
  if (!g) throw new HttpError(404, 'not_found', 'No encontramos esta inscripción.');
  return json(groupPublic(e, g));
}

function sniff(buf) {
  const b = new Uint8Array(buf.slice(0, 8));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return null;
}

async function uploadProof(req, t) {
  const ref = await loadRef(t, 'group');
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_PROOF_BYTES) throw new HttpError(413, 'too_big', 'El archivo supera los 5 MB. Prueba con una captura más liviana.');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, 'empty', 'Elige la foto o el PDF del comprobante.');
  if (buf.byteLength > MAX_PROOF_BYTES) throw new HttpError(413, 'too_big', 'El archivo supera los 5 MB. Prueba con una captura más liviana.');
  const type = sniff(buf);
  if (!type) throw new HttpError(400, 'type', 'Solo se aceptan archivos JPG, PNG o PDF.');
  const sha = createHash('sha256').update(Buffer.from(buf)).digest('hex');

  const res = await mutate(editionKey(ref.editionId), (e) => {
    const g = e?.groups.find((x) => x.id === ref.groupId);
    if (!g) throw new HttpError(404, 'not_found', 'No encontramos esta inscripción.');
    const st = effStatus(g);
    if (st === 'aprobado') throw new HttpError(409, 'approved', 'Tu pago ya fue aprobado. Tus boletas están listas.');
    if (st === 'cancelado') throw new HttpError(409, 'cancelled', 'Esta inscripción fue anulada. Escríbenos por WhatsApp.');
    if (g.proofs.length >= 5) throw new HttpError(409, 'too_many', 'Ya recibimos varios comprobantes. Escríbenos por WhatsApp.');
    if (st === 'vencido') {
      // Reserva vencida: se vuelve a reservar si todavía hay cupo; si no, queda para gestión manual.
      const free = e.capacity - counts(e).ocupados;
      if (free < seats(g)) g.needsAttention = true;
    }
    const n = g.proofs.length + 1;
    const dupProof = e.groups.some((o) => o.id !== g.id && o.proofs.some((p) => p.sha === sha));
    g.proofs.push({ n, type, size: buf.byteLength, sha, at: nowIso(), ...(dupProof ? { duplicate: true } : {}) });
    g.status = 'revision';
    g.holdUntil = null;
    return { value: e, result: { e, g, n } };
  });
  await store().set(proofKey(ref.editionId, ref.groupId, res.n), buf, { metadata: { type, sha } });
  return json(groupPublic(res.e, res.g));
}

async function ticketView(t) {
  const ref = await loadRef(t, 'ticket');
  const e = (await read(editionKey(ref.editionId))).data;
  const g = e?.groups.find((x) => x.id === ref.groupId);
  const a = g?.attendees.find((x) => x.id === ref.attendeeId);
  if (!a || !a.ticket || a.ticket.token !== clean(t, 40)) throw new HttpError(404, 'not_found', 'Esta boleta no existe o fue anulada.');
  const valid = effStatus(g) === 'aprobado';
  return json({ ok: true, valid, name: a.firstName + ' ' + a.lastName, type: a.type, age: a.age, code: a.ticket.code, attended: !!a.attended, group: g.responsible, edition: publicEdition(e) });
}

async function getQr() {
  const idx = await ensureIndex();
  const r = await store().getWithMetadata(qrKey(idx.currentId), { type: 'arrayBuffer' });
  if (!r) return fail(404, 'not_found', 'Sin QR.');
  return new Response(r.data, { headers: { 'content-type': r.metadata?.type || 'image/png', 'cache-control': 'public, max-age=300' } });
}

// ───────── administración ─────────
function checkAdmin(req) {
  const expected = process.env.VISION_ADMIN_KEY || process.env.MESA_ADMIN_KEY || '';
  if (expected.length < 8) throw new HttpError(503, 'not_configured', 'Falta configurar la contraseña del panel (VISION_ADMIN_KEY) en Netlify.');
  const given = req.headers.get('x-admin-key') || '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, 'unauthorized', 'Contraseña incorrecta.');
}

function adminEdition(e) {
  const now = Date.now();
  const groups = e.groups.map((g) => ({ ...g, eff: effStatus(g, now) }));
  withDefaults(e);
  return { ...e, groups, state: publicState(e, now), counts: counts(e, now), startsAt: startDate(e).toISOString() };
}

async function adminOverview() {
  const idx = await ensureIndex();
  const e = (await read(editionKey(idx.currentId))).data;
  const mesas = await getMesas();
  return json({ ok: true, currentId: idx.currentId, editions: idx.editions, edition: e ? adminEdition(e) : null, mesas, noMesa: NO_MESA });
}

async function adminProof(gid, n) {
  const idx = await ensureIndex();
  const r = await store().getWithMetadata(proofKey(idx.currentId, clean(gid, 20), parseInt(n, 10) || 1), { type: 'arrayBuffer' });
  if (!r) throw new HttpError(404, 'not_found', 'Comprobante no encontrado.');
  return new Response(r.data, { headers: { 'content-type': r.metadata?.type || 'application/octet-stream', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } });
}

const int = (v, d, min, max) => Math.max(min, Math.min(max, Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d));
async function adminSaveEdition(req) {
  const b = await req.json().catch(() => ({}));
  const idx = await ensureIndex();
  const id = idx.currentId;
  const date = clean(b.date, 10), time = clean(b.time, 5), endTime = clean(b.endTime, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date', 'Fecha inválida.');
  if (!/^\d{2}:\d{2}$/.test(time) || (endTime && !/^\d{2}:\d{2}$/.test(endTime))) throw new HttpError(400, 'time', 'Hora inválida.');
  if (b.paymentUrl && !/^https:\/\//.test(String(b.paymentUrl))) throw new HttpError(400, 'url', 'El enlace de pago debe empezar por https://');
  const fields = {
    date, time, endTime: endTime || time,
    venue: clean(b.venue, 80) || DEFAULT_EDITION.venue,
    city: clean(b.city, 80),
    address: clean(b.address, 160),
    mapsUrl: /^https:\/\//.test(String(b.mapsUrl || '')) ? String(b.mapsUrl).slice(0, 500) : '',
    tagline: clean(b.tagline, 120),
    includes: clean(b.includes, 200),
    highlights: clean(b.highlights, 120),
    theme: b.theme === 'negro' ? 'negro' : 'claro',
    prices: { adult: int(b.priceAdult, 75000, 0, 2000000), child: int(b.priceChild, 35000, 0, 2000000) },
    closeAt: b.closeAt ? new Date(`${clean(b.closeAt, 16)}:59${TZ_OFFSET}`).toISOString() : null,
    maxGroup: int(b.maxGroup, 10, 1, 20),
    status: b.status === 'closed' ? 'closed' : 'open',
    capacity: int(b.capacity, 300, 1, 5000),
    holdMinutes: int(b.holdMinutes, 60, 10, 1440),
    correctionHours: int(b.correctionHours, 24, 1, 240),
    paymentUrl: String(b.paymentUrl || '').slice(0, 500),
  };
  await mutate(editionKey(id), (e) => {
    if (!e) e = { ...DEFAULT_EDITION, id, groups: [], createdAt: nowIso() };
    Object.assign(e, fields, { updatedAt: nowIso() });
    return { value: e };
  });
  return json({ ok: true });
}

async function adminSaveQr(req) {
  const buf = await req.arrayBuffer();
  const type = sniff(buf);
  if (!type || type === 'application/pdf') throw new HttpError(400, 'type', 'Sube el QR como imagen JPG o PNG.');
  if (buf.byteLength > 3 * 1024 * 1024) throw new HttpError(413, 'too_big', 'La imagen del QR supera 3 MB.');
  const idx = await ensureIndex();
  await store().set(qrKey(idx.currentId), buf, { metadata: { type } });
  await mutate(editionKey(idx.currentId), (e) => (e.hasQr = true, { value: e }));
  return json({ ok: true });
}

function issueTickets(e, g) {
  const used = new Set(e.groups.flatMap((o) => o.attendees.map((a) => a.ticket?.code).filter(Boolean)));
  const issued = [];
  for (const a of g.attendees) {
    if (a.ticket) continue;
    let code; do { code = ticketCode(e); } while (used.has(code));
    used.add(code);
    a.ticket = { code, token: token(16), issuedAt: nowIso() };
    issued.push(a);
  }
  return issued;
}

async function adminGroup(req) {
  const b = await req.json().catch(() => ({}));
  const idx = await ensureIndex();
  const gid = clean(b.groupId, 20);
  const action = clean(b.action, 20);
  const by = clean(b.by, 40) || 'equipo';
  const res = await mutate(editionKey(idx.currentId), (e) => {
    const g = e?.groups.find((x) => x.id === gid);
    if (!g) throw new HttpError(404, 'not_found', 'Inscripción no encontrada.');
    const st = effStatus(g);
    let issued = [];
    if (action === 'approve') {
      if (st === 'aprobado') return { skipWrite: true, result: { g, issued } };
      if (st === 'cancelado') throw new HttpError(409, 'cancelled', 'Esta inscripción está anulada. Reábrela primero.');
      const amount = b.amount === undefined || b.amount === '' ? g.expected : int(b.amount, g.expected, 0, 10000000);
      if (amount < g.expected && b.allowLess !== true) throw new HttpError(409, 'amount', `El monto recibido (${amount.toLocaleString('es-CO')}) es menor que el esperado (${g.expected.toLocaleString('es-CO')}). Márcalo como incompleto o confirma que lo apruebas así.`);
      if (st === 'vencido' || g.needsAttention) {
        const others = counts({ ...e, groups: e.groups.filter((o) => o.id !== g.id) }).ocupados;
        if (others + seats(g) > e.capacity && b.overCapacity !== true) throw new HttpError(409, 'capacity', 'No queda cupo para este grupo. Si igual lo quieres aprobar, confirma que se pasa del aforo.');
      }
      g.status = 'aprobado'; g.approvedAmount = amount; g.holdUntil = null; g.needsAttention = false;
      g.review = { by, at: nowIso(), action: 'approve' };
      issued = issueTickets(e, g);
    } else if (action === 'reject' || action === 'incomplete') {
      if (st === 'aprobado') throw new HttpError(409, 'approved', 'Este pago ya fue aprobado.');
      const reason = clean(b.reason, 200);
      if (!reason) throw new HttpError(400, 'reason', 'Escribe el motivo para que la persona sepa qué corregir.');
      g.status = action === 'reject' ? 'rechazado' : 'incompleto';
      g.holdUntil = new Date(Date.now() + e.correctionHours * 3600000).toISOString();
      g.review = { by, at: nowIso(), action, reason };
      g.sentAt = null;
    } else if (action === 'cancel') {
      g.status = 'cancelado'; g.holdUntil = null; g.review = { by, at: nowIso(), action, reason: clean(b.reason, 200) };
    } else if (action === 'reopen') {
      if (st !== 'cancelado' && st !== 'vencido') throw new HttpError(409, 'state', 'Solo se reabre una inscripción anulada o vencida.');
      g.status = g.proofs.length ? 'revision' : 'reservado';
      g.holdUntil = g.proofs.length ? null : new Date(Date.now() + e.holdMinutes * 60000).toISOString();
      g.review = { by, at: nowIso(), action };
    } else if (action === 'note') {
      g.note = clean(b.note, 300);
    } else {
      throw new HttpError(400, 'action', 'Acción no válida.');
    }
    (g.log ||= []).push({ action, by, at: nowIso(), ...(b.reason ? { reason: clean(b.reason, 200) } : {}) });
    return { value: e, result: { g, issued } };
  });
  await Promise.all(res.issued.map((a) => store().setJSON(tokenKey(a.ticket.token), { type: 'ticket', editionId: idx.currentId, groupId: res.g.id, attendeeId: a.id })));
  return json({ ok: true, group: { ...res.g, eff: effStatus(res.g) } });
}

async function adminFlags(req) {
  const b = await req.json().catch(() => ({}));
  const idx = await ensureIndex();
  const gid = clean(b.groupId, 20);
  const g = await mutate(editionKey(idx.currentId), (e) => {
    const g = e?.groups.find((x) => x.id === gid);
    if (!g) throw new HttpError(404, 'not_found', 'Inscripción no encontrada.');
    for (const k of ['sentAt', 'remindedAt', 'hoyAt', 'rejectSentAt']) if (k in b) g[k] = b[k] ? nowIso() : null;
    return { value: e, result: g };
  });
  return json({ ok: true, group: { ...g, eff: effStatus(g) } });
}

async function adminCheckin(req) {
  const b = await req.json().catch(() => ({}));
  const idx = await ensureIndex();
  let code = clean(b.code, 200).toUpperCase();
  // Si se escaneó el QR de la boleta, viene la URL completa: se toma el token.
  const tm = String(b.code || '').match(/[?&]t=([A-Za-z0-9_-]{10,40})/);
  const tok = tm ? tm[1] : clean(b.token, 40);
  const value = b.value !== false;
  const res = await mutate(editionKey(idx.currentId), (e) => {
    let g, a;
    for (const x of e.groups) {
      const y = x.attendees.find((p) => (b.attendeeId && p.id === b.attendeeId && x.id === b.groupId) || (tok && p.ticket?.token === tok) || (!tok && code && p.ticket?.code === code));
      if (y) { g = x; a = y; break; }
    }
    if (!a) throw new HttpError(404, 'not_found', 'No encontramos esa boleta.');
    if (effStatus(g) !== 'aprobado') throw new HttpError(409, 'not_approved', `${a.firstName} ${a.lastName} no tiene el pago aprobado (estado: ${effStatus(g)}).`);
    const already = !!a.attended;
    if (value && already) return { skipWrite: true, result: { g, a, already } };
    a.attended = value; a.attendedAt = value ? nowIso() : null;
    return { value: e, result: { g, a, already } };
  });
  return json({ ok: true, already: res.already, attendee: { id: res.a.id, name: res.a.firstName + ' ' + res.a.lastName, type: res.a.type, age: res.a.age, code: res.a.ticket?.code, attended: res.a.attended, attendedAt: res.a.attendedAt }, group: { id: res.g.id, responsible: res.g.responsible, size: res.g.attendees.length, arrived: res.g.attendees.filter((x) => x.attended).length } });
}

async function adminAdd(req) {
  const b = await req.json().catch(() => ({}));
  const idx = await ensureIndex();
  const phone = normalizePhone(b.phone);
  if (!phone) throw new HttpError(400, 'phone', 'WhatsApp inválido.');
  const mesas = await getMesas();
  const mesa = [NO_MESA, ...mesas].find((m) => plain(m) === plain(b.mesa)) || '';
  const res = await mutate(editionKey(idx.currentId), (e) => {
    const attendees = parseAttendees({ ...e, maxGroup: 20 }, b);
    const expected = expectedOf(e, attendees);
    const g = {
      id: token(6), token: token(16),
      responsible: attendees[0].firstName + ' ' + attendees[0].lastName,
      phone, mesa, attendees, expected,
      status: 'aprobado', approvedAmount: b.amount === undefined || b.amount === '' ? expected : int(b.amount, expected, 0, 10000000),
      payMethod: clean(b.payMethod, 30) || 'puerta',
      holdUntil: null, proofs: [], consent: { at: nowIso(), guardian: true, byTeam: true },
      createdAt: nowIso(), source: b.atDoor ? 'puerta' : 'equipo',
      review: { by: clean(b.by, 40) || 'equipo', at: nowIso(), action: 'approve' },
    };
    const issued = issueTickets(e, g);
    if (b.atDoor) for (const a of g.attendees) { a.attended = true; a.attendedAt = nowIso(); }
    e.groups.push(g);
    return { value: e, result: { g, issued } };
  });
  await store().setJSON(tokenKey(res.g.token), { type: 'group', editionId: idx.currentId, groupId: res.g.id });
  await Promise.all(res.issued.map((a) => store().setJSON(tokenKey(a.ticket.token), { type: 'ticket', editionId: idx.currentId, groupId: res.g.id, attendeeId: a.id })));
  return json({ ok: true, group: { ...res.g, eff: 'aprobado' } });
}

// ───────── enrutador ─────────
export default async (req, context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/vision\/?/, '').split('/').filter(Boolean);
  const m = req.method;
  try {
    if (parts[0] === 'event' && m === 'GET') return await getEvent();
    if (parts[0] === 'qr' && m === 'GET') return await getQr();
    if (parts[0] === 'register' && m === 'POST') return await register(req, context);
    if (parts[0] === 'g' && parts[1]) {
      if (!parts[2] && m === 'GET') return await groupView(parts[1]);
      if (parts[2] === 'proof' && m === 'POST') return await uploadProof(req, parts[1]);
    }
    if (parts[0] === 't' && parts[1] && m === 'GET') return await ticketView(parts[1]);
    if (parts[0] === 'admin') {
      checkAdmin(req);
      if (parts[1] === 'overview' && m === 'GET') return await adminOverview();
      if (parts[1] === 'proof' && parts[2] && m === 'GET') return await adminProof(parts[2], parts[3]);
      if (parts[1] === 'edition' && m === 'POST') return await adminSaveEdition(req);
      if (parts[1] === 'qr' && m === 'POST') return await adminSaveQr(req);
      if (parts[1] === 'group' && m === 'POST') return await adminGroup(req);
      if (parts[1] === 'flags' && m === 'POST') return await adminFlags(req);
      if (parts[1] === 'checkin' && m === 'POST') return await adminCheckin(req);
      if (parts[1] === 'add' && m === 'POST') return await adminAdd(req);
    }
    return fail(404, 'not_found', 'Ruta no encontrada.');
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    console.error(e);
    return fail(500, 'server', 'Algo salió mal. Intenta de nuevo en un momento.');
  }
};
