// Todos a la Mesa · API de inscripciones
// Netlify Function (v2) + Netlify Blobs. Sin dependencias aparte de @netlify/blobs.
//
// Público:
//   GET  /api/mesa/session              Sesión actual (sin cupo ni cifras)
//   POST /api/mesa/register             Apartar cupo (o quedar en lista de espera)
//   GET  /api/mesa/r/:token             Estado de una inscripción (enlace personal)
//   POST /api/mesa/r/:token/confirm     Confirmar asistencia
//   POST /api/mesa/r/:token/cancel      Liberar el cupo
//   GET  /api/mesa/p/:personToken       Datos para reinscribirse en un toque
//
// Administración (cabecera x-admin-key = variable de entorno MESA_ADMIN_KEY):
//   GET  /api/mesa/admin/overview
//   GET  /api/mesa/admin/session/:id
//   POST /api/mesa/admin/session        Crear o editar una sesión
//   POST /api/mesa/admin/reg            Actualizar una inscripción (llegó, pagó, avisado, estado)
//   POST /api/mesa/admin/add            Inscribir manualmente (p. ej. en la puerta)
//   GET  /api/mesa/admin/history        Asistencia por persona en todas las sesiones

import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const config = { path: '/api/mesa/*' };

const TZ_OFFSET = '-05:00'; // America/Bogota, sin horario de verano
const MAX_RETRIES = 16;
const WAITLIST_LIMIT = 200; // límite de seguridad de la lista de espera por sesión

// Primera sesión: se crea sola la primera vez que alguien abre el formulario.
const DEFAULT_SESSION = {
  id: '2026-11-18',
  date: '2026-11-18',
  time: '19:00',
  durationMinutes: 150,
  venue: 'Pasión del Cielo',
  address: 'Edificio Capitalia, piso 12 · Carrera 23 # 62-39, Manizales',
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Pasi%C3%B3n+del+Cielo+Edificio+Capitalia+Carrera+23+%2362-39+Manizales',
  notes: '',
  price: 30000,
  capacity: 85,
  closeAt: null, // null = se cierra a la hora de inicio
  status: 'open',
};

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

function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('3')) d = '57' + d; // celular colombiano
  if (d.length === 12 && d.startsWith('573')) return d;
  if (!String(raw ?? '').trim().startsWith('+') && !String(raw ?? '').trim().startsWith('00')) return null;
  return d.length >= 8 && d.length <= 15 ? d : null; // número internacional con +
}

function startDate(s) { return new Date(`${s.date}T${s.time}:00${TZ_OFFSET}`); }
function closeDate(s) { return s.closeAt ? new Date(s.closeAt) : startDate(s); }

function counts(s) {
  const c = { confirmado: 0, espera: 0, cancelado: 0, llegaron: 0, pagaron: 0, reconfirmados: 0 };
  for (const r of s.regs) {
    c[r.status] = (c[r.status] || 0) + 1;
    if (r.attended) c.llegaron++;
    if (r.paid) c.pagaron++;
    if (r.status === 'confirmado' && r.reconfirmed) c.reconfirmados++;
  }
  return c;
}

function publicState(s) {
  if (!s) return 'none';
  if (s.status === 'closed' || Date.now() >= closeDate(s).getTime()) return 'closed';
  return counts(s).confirmado < s.capacity ? 'open' : 'waitlist';
}

function publicSession(s) {
  if (!s) return null;
  const { id, date, time, durationMinutes, venue, address, mapsUrl, notes, price } = s;
  return { id, date, time, durationMinutes, venue, address, mapsUrl, notes, price, startsAt: startDate(s).toISOString() };
}

// Promueve desde la lista de espera mientras haya cupo.
function fillFromWaitlist(s) {
  const promoted = [];
  let free = s.capacity - counts(s).confirmado;
  const waiting = s.regs.filter((r) => r.status === 'espera').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of waiting) {
    if (free <= 0) break;
    r.status = 'confirmado';
    r.promotedAt = nowIso();
    r.needsNotice = true;
    free--;
    promoted.push(r.id);
  }
  return promoted;
}

// ───────── almacenamiento ─────────
// globalThis.__mesaTestStore permite pruebas automáticas con un almacenamiento simulado.
const store = () => globalThis.__mesaTestStore || getStore({ name: 'todos-a-la-mesa', consistency: 'strong' });
const sessionKey = (id) => `session/${id}`;
const personKey = (phone) => `person/${phone}`;
const tokenKey = (t) => `token/${t}`;

