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
//   POST /api/vision/waitlist              Lista de espera (solo cuando no hay cupo)
//   GET  /api/vision/equipo                Plan de la noche para la página del equipo (sin cifras)
//
// Voluntarios (cabecera x-staff-key; solo nombres y entregas, nunca pagos ni teléfonos):
//   GET  /api/vision/staff/check
//   POST /api/vision/staff/scan            Escanear una boleta en un punto (ingreso, comida o granizado)
//   POST /api/vision/staff/search          Buscar por nombre o código
//   POST /api/vision/staff/mark            Marcar o desmarcar a personas de un grupo
//
// Administración (cabecera x-admin-key = VISION_ADMIN_KEY; si no existe, MESA_ADMIN_KEY):
//   GET  /api/vision/admin/overview
//   GET  /api/vision/admin/proof/:groupId/:n   Ver un comprobante
//   POST /api/vision/admin/edition             Guardar la configuración de la edición
//   POST /api/vision/admin/qr                  Subir el QR de pago (imagen)
//   POST /api/vision/admin/group               Aprobar, rechazar, marcar incompleto, anular o reabrir
//   POST /api/vision/admin/flags               Marcar mensajes enviados (boletas, recordatorio, es hoy)
//   POST /api/vision/admin/followup            Anotar qué respondió quien no ha subido el comprobante
//   POST /api/vision/admin/checkin             Llegada por código de boleta o por persona
//   POST /api/vision/admin/add                 Inscribir en la puerta o a mano (queda aprobado)
//   POST /api/vision/admin/waitlist            Marcar avisado o quitar de la lista de espera
//   POST /api/vision/admin/equipo              Guardar plan y equipos, o la hora real de inicio
//   POST /api/vision/admin/staffkey            Crear, cambiar o quitar la clave de voluntarios
//   POST /api/vision/admin/caja                Gastos, diferencias, entradas y arqueos (privado)

import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { DEFAULT_MESAS } from './mesa.mjs';

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
  highlights: 'Music · Mensaje · Temporada 2027',
  refundText: 'Al pagar, tu cupo queda reservado para ti. No hacemos devoluciones de dinero, salvo casos de fuerza mayor (por ejemplo, un accidente o una calamidad). Si no puedes asistir, escríbenos por WhatsApp.',
  theme: 'negro', // 'negro' (negro y dorado, aprobado el 19-11-2026) o 'claro' (blanco y azul)
  prices: { adult: 75000, child: 40000 },
  childAgeMin: 2,
  childAgeMax: 11,
  closeAt: '2026-12-15T23:59:59-05:00', // inscripciones del 15 de noviembre al 15 de diciembre
  maxGroup: 10,
  status: 'open',
  contactWhatsapp: '573043229348',
  // privado
  capacity: 300,
  holdMinutes: 60,
  correctionHours: 24,
  paymentUrl: 'https://checkout.wompi.co/l/VPOS_nEkNT7',
};
const PRIVATE_FIELDS = ['capacity', 'holdMinutes', 'correctionHours', 'paymentUrl', 'groups', 'hasQr', 'waitlist', 'equipo', 'rev', 'staffKeyHash', 'caja'];

