export const MAX_GROUP_SIZE = 10;
export const PROOF_MAX_BYTES = 5 * 1024 * 1024;

export function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  const local = digits.startsWith('57') ? digits.slice(2) : digits;
  return /^3\d{9}$/.test(local) ? local : null;
}

export function normalizeName(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

export function isClosed(closeAt, now = new Date()) {
  return new Date(closeAt).getTime() < now.getTime();
}

export function calculateRegistration({ ticketTypes, attendees, responsible, whatsapp, consent, maxGroupSize = MAX_GROUP_SIZE }) {
  if (!Array.isArray(attendees) || attendees.length === 0 || attendees.length > maxGroupSize) {
    throw new Error(`El grupo debe tener entre 1 y ${maxGroupSize} personas.`);
  }
  const phone = normalizePhone(whatsapp);
  if (!phone) throw new Error('El WhatsApp debe ser un celular colombiano válido.');
  if (!responsible?.firstName?.trim() || !responsible?.lastName?.trim()) {
    throw new Error('La persona responsable debe tener nombre y apellido.');
  }
  if (!consent?.accepted || (attendees.some((person) => person.ticketTypeId === 'child') && !consent.guardian)) {
    throw new Error('Debes aceptar las autorizaciones requeridas.');
  }

  const types = new Map(ticketTypes.filter((type) => type.enabled).map((type) => [type.id, type]));
  let total = 0;
  let adults = 0;
  const normalizedAttendees = attendees.map((person) => {
    const type = types.get(person.ticketTypeId);
    if (!type) throw new Error('La categoría seleccionada no está disponible.');
    if (!person.firstName?.trim() || !person.lastName?.trim()) throw new Error('Cada asistente debe tener nombre y apellido.');
    const age = person.age === undefined || person.age === '' ? undefined : Number(person.age);
    if (!Number.isInteger(age) && age !== undefined) throw new Error('La edad debe ser un número entero.');
    if (age !== undefined && (age < type.ageMin || age > type.ageMax)) {
      throw new Error(`${person.firstName} no corresponde a la categoría seleccionada.`);
    }
    if (type.id === 'child' && age === undefined) throw new Error('La edad es obligatoria para niños.');
    if (type.id === 'adult') adults += 1;
    total += type.price;
    return { ...person, age, ticketTypeId: type.id, nameKey: `${normalizeName(person.firstName)} ${normalizeName(person.lastName)}` };
  });
  if (!adults) throw new Error('El grupo debe incluir al menos un adulto responsable.');
  return { expectedAmount: total, whatsapp: phone, attendees: normalizedAttendees };
}

export function capacityAllows(stats, requested, capacity) {
  const used = Number(stats?.held ?? 0) + Number(stats?.pendingReview ?? 0) + Number(stats?.confirmed ?? 0);
  return used + requested <= capacity;
}

export function validateProofMetadata({ contentType, size }) {
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(contentType)) throw new Error('Solo se aceptan archivos JPG, PNG o PDF.');
  if (!Number.isFinite(size) || size <= 0 || size > PROOF_MAX_BYTES) throw new Error('El comprobante debe pesar máximo 5 MB.');
}

export class InMemoryCapacityLedger {
  #stats;
  #capacity;
  #queue = Promise.resolve();
  constructor(capacity) { this.#capacity = capacity; this.#stats = { held: 0, pendingReview: 0, confirmed: 0 }; }
  reserve(requested) {
    const work = this.#queue.then(() => {
      if (!capacityAllows(this.#stats, requested, this.#capacity)) return false;
      this.#stats.held += requested;
      return true;
    });
    this.#queue = work.then(() => undefined, () => undefined);
    return work;
  }
  snapshot() { return { ...this.#stats }; }
}