async function read(key) {
  const r = await store().getWithMetadata(key, { type: 'json' });
  return r ? { data: r.data, etag: r.etag } : { data: null, etag: null };
}

// Lectura-modificación-escritura con control de concurrencia (ETag).
// fn recibe el valor actual (o null) y devuelve { value, result } o lanza un error.
async function mutate(key, fn) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const { data, etag } = await read(key);
    const draft = data ? structuredClone(data) : null;
    const out = await fn(draft);
    if (out.skipWrite) return out.result;
    // En producción Netlify Blobs siempre devuelve ETag; si faltara, se escribe sin condición.
    const opts = etag ? { onlyIfMatch: etag } : data ? {} : { onlyIfNew: true };
    if (data && !etag) console.warn('mesa: lectura sin ETag para', key);
    const w = await store().setJSON(key, out.value, opts);
    if (w.modified) return out.result;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * Math.min(i + 1, 6)));
  }
  throw new HttpError(503, 'busy', 'Hay muchas inscripciones al mismo tiempo. Intenta de nuevo en un momento.');
}

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function getIndex() {
  const { data } = await read('index');
  return data;
}

async function ensureIndex() {
  let idx = await getIndex();
  if (idx) return idx;
  await store().setJSON(sessionKey(DEFAULT_SESSION.id), { ...DEFAULT_SESSION, regs: [], createdAt: nowIso() }, { onlyIfNew: true });
  await store().setJSON('index', { currentId: DEFAULT_SESSION.id, sessions: [DEFAULT_SESSION.id] }, { onlyIfNew: true });
  return getIndex();
}

async function currentSession() {
  const idx = await ensureIndex();
  if (!idx?.currentId) return null;
  return (await read(sessionKey(idx.currentId))).data;
}

// ───────── manejadores públicos ─────────
async function getSession() {
  const s = await currentSession();
  return json({ ok: true, state: publicState(s), session: publicSession(s) });
}

async function register(req, context) {
  const body = await req.json().catch(() => ({}));
  if (body.website) return json({ ok: true, status: 'confirmado', token: token() }); // trampa antispam
  if (body.startedAt && Date.now() - Number(body.startedAt) < 2500) throw new HttpError(400, 'too_fast', 'Revisa tus datos e intenta de nuevo.');
  if (body.commit !== true) throw new HttpError(400, 'commit', 'Marca el compromiso de asistencia para apartar tu cupo.');

  let person = null;
  if (body.personToken) {
    const t = (await read(tokenKey(clean(body.personToken, 40)))).data;
    if (t?.type === 'person') person = (await read(personKey(t.phone))).data;
  }
  const phone = person ? person.phone : normalizePhone(body.phone);
  const name = clean(body.name, 80) || person?.name || '';
  const mesa = clean(body.mesa, 80) || person?.mesa || '';
  if (!name || name.length < 3) throw new HttpError(400, 'name', 'Escribe tu nombre completo.');
  if (!phone) throw new HttpError(400, 'phone', 'Escribe un número de WhatsApp válido (10 dígitos, o con + y el indicativo del país).');
  if (!mesa) throw new HttpError(400, 'mesa', 'Cuéntanos a qué Mesa asistes o marca que aún no asistes a una.');

  const idx = await ensureIndex();
  if (!idx?.currentId) throw new HttpError(409, 'none', 'No hay inscripciones abiertas en este momento.');
  const sid = idx.currentId;

  const result = await mutate(sessionKey(sid), (s) => {
    if (!s) throw new HttpError(409, 'none', 'No hay inscripciones abiertas en este momento.');
    const state = publicState(s);
    if (state === 'closed') throw new HttpError(409, 'closed', 'Las inscripciones para esta sesión ya cerraron.');
    const existing = s.regs.find((r) => r.phone === phone && r.status !== 'cancelado');
    if (existing) return { skipWrite: true, result: { already: true, status: existing.status } };
    const c = counts(s);
    if (c.confirmado >= s.capacity && c.espera >= WAITLIST_LIMIT) throw new HttpError(409, 'full', 'No hay más cupos disponibles para esta sesión.');
    const reg = {
      id: token(6),
      token: token(16),
      name, phone, mesa,
      firstTime: body.firstTime === true,
      status: c.confirmado < s.capacity ? 'confirmado' : 'espera',
      reconfirmed: false,
      attended: false,
      paid: false,
      reminded: false,
      createdAt: nowIso(),
      ipHash: createHash('sha256').update(String(context?.ip || '')).digest('hex').slice(0, 16),
      source: person ? 'reinscripcion' : 'formulario',
    };
    s.regs.push(reg);
    return { value: s, result: { reg } };
  });

  if (result.already) {
    return json({ ok: true, already: true, status: result.status, session: publicSession(await currentSession()) });
  }

  const { reg } = result;
  await store().setJSON(tokenKey(reg.token), { type: 'reg', sessionId: sid, regId: reg.id });
  const personToken = await upsertPerson({ phone, name, mesa });
  const s = await currentSession();
  return json({ ok: true, status: reg.status, token: reg.token, personToken, name: reg.name, session: publicSession(s) });
}