// Borrador del plan de la noche y de los equipos (se edita en Panel → Equipo).
const DEFAULT_EQUIPO = {
  plan: [
    { t: '17:00', title: 'Llega el equipo', who: 'Todos', note: 'Oración, prueba de sonido, comida y puerta listas.' },
    { t: '17:30', title: 'Abren puertas', who: 'Puerta y boletas', note: 'Escanear cada boleta. Quien no tiene boleta pasa a la mesa de inscripción.' },
    { t: '18:00', title: 'Bienvenida', who: 'Coordinación', note: '' },
    { t: '18:10', title: 'Music', who: 'Music', note: '' },
    { t: '18:45', title: 'Celebramos lo vivido', who: 'Media', note: 'Video y testimonios del año.' },
    { t: '19:05', title: 'Comida y bebidas', who: 'Comida y bebidas', note: 'Una comida y dos bebidas por persona.' },
    { t: '19:45', title: 'Mensaje', who: 'Coordinación', note: '' },
    { t: '20:15', title: 'Revelación de la Temporada 2027', who: 'Media', note: 'Momento central de la noche.' },
    { t: '20:30', title: 'Music y cierre', who: 'Music', note: '' },
    { t: '21:00', title: 'Despedida', who: 'Todos', note: 'Salida ordenada; el equipo recoge.' },
  ],
  roles: [
    { name: 'Coordinación', people: 'Juan y Lili', tasks: ['Bienvenida y mensaje', 'Decide si el programa se corre'] },
    { name: 'Music', people: 'Esteban y Dani', tasks: ['Prueba de sonido a las 5:00', 'Music de apertura y de cierre'] },
    { name: 'Media', people: 'War y Danna', tasks: ['Fotos y reels', 'Video de lo vivido', 'Grabar el mensaje', 'Revelación del tema'] },
    { name: 'Puerta y boletas', people: 'Por definir', tasks: ['Escanear boletas en Panel → Puerta', 'Inscribir a quien paga en la puerta'] },
    { name: 'Comida y bebidas', people: 'Por definir', tasks: ['Una comida y dos bebidas por persona'] },
    { name: 'Kids', people: 'Por definir', tasks: ['Acompañar a los niños'] },
    { name: 'Logística', people: 'Por definir', tasks: ['Auditorio, sillas y salida'] },
  ],
};

// Color de vestuario sugerido: uno por persona, repartido por igual. Se guarda en la boleta y no cambia.
// El orden de la lista no se debe alterar: en la boleta se guarda la clave.
const COLORS = [
  { key: 'coral', name: 'Coral', hex: '#ff7f57' },
  { key: 'mostaza', name: 'Mostaza', hex: '#e6b24c' },
  { key: 'verde', name: 'Verde', hex: '#a3cc72' },
  { key: 'turquesa', name: 'Turquesa', hex: '#6cc0c4' },
  { key: 'lila', name: 'Lila', hex: '#97a4e6' },
];
const colorOf = (a) => COLORS.find((c) => c.key === a.ticket?.color) || null;

// A cada boleta sin color le da el menos usado entre las vigentes, en orden de emisión.
function assignColors(e) {
  const used = new Map(COLORS.map((c) => [c.key, 0]));
  const pending = [];
  for (const g of e.groups) {
    for (const a of g.attendees) {
      if (!a.ticket) continue;
      if (!used.has(a.ticket.color)) pending.push(a.ticket);
      else if (g.status !== 'cancelado') used.set(a.ticket.color, used.get(a.ticket.color) + 1);
    }
  }
  pending.sort((x, y) => String(x.issuedAt).localeCompare(String(y.issuedAt)));
  for (const t of pending) {
    t.color = COLORS.reduce((best, c) => (used.get(c.key) < used.get(best.key) ? c : best)).key;
    used.set(t.color, used.get(t.color) + 1);
  }
}

// 27-11-2026: personas que faltaban en los equipos. Solo agrega; respeta lo editado en el panel.
function addMissingTeam(q) {
  if (!q || !Array.isArray(q.roles)) return;
  const all = () => plain(q.roles.map((r) => r.people).join(' '));
  const media = q.roles.find((r) => plain(r.name) === 'media');
  if (media && !all().includes('camilo y camila')) {
    const before = String(media.people || '').replace(/\s+y\s+/g, ', ').replace(/por definir/i, '').trim();
    media.people = [before, 'Camilo y Camila'].filter(Boolean).join(', ');
  }
  const insert = (after, role) => {
    const i = q.roles.findIndex((r) => plain(r.name) === after);
    q.roles.splice(i < 0 ? q.roles.length : i + 1, 0, role);
  };
  if (!all().includes('yuli')) insert('coordinacion', { name: 'Administración', people: 'Carlos y Yuli', tasks: ['Revisar pagos y cuentas', 'Inscribir a quien paga en la puerta'] });
  if (!all().includes('natalia')) insert('comida y bebidas', { name: 'Coffee · Granizados', people: 'Johnatan y Natalia', tasks: ['Entregar los granizados', 'Marcar cada entrega en Escanear → Granizado'] });
}