async function upsertPerson({ phone, name, mesa }) {
  return mutate(personKey(phone), (p) => {
    if (p) {
      p.name = name; p.mesa = mesa; p.updatedAt = nowIso();
      return { value: p, result: p.token };
    }
    const t = token(12);
    return { value: { phone, name, mesa, token: t, createdAt: nowIso() }, result: t };
  }).then(async (t) => {
    await store().setJSON(tokenKey(t), { type: 'person', phone });
    return t;
  });
}

async function loadReg(t) {
  const ref = (await read(tokenKey(clean(t, 40)))).data;
  if (!ref || ref.type !== 'reg') throw new HttpError(404, 'not_found', 'No encontramos esta inscripción. Revisa el enlace.');
  return ref;
}

async function regView(t) {
  const ref = await loadReg(t);
  const s = (await read(sessionKey(ref.sessionId))).data;
  const r = s?.regs.find((x) => x.id === ref.regId);
  if (!r) throw new HttpError(404, 'not_found', 'No encontramos esta inscripción.');
  const person = (await read(personKey(r.phone))).data;
  const idx = await getIndex();
  return json({
    ok: true,
    name: r.name,
    status: r.status,
    reconfirmed: r.reconfirmed,
    isCurrent: idx?.currentId === s.id,
    past: Date.now() >= startDate(s).getTime() + (s.durationMinutes || 120) * 60000,
    personToken: person?.token || null,
    session: publicSession(s),
  });
}

async function regAction(t, action) {
  const ref = await loadReg(t);
  await mutate(sessionKey(ref.sessionId), (s) => {
    const r = s?.regs.find((x) => x.id === ref.regId);
    if (!r) throw new HttpError(404, 'not_found', 'No encontramos esta inscripción.');
    if (Date.now() >= startDate(s).getTime() + (s.durationMinutes || 120) * 60000) throw new HttpError(409, 'past', 'Esta sesión ya pasó.');
    if (action === 'confirm') {
      if (r.status === 'cancelado') throw new HttpError(409, 'cancelled', 'Liberaste este cupo. Si quieres volver, inscríbete de nuevo.');
      r.reconfirmed = true; r.reconfirmedAt = nowIso();
    } else if (action === 'cancel') {
      if (r.status === 'cancelado') return { skipWrite: true };
      const wasConfirmed = r.status === 'confirmado';
      r.status = 'cancelado'; r.cancelledAt = nowIso(); r.cancelledBy = 'persona';
      if (wasConfirmed) fillFromWaitlist(s);
    }
    return { value: s };
  });
  return regView(t);
}

async function personPrefill(t) {
  const ref = (await read(tokenKey(clean(t, 40)))).data;
  if (!ref || ref.type !== 'person') throw new HttpError(404, 'not_found', 'Este enlace no es válido.');
  const p = (await read(personKey(ref.phone))).data;
  if (!p) throw new HttpError(404, 'not_found', 'Este enlace no es válido.');
  const s = await currentSession();
  const already = s?.regs.find((r) => r.phone === p.phone && r.status !== 'cancelado');
  return json({ ok: true, name: p.name, mesa: p.mesa, phoneHint: '•••• ' + p.phone.slice(-4), alreadyStatus: already?.status || null });
}

// ───────── administración ─────────
function checkAdmin(req) {
  const expected = process.env.MESA_ADMIN_KEY || '';
  if (expected.length < 8) throw new HttpError(503, 'not_configured', 'Falta configurar la contraseña del panel (MESA_ADMIN_KEY) en Netlify.');
  const given = req.headers.get('x-admin-key') || '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, 'unauthorized', 'Contraseña incorrecta.');
}

function adminSession(s) {
  return { ...s, startsAt: startDate(s).toISOString(), state: publicState(s), counts: counts(s) };
}

async function adminOverview() {
  const idx = await ensureIndex();
  const sessions = [];
  for (const id of idx.sessions) {
    const s = (await read(sessionKey(id))).data;
    if (s) sessions.push({ id: s.id, date: s.date, time: s.time, venue: s.venue, status: s.status, state: publicState(s), counts: counts(s), capacity: s.capacity });
  }
  sessions.sort((a, b) => b.id.localeCompare(a.id));
  const current = idx.currentId ? (await read(sessionKey(idx.currentId))).data : null;
  return json({ ok: true, currentId: idx.currentId, sessions, current: current ? adminSession(current) : null });
}

async function adminGetSession(id) {
  const s = (await read(sessionKey(clean(id, 20)))).data;
  if (!s) throw new HttpError(404, 'not_found', 'Sesión no encontrada.');
  return json({ ok: true, session: adminSession(s) });
}