// Ediciones guardadas antes de un cambio de reglas se ponen al día al leerlas.
const OLD_INCLUDES = 'Incluye alimentación y un concierto de nuestro grupo musical.';
function migrate(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.groups)) return e;
  if ((e.rev || 0) < 2) {
    if (e.closeAt && Date.parse(e.closeAt) === Date.parse('2026-12-05T23:59:59-05:00')) e.closeAt = DEFAULT_EDITION.closeAt;
    if (e.includes === OLD_INCLUDES) e.includes = DEFAULT_EDITION.includes;
    e.rev = 2;
  }
  if ((e.rev || 0) < 3) {
    // 21-11-2026: niño pasa a $40.000 y "Tema 2027" a "Temporada 2027". Los grupos ya inscritos conservan su total.
    if (e.prices && Number(e.prices.child) === 35000) e.prices.child = 40000;
    if (typeof e.highlights === 'string') e.highlights = e.highlights.replace(/Tema 2027/g, 'Temporada 2027');
    for (const it of (e.equipo && e.equipo.plan) || []) if (it && typeof it.title === 'string') it.title = it.title.replace(/del tema 2027/gi, 'de la Temporada 2027');
    e.rev = 3;
  }
  if (e.highlights === undefined) e.highlights = DEFAULT_EDITION.highlights;
  if (e.refundText === undefined) e.refundText = DEFAULT_EDITION.refundText;
  if (!e.theme) e.theme = DEFAULT_EDITION.theme;
  if (!Array.isArray(e.waitlist)) e.waitlist = [];
  if (!e.equipo) e.equipo = structuredClone(DEFAULT_EQUIPO);
  if ((e.rev || 0) < 4) { addMissingTeam(e.equipo); e.rev = 4; }
  assignColors(e);
  return e;
}

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
    ocupados: 0, confirmados: 0, llegaron: 0, comida: 0, comidaNinos: 0, granizado: 0, recaudo: 0, esperado: 0, boletasSinEnviar: 0 };
  for (const g of e.groups) {
    const st = effStatus(g, now);
    c[st] = (c[st] || 0) + seats(g);
    if (HOLDS.has(st)) c.ocupados += seats(g);
    if (st === 'aprobado') {
      c.grupos++;
      c.confirmados += seats(g);
      c.recaudo += g.approvedAmount || 0;
      for (const a of g.attendees) {
        if (a.type === 'child') c.ninos++; else c.adultos++;
        if (a.attended) c.llegaron++;
        if (a.served?.comida) { c.comida++; if (a.type === 'child') c.comidaNinos++; }
        if (a.served?.granizado) c.granizado++;
      }
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

function publicEdition(e) {
  if (!e) return null;
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
  if (r && key.startsWith('edition/')) migrate(r.data);
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
  await store().setJSON(editionKey(DEFAULT_EDITION.id), migrate({ ...DEFAULT_EDITION, groups: [], rev: 2, createdAt: nowIso() }), { onlyIfNew: true });
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
  // Igual que Todos a la Mesa: mientras no se guarde una lista en su panel, vale la lista base.
  try {
    const r = await mesaStore().getWithMetadata('config/mesas', { type: 'json' });
    return Array.isArray(r?.data?.mesas) && r.data.mesas.length ? r.data.mesas : DEFAULT_MESAS;
  } catch { return DEFAULT_MESAS; }
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
  if (!mesa) throw new HttpError(400, 'mesa', 'Escoge tu Mesa. Si no asistes a ninguna, marca esa opción.');

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
    attendees: g.attendees.map((a) => ({ name: a.firstName + ' ' + a.lastName, type: a.type, age: a.age, ...(st === 'aprobado' && a.ticket ? { ticket: a.ticket.token, code: a.ticket.code, color: colorOf(a) } : {}) })),
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
  return json({ ok: true, valid, name: a.firstName + ' ' + a.lastName, type: a.type, age: a.age, code: a.ticket.code, color: colorOf(a), attended: !!a.attended, served: servedOf(a), group: g.responsible, edition: publicEdition(e) });
}

const STATIONS = ['ingreso', 'comida', 'granizado'];
const servedOf = (a) => ({ ingreso: !!a.attended, comida: !!a.served?.comida, granizado: !!a.served?.granizado });

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

function adminEdition(full) {
  const now = Date.now();
  const { staffKeyHash, ...e } = full;
  const groups = e.groups.filter((g) => !g.deletedAt).map((g) => ({ ...g, eff: effStatus(g, now) }));
  return { ...e, hasStaffKey: !!staffKeyHash, groups, state: publicState(e, now), counts: counts(e, now), startsAt: startDate(e).toISOString() };
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
    refundText: clean(b.refundText, 400),
    theme: b.theme === 'negro' ? 'negro' : 'claro',
    prices: { adult: int(b.priceAdult, 75000, 0, 2000000), child: int(b.priceChild, 40000, 0, 2000000) },
    closeAt: b.closeAt ? new Date(`${clean(b.closeAt, 16)}:59${TZ_OFFSET}`).toISOString() : null,
    maxGroup: int(b.maxGroup, 10, 1, 20),
    status: b.status === 'closed' ? 'closed' : 'open',
    capacity: int(b.capacity, 300, 1, 5000),
    holdMinutes: int(b.holdMinutes, 60, 10, 1440),
    correctionHours: int(b.correctionHours, 24, 1, 240),
    paymentUrl: String(b.paymentUrl || '').slice(0, 500),
  };
  await mutate(editionKey(id), (e) => {
    if (!e) e = migrate({ ...DEFAULT_EDITION, id, groups: [], rev: 2, createdAt: nowIso() });
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
  assignColors(e);
  return issued;
}

async function adminGroup(req) {
  const b = await req.json().catch(() => ({}));
  const idx = await ensureIndex();
  const gid = clean(b.groupId, 20);
  const action = clean(b.action, 20);
  const by = clean(b.by, 40) || 'equipo';
  const mesas = action === 'edit' ? await getMesas() : [];
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
    } else if (action === 'delete') {
      // Sale de todas las listas pero no se destruye. Nunca si hubo comprobante o pago aprobado.
      if ((st !== 'vencido' && st !== 'cancelado') || g.proofs.length || g.approvedAmount != null) throw new HttpError(409, 'state', 'Solo se eliminan inscripciones vencidas o anuladas que nunca tuvieron comprobante ni pago.');
      g.status = 'cancelado'; g.holdUntil = null; g.deletedAt = nowIso(); g.deletedBy = by;
    } else if (action === 'edit') {
      // Ficha completa: WhatsApp, Mesa y personas. No agrega ni quita personas y conserva sus boletas.
      const phone = normalizePhone(b.phone);
      if (!phone) throw new HttpError(400, 'phone', 'Escribe un número de WhatsApp válido.');
      const mesa = [NO_MESA, ...mesas].find((x) => plain(x) === plain(b.mesa));
      if (b.mesa && !mesa && b.mesa !== g.mesa) throw new HttpError(400, 'mesa', 'Esa Mesa no está en la lista.');
      const input = new Map((Array.isArray(b.attendees) ? b.attendees : []).slice(0, 30).map((n) => [clean(n?.id, 20), n]));
      const next = g.attendees.map((a) => {
        const n = input.get(a.id);
        if (!n) return a;
        const firstName = properName(n.firstName), lastName = properName(n.lastName);
        if (firstName.length < 2 || lastName.length < 2) throw new HttpError(400, 'name', 'Escribe nombre y apellido de cada persona.');
        const out = { ...a, firstName, lastName, type: n.type === 'child' ? 'child' : 'adult' };
        if (out.type === 'child') {
          const age = parseInt(n.age, 10);
          if (!(age >= e.childAgeMin && age <= e.childAgeMax)) throw new HttpError(400, 'age', `La edad de cada niño debe estar entre ${e.childAgeMin} y ${e.childAgeMax} años.`);
          out.age = age;
        } else delete out.age;
        return out;
      });
      if (!next.some((a) => a.type === 'adult')) throw new HttpError(400, 'adult', 'Debe haber al menos un adulto.');
      const typesChanged = next.some((a, i) => a.type !== g.attendees[i].type);
      g.attendees = next;
      g.responsible = next[0].firstName + ' ' + next[0].lastName;
      g.phone = phone;
      g.mesa = mesa || (b.mesa ? g.mesa : '');
      // Lo ya pagado no se recalcula.
      if (typesChanged && g.approvedAmount == null) g.expected = expectedOf(e, next);
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
    for (const k of ['sentAt', 'remindedAt', 'hoyAt', 'rejectSentAt', 'payAskedAt', 'colorAt']) if (k in b) g[k] = b[k] ? nowIso() : null;
    // El mensaje de las boletas ya dice el color: no hace falta avisarlo aparte.
    if (b.sentAt) g.colorAt = g.sentAt;
    return { value: e, result: g };
  });
  return json({ ok: true, group: { ...g, eff: effStatus(g) } });
}

// Seguimiento de quienes no han subido comprobante. Es privado y no cambia el estado ni el cupo.
const FOLLOW_UPS = ['esperando', 'pagado', 'interesado', 'no_va'];
async function adminFollowUp(req) {
  const b = await req.json().catch(() => ({}));
  const status = clean(b.status, 20);
  if (status && !FOLLOW_UPS.includes(status)) throw new HttpError(400, 'status', 'Marca no válida.');
  const idx = await ensureIndex();
  const g = await mutate(editionKey(idx.currentId), (e) => {
    const g = e?.groups.find((x) => x.id === clean(b.groupId, 20));
    if (!g) throw new HttpError(404, 'not_found', 'Inscripción no encontrada.');
    if (status) g.followUp = { status, by: clean(b.by, 40) || 'equipo', at: nowIso() }; else delete g.followUp;
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
    e.groups.push(g);
    const issued = issueTickets(e, g);
    if (b.atDoor) for (const a of g.attendees) { a.attended = true; a.attendedAt = nowIso(); }
    return { value: e, result: { g, issued } };
  });
  await store().setJSON(tokenKey(res.g.token), { type: 'group', editionId: idx.currentId, groupId: res.g.id });
  await Promise.all(res.issued.map((a) => store().setJSON(tokenKey(a.ticket.token), { type: 'ticket', editionId: idx.currentId, groupId: res.g.id, attendeeId: a.id })));
  return json({ ok: true, group: { ...res.g, eff: 'aprobado' } });
}

// ───────── lista de espera ─────────
async function joinWaitlist(req) {
  const b = await req.json().catch(() => ({}));
  if (b.website) return json({ ok: true });
  if (b.startedAt && Date.now() - Number(b.startedAt) < 2500) throw new HttpError(400, 'too_fast', 'Revisa tus datos e intenta de nuevo.');
  const phone = normalizePhone(b.phone);
  const name = properName(b.name);
  if (name.length < 3) throw new HttpError(400, 'name', 'Escribe tu nombre completo.');
  if (!phone) throw new HttpError(400, 'phone', 'Escribe un número de WhatsApp válido.');
  if (b.consent !== true) throw new HttpError(400, 'consent', 'Marca la autorización de datos para continuar.');
  const adults = int(b.adults, 1, 1, 20), children = int(b.children, 0, 0, 20);
  const idx = await ensureIndex();
  const res = await mutate(editionKey(idx.currentId), (e) => {
    const st = publicState(e);
    if (st === 'closed') throw new HttpError(409, 'closed', 'Las inscripciones ya cerraron.');
    if (st === 'open') return { skipWrite: true, result: { open: true } };
    if (e.waitlist.some((w) => w.phone === phone && !w.removed)) return { skipWrite: true, result: { already: true } };
    if (e.waitlist.length >= 500) throw new HttpError(409, 'full', 'La lista de espera está completa. Escríbenos por WhatsApp.');
    e.waitlist.push({ id: token(6), name, phone, adults, children, createdAt: nowIso() });
    return { value: e, result: {} };
  });
  if (res.open) return json({ ok: false, error: 'open', message: 'Ya hay cupo: puedes inscribirte ahora mismo.' }, 409);
  return json({ ok: true, already: !!res.already });
}

async function adminWaitlist(req) {
  const b = await req.json().catch(() => ({}));
  const idx = await ensureIndex();
  const id = clean(b.id, 20);
  const w = await mutate(editionKey(idx.currentId), (e) => {
    const w = e.waitlist.find((x) => x.id === id);
    if (!w) throw new HttpError(404, 'not_found', 'No está en la lista de espera.');
    if ('notified' in b) w.notifiedAt = b.notified ? nowIso() : null;
    if (b.remove === true) w.removed = true;
    return { value: e, result: w };
  });
  return json({ ok: true, entry: w });
}

// ───────── página del equipo ─────────
async function equipoView() {
  const e = await currentEdition();
  if (!e) throw new HttpError(404, 'not_found', 'Sin edición.');
  const q = e.equipo || DEFAULT_EQUIPO;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  return json({ ok: true, name: e.name, year: e.year, date: e.date, time: e.time, endTime: e.endTime, venue: e.venue, city: e.city,
    plan: q.plan, roles: q.roles, start: q.startDate === today ? q.start || null : null, updatedAt: q.updatedAt || null });
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
async function adminEquipo(req) {
  const b = await req.json().catch(() => ({}));
  const idx = await ensureIndex();
  const out = await mutate(editionKey(idx.currentId), (e) => {
    const q = e.equipo || structuredClone(DEFAULT_EQUIPO);
    if ('start' in b) {
      const start = b.start === null || b.start === '' ? null : clean(b.start, 5);
      if (start !== null && !HHMM.test(start)) throw new HttpError(400, 'start', 'Escribe la hora como 18:15.');
      q.start = start;
      q.startDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    }
    if (Array.isArray(b.plan)) {
      const plan = b.plan.slice(0, 40).map((x) => ({ t: clean(x?.t, 5), title: clean(x?.title, 80), who: clean(x?.who, 60), note: clean(x?.note, 200) }))
        .filter((x) => HHMM.test(x.t) && x.title).sort((a, c) => a.t.localeCompare(c.t));
      if (!plan.length) throw new HttpError(400, 'plan', 'Escribe al menos un momento con hora (18:00 | Bienvenida).');
      q.plan = plan;
    }
    if (Array.isArray(b.roles)) {
      q.roles = b.roles.slice(0, 20).map((r) => ({ name: clean(r?.name, 40), people: clean(r?.people, 120),
        tasks: (Array.isArray(r?.tasks) ? r.tasks : []).slice(0, 12).map((t) => clean(t, 120)).filter(Boolean) })).filter((r) => r.name);
    }
    q.updatedAt = nowIso();
    e.equipo = q;
    return { value: e, result: q };
  });
  return json({ ok: true, equipo: out });
}

// ───────── caja: presupuesto, gastos y arqueos ─────────
const CAJA_TYPES = ['gasto', 'diferencia', 'entrada'];
async function adminCaja(req) {
  const b = await req.json().catch(() => ({}));
  const by = clean(b.by, 40) || 'equipo';
  const amount = (v) => {
    const n = v === '' || v === undefined || v === null ? 0 : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 1000000000) throw new HttpError(400, 'amount', 'Escribe valores en pesos, sin puntos ni decimales.');
    return n;
  };
  const idx = await ensureIndex();
  const caja = await mutate(editionKey(idx.currentId), (e) => {
    const c = e.caja || { items: [], arqueos: [] };
    if (b.op === 'save') {
      if (!CAJA_TYPES.includes(b.type)) throw new HttpError(400, 'type', 'Escoge el tipo.');
      const concept = clean(b.concept, 80);
      if (concept.length < 2) throw new HttpError(400, 'concept', 'Escribe el concepto.');
      const item = { type: b.type, concept, budget: b.type === 'gasto' ? amount(b.budget) : 0, amount: amount(b.amount) };
      if (!item.budget && !item.amount) throw new HttpError(400, 'amount', 'Escribe al menos un valor.');
      if (b.id) {
        const old = c.items.find((x) => x.id === b.id && !x.deletedAt);
        if (!old) throw new HttpError(404, 'not_found', 'Ese movimiento ya no existe.');
        Object.assign(old, item, { by, updatedAt: nowIso() });
      } else {
        if (c.items.length >= 300) throw new HttpError(409, 'full', 'La lista está completa.');
        c.items.push({ id: token(6), ...item, by, createdAt: nowIso() });
      }
    } else if (b.op === 'delete') {
      const old = c.items.find((x) => x.id === b.id);
      if (!old) throw new HttpError(404, 'not_found', 'Ese movimiento ya no existe.');
      old.deletedAt = nowIso(); old.deletedBy = by;
    } else if (b.op === 'arqueo') {
      if (b.real === '' || b.real === undefined) throw new HttpError(400, 'amount', 'Escribe el saldo que ves en el bolsillo.');
      const real = amount(b.real), expected = Math.round(Number(b.expected) || 0);
      c.arqueos = [...c.arqueos, { at: nowIso(), by, real, expected }].slice(-100);
    } else {
      throw new HttpError(400, 'op', 'Acción no válida.');
    }
    e.caja = c;
    return { value: e, result: c };
  });
  return json({ ok: true, caja });
}

// ───────── voluntarios: ingreso y entregas ─────────
const hashKey = (k) => createHash('sha256').update(String(k)).digest('hex');
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function adminStaffKey(req) {
  const b = await req.json().catch(() => ({}));
  const key = String(b.key ?? '').trim();
  if (key && (key.length < 6 || key.length > 60)) throw new HttpError(400, 'key', 'La clave de voluntarios debe tener entre 6 y 60 caracteres.');
  const admin = process.env.VISION_ADMIN_KEY || process.env.MESA_ADMIN_KEY || '';
  if (key && key === admin) throw new HttpError(400, 'key', 'Usa una clave distinta a la del panel.');
  const idx = await ensureIndex();
  await mutate(editionKey(idx.currentId), (e) => {
    if (key) e.staffKeyHash = hashKey(key); else delete e.staffKeyHash;
    return { value: e };
  });
  return json({ ok: true, hasStaffKey: !!key });
}

// La clave llega codificada para admitir tildes y eñes en la cabecera.
async function checkStaff(req) {
  let given = '';
  try { given = decodeURIComponent(req.headers.get('x-staff-key') || '').trim(); } catch { /* clave mal formada */ }
  const e = await currentEdition();
  const admin = process.env.VISION_ADMIN_KEY || process.env.MESA_ADMIN_KEY || '';
  if (e && admin.length >= 8 && given && sameHash(hashKey(given), hashKey(admin))) return e;
  if (!e?.staffKeyHash) throw new HttpError(503, 'not_configured', 'Todavía no hay clave de voluntarios. Pídela a quien coordina.');
  if (!given || !sameHash(hashKey(given), e.staffKeyHash)) {
    await new Promise((r) => setTimeout(r, 400)); // frena los intentos al azar
    throw new HttpError(401, 'unauthorized', 'Clave incorrecta.');
  }
  return e;
}

// Lo único que ve un voluntario.
function staffGroup(g) {
  const st = effStatus(g);
  return {
    id: g.id, responsible: g.responsible, valid: st === 'aprobado',
    attendees: g.attendees.map((a) => ({
      id: a.id, name: a.firstName + ' ' + a.lastName, type: a.type, age: a.age, served: servedOf(a),
      at: { ingreso: a.attendedAt || null, comida: a.served?.comida?.at || null, granizado: a.served?.granizado?.at || null },
    })),
  };
}

function setServed(a, station, value, by) {
  if (station === 'ingreso') { a.attended = value; a.attendedAt = value ? nowIso() : null; a.attendedBy = value ? by : null; return; }
  a.served ||= {};
  if (value) a.served[station] = { at: nowIso(), by }; else delete a.served[station];
}

function stationOf(b) {
  if (!STATIONS.includes(b.station)) throw new HttpError(400, 'station', 'Escoge un punto.');
  return b.station;
}

async function staffScan(req) {
  const b = await req.json().catch(() => ({}));
  const station = stationOf(b);
  const by = clean(b.by, 40) || 'voluntario';
  const raw = String(b.code || '').slice(0, 300);
  const tm = raw.match(/[?&]t=([A-Za-z0-9_-]{10,40})/);
  const code = clean(raw, 40).toUpperCase();
  const idx = await ensureIndex();
  const res = await mutate(editionKey(idx.currentId), (e) => {
    let g, a;
    for (const x of e.groups) {
      const y = x.attendees.find((p) => p.ticket && (tm ? p.ticket.token === tm[1] : p.ticket.code === code));
      if (y) { g = x; a = y; break; }
    }
    if (!a) throw new HttpError(404, 'not_found', 'Esta boleta no existe.');
    const result = effStatus(g) !== 'aprobado' ? 'blocked' : servedOf(a)[station] ? 'already' : 'ok';
    if (result !== 'ok') return { skipWrite: true, result: { g, a, result } };
    setServed(a, station, true, by);
    return { value: e, result: { g, a, result } };
  });
  return json({ ok: true, result: res.result, personId: res.a.id, group: staffGroup(res.g) });
}

async function staffMark(req) {
  const b = await req.json().catch(() => ({}));
  const station = stationOf(b);
  const by = clean(b.by, 40) || 'voluntario';
  const ids = new Set((Array.isArray(b.ids) ? b.ids : []).slice(0, 30).map((x) => clean(x, 20)));
  const value = b.value !== false;
  const idx = await ensureIndex();
  const res = await mutate(editionKey(idx.currentId), (e) => {
    const g = e?.groups.find((x) => x.id === clean(b.groupId, 20));
    if (!g) throw new HttpError(404, 'not_found', 'Inscripción no encontrada.');
    if (value && effStatus(g) !== 'aprobado') throw new HttpError(409, 'not_approved', 'Este grupo no tiene el pago aprobado.');
    const change = g.attendees.filter((a) => ids.has(a.id) && servedOf(a)[station] !== value);
    for (const a of change) setServed(a, station, value, by);
    const result = { g, changed: change.map((a) => a.id) };
    return change.length ? { value: e, result } : { skipWrite: true, result };
  });
  return json({ ok: true, changed: res.changed, group: staffGroup(res.g) });
}

async function staffSearch(req, e) {
  const b = await req.json().catch(() => ({}));
  const q = plain(clean(b.q, 60));
  if (q.length < 3) return json({ ok: true, groups: [] });
  const groups = e.groups.filter((g) => effStatus(g) !== 'cancelado' && g.attendees.some((a) => plain(a.firstName + ' ' + a.lastName + ' ' + (a.ticket?.code || '')).includes(q)));
  return json({ ok: true, groups: groups.slice(0, 12).map(staffGroup), more: groups.length > 12 });
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
    if (parts[0] === 'waitlist' && m === 'POST') return await joinWaitlist(req);
    if (parts[0] === 'equipo' && m === 'GET') return await equipoView();
    if (parts[0] === 'staff') {
      const e = await checkStaff(req);
      if (parts[1] === 'check' && m === 'GET') return json({ ok: true });
      if (parts[1] === 'scan' && m === 'POST') return await staffScan(req);
      if (parts[1] === 'search' && m === 'POST') return await staffSearch(req, e);
      if (parts[1] === 'mark' && m === 'POST') return await staffMark(req);
    }
    if (parts[0] === 'admin') {
      checkAdmin(req);
      if (parts[1] === 'overview' && m === 'GET') return await adminOverview();
      if (parts[1] === 'proof' && parts[2] && m === 'GET') return await adminProof(parts[2], parts[3]);
      if (parts[1] === 'edition' && m === 'POST') return await adminSaveEdition(req);
      if (parts[1] === 'qr' && m === 'POST') return await adminSaveQr(req);
      if (parts[1] === 'group' && m === 'POST') return await adminGroup(req);
      if (parts[1] === 'flags' && m === 'POST') return await adminFlags(req);
      if (parts[1] === 'followup' && m === 'POST') return await adminFollowUp(req);
      if (parts[1] === 'checkin' && m === 'POST') return await adminCheckin(req);
      if (parts[1] === 'add' && m === 'POST') return await adminAdd(req);
      if (parts[1] === 'waitlist' && m === 'POST') return await adminWaitlist(req);
      if (parts[1] === 'equipo' && m === 'POST') return await adminEquipo(req);
      if (parts[1] === 'staffkey' && m === 'POST') return await adminStaffKey(req);
      if (parts[1] === 'caja' && m === 'POST') return await adminCaja(req);
    }
    return fail(404, 'not_found', 'Ruta no encontrada.');
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    console.error(e);
    return fail(500, 'server', 'Algo salió mal. Intenta de nuevo en un momento.');
  }
};