async function adminSaveSession(req) {
  const b = await req.json().catch(() => ({}));
  const date = clean(b.date, 10);
  const time = clean(b.time, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date', 'Fecha inválida.');
  if (!/^\d{2}:\d{2}$/.test(time)) throw new HttpError(400, 'time', 'Hora inválida.');
  const id = clean(b.id, 20) || date;
  const capacity = Math.max(1, Math.min(2000, parseInt(b.capacity, 10) || 85));
  const price = Math.max(0, parseInt(b.price, 10) || 0);
  const closeAt = b.closeAt ? new Date(`${clean(b.closeAt, 16)}:00${TZ_OFFSET}`).toISOString() : null;
  const fields = {
    date, time,
    durationMinutes: Math.max(30, Math.min(600, parseInt(b.durationMinutes, 10) || 150)),
    venue: clean(b.venue, 80) || 'Pasión del Cielo',
    address: clean(b.address, 160),
    mapsUrl: /^https:\/\//.test(String(b.mapsUrl || '')) ? String(b.mapsUrl).slice(0, 500) : '',
    notes: clean(b.notes, 300),
    price, capacity, closeAt,
    status: b.status === 'closed' ? 'closed' : 'open',
  };
  const promoted = await mutate(sessionKey(id), (s) => {
    if (s) { Object.assign(s, fields, { updatedAt: nowIso() }); }
    else { s = { id, ...fields, regs: [], createdAt: nowIso() }; }
    const p = fillFromWaitlist(s); // si se amplía el cupo, entra la lista de espera
    return { value: s, result: p };
  });
  await mutate('index', (idx) => {
    idx = idx || { currentId: null, sessions: [] };
    if (!idx.sessions.includes(id)) idx.sessions.push(id);
    if (b.makeCurrent !== false) idx.currentId = id;
    return { value: idx };
  });
  return json({ ok: true, id, promoted: promoted.length });
}

async function adminUpdateReg(req) {
  const b = await req.json().catch(() => ({}));
  const sid = clean(b.sessionId, 20);
  const rid = clean(b.regId, 20);
  const reg = await mutate(sessionKey(sid), (s) => {
    const r = s?.regs.find((x) => x.id === rid);
    if (!r) throw new HttpError(404, 'not_found', 'Inscripción no encontrada.');
    for (const k of ['attended', 'paid', 'reminded', 'reconfirmed']) if (typeof b[k] === 'boolean') r[k] = b[k];
    if (b.attended === true) { r.attendedAt = nowIso(); if (r.status !== 'confirmado') r.status = 'confirmado'; }
    if (b.noticeSent === true) r.needsNotice = false;
    if (b.status === 'cancelado' && r.status !== 'cancelado') {
      const was = r.status === 'confirmado';
      r.status = 'cancelado'; r.cancelledAt = nowIso(); r.cancelledBy = 'admin';
      if (was) fillFromWaitlist(s);
    } else if (b.status === 'confirmado' && r.status !== 'confirmado') {
      r.status = 'confirmado'; r.manualConfirm = true; // el equipo puede dar cupo por encima del límite
    }
    return { value: s, result: r };
  });
  return json({ ok: true, reg });
}

async function adminAdd(req) {
  const b = await req.json().catch(() => ({}));
  const sid = clean(b.sessionId, 20);
  const phone = normalizePhone(b.phone);
  const name = clean(b.name, 80);
  const mesa = clean(b.mesa, 80) || 'Sin especificar';
  if (!name || !phone) throw new HttpError(400, 'invalid', 'Nombre y WhatsApp son obligatorios.');
  const reg = await mutate(sessionKey(sid), (s) => {
    if (!s) throw new HttpError(404, 'not_found', 'Sesión no encontrada.');
    if (s.regs.find((r) => r.phone === phone && r.status !== 'cancelado')) throw new HttpError(409, 'dup', 'Ese número ya está inscrito en esta sesión.');
    const r = {
      id: token(6), token: token(16), name, phone, mesa, firstTime: b.firstTime === true,
      status: 'confirmado', reconfirmed: false, attended: b.attended === true, paid: b.paid === true, reminded: false,
      createdAt: nowIso(), source: 'equipo', manualConfirm: true,
    };
    if (r.attended) r.attendedAt = nowIso();
    s.regs.push(r);
    return { value: s, result: r };
  });
  await store().setJSON(tokenKey(reg.token), { type: 'reg', sessionId: sid, regId: reg.id });
  const personToken = await upsertPerson({ phone, name, mesa });
  return json({ ok: true, reg, personToken });
}

async function adminHistory() {
  const idx = await ensureIndex();
  const people = {};
  for (const id of idx.sessions) {
    const s = (await read(sessionKey(id))).data;
    if (!s) continue;
    const ended = Date.now() >= startDate(s).getTime() + (s.durationMinutes || 120) * 60000;
    for (const r of s.regs) {
      const p = (people[r.phone] ||= { phone: r.phone, name: r.name, mesa: r.mesa, inscripciones: 0, asistencias: 0, inasistencias: 0, cancelaciones: 0, sesiones: [] });
      p.name = r.name; p.mesa = r.mesa;
      p.inscripciones++;
      if (r.status === 'cancelado') p.cancelaciones++;
      if (r.attended) p.asistencias++;
      else if (ended && r.status === 'confirmado') p.inasistencias++;
      p.sesiones.push({ id: s.id, status: r.status, attended: !!r.attended });
    }
  }
  // token de reinscripción de cada persona (para el mensaje de invitación)
  const list = Object.values(people);
  await Promise.all(list.map(async (p) => { p.personToken = (await read(personKey(p.phone))).data?.token || null; }));
  return json({ ok: true, people: list });
}

// ───────── enrutador ─────────
export default async (req, context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/mesa\/?/, '').split('/').filter(Boolean);
  const m = req.method;
  try {
    if (parts[0] === 'session' && m === 'GET') return await getSession();
    if (parts[0] === 'register' && m === 'POST') return await register(req, context);
    if (parts[0] === 'r' && parts[1]) {
      if (!parts[2] && m === 'GET') return await regView(parts[1]);
      if (parts[2] === 'confirm' && m === 'POST') return await regAction(parts[1], 'confirm');
      if (parts[2] === 'cancel' && m === 'POST') return await regAction(parts[1], 'cancel');
    }
    if (parts[0] === 'p' && parts[1] && m === 'GET') return await personPrefill(parts[1]);
    if (parts[0] === 'admin') {
      checkAdmin(req);
      if (parts[1] === 'overview' && m === 'GET') return await adminOverview();
      if (parts[1] === 'session' && parts[2] && m === 'GET') return await adminGetSession(parts[2]);
      if (parts[1] === 'session' && m === 'POST') return await adminSaveSession(req);
      if (parts[1] === 'reg' && m === 'POST') return await adminUpdateReg(req);
      if (parts[1] === 'add' && m === 'POST') return await adminAdd(req);
      if (parts[1] === 'history' && m === 'GET') return await adminHistory();
    }
    return fail(404, 'not_found', 'Ruta no encontrada.');
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    console.error(e);
    return fail(500, 'server', 'Algo salió mal. Intenta de nuevo en un momento.');
  }
};
