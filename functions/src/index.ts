import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore, type QueryDocumentSnapshot, type QuerySnapshot, type Transaction } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2/options';

function emulatorOptions() {
  if (!process.env.FUNCTIONS_EMULATOR) return undefined;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    projectId: process.env.GCLOUD_PROJECT ?? 'demo-lhscol-vision',
    storageBucket: `${process.env.GCLOUD_PROJECT ?? 'demo-lhscol-vision'}.firebasestorage.app`,
    // This key exists only in the emulator process memory. It is not a Firebase credential.
    credential: cert({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-lhscol-vision', clientEmail: 'emulator-only@localhost', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })
  };
}

const app = getApps().length ? getApp() : initializeApp(emulatorOptions());
const db = getFirestore(app);
const bucket = getStorage(app).bucket();

// Confirm the production region before first deployment; emulators ignore it.
setGlobalOptions({ region: 'southamerica-east1', maxInstances: 5, minInstances: 0 });

type TicketType = { id: string; price: number; ageMin: number; ageMax: number; enabled: boolean; countsTowardCapacity: boolean };
type Person = { firstName: string; lastName: string; ticketTypeId: string; age?: unknown };
type RegistrationInput = {
  eventId: string;
  responsible: { firstName: string; lastName: string };
  whatsapp: string;
  attendees: Person[];
  consent: { accepted: boolean; guardian: boolean; version: string };
  honeypot?: string;
};

const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const proofTypes = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const requireAppCheck = !process.env.FUNCTIONS_EMULATOR;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(16).toString('base64url');
const clean = (value: unknown) => String(value ?? '').trim();
const nameKey = (value: unknown) => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
type AdminRole = 'owner' | 'reviewer' | 'viewer';
type AdminRequest = { auth?: { uid: string; token?: Record<string, unknown> }; rawRequest: { get(name: string): string | undefined } };

function adminActor(request: AdminRequest, allowed: AdminRole[]) {
  // The header exists solely for isolated emulator tests. Production only trusts Firebase Auth claims.
  const testRole = process.env.FUNCTIONS_EMULATOR ? clean(request.rawRequest.get('x-vision-test-role')) : '';
  const role = (testRole || String(request.auth?.token?.role ?? '')) as AdminRole;
  if (!allowed.includes(role)) throw new HttpsError('permission-denied', 'No tienes permiso para esta acción.');
  return { uid: request.auth?.uid ?? (process.env.FUNCTIONS_EMULATOR ? 'emulator-reviewer' : ''), role };
}

function ticketCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const chars = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
  return `VIS27-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function phone(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  const local = digits.startsWith('57') ? digits.slice(2) : digits;
  if (!/^3\d{9}$/.test(local)) throw new HttpsError('invalid-argument', 'El WhatsApp debe ser un celular colombiano válido.');
  return local;
}

function publicEvent(data: Record<string, unknown>) {
  const allowed = ['slug', 'displayName', 'year', 'date', 'startTime', 'endTime', 'venueText', 'tagline', 'heroImageUrl', 'logoUrl', 'theme', 'ticketTypes', 'closeAt', 'maxGroupSize', 'legalText', 'guardianText', 'contactWhatsapp', 'status'];
  return Object.fromEntries(allowed.filter((key) => key in data).map((key) => [key, data[key]]));
}

function validateRegistration(input: RegistrationInput, ticketTypes: TicketType[], maxGroupSize: number) {
  if (clean(input.honeypot)) throw new HttpsError('invalid-argument', 'No fue posible procesar la solicitud.');
  if (!Array.isArray(input.attendees) || input.attendees.length < 1 || input.attendees.length > maxGroupSize) {
    throw new HttpsError('invalid-argument', `La inscripción admite hasta ${maxGroupSize} personas.`);
  }
  const whatsapp = phone(input.whatsapp);
  if (!clean(input.responsible?.firstName) || !clean(input.responsible?.lastName)) {
    throw new HttpsError('invalid-argument', 'Indica nombre y apellido de la persona responsable.');
  }
  if (!input.consent?.accepted || (!input.consent?.guardian && input.attendees.some((item) => item.ticketTypeId === 'child'))) {
    throw new HttpsError('failed-precondition', 'Debes aceptar las autorizaciones requeridas.');
  }
  const types = new Map(ticketTypes.filter((item) => item.enabled).map((item) => [item.id, item]));
  let adults = 0;
  let amount = 0;
  const attendees = input.attendees.map((item) => {
    const type = types.get(item.ticketTypeId);
    if (!type || !clean(item.firstName) || !clean(item.lastName)) throw new HttpsError('invalid-argument', 'Revisa las personas inscritas.');
    const age = item.age === undefined || item.age === null || item.age === '' ? undefined : Number(item.age);
    if (age !== undefined && (!Number.isInteger(age) || age < type.ageMin || age > type.ageMax)) {
      throw new HttpsError('invalid-argument', 'Una edad no corresponde a la categoría seleccionada.');
    }
    if (type.id === 'child' && age === undefined) throw new HttpsError('invalid-argument', 'La edad es obligatoria para niños.');
    if (type.id === 'adult') adults += 1;
    amount += type.price;
    const attendee = {
      firstName: clean(item.firstName),
      lastName: clean(item.lastName),
      ticketTypeId: type.id,
      nameKey: `${nameKey(item.firstName)} ${nameKey(item.lastName)}`,
    };
    // Firestore rejects undefined values, so adult records omit `age` entirely.
    return age === undefined ? attendee : { ...attendee, age };
  });
  if (!adults) throw new HttpsError('invalid-argument', 'El grupo debe incluir al menos un adulto responsable.');
  return { whatsapp, attendees, expectedAmount: amount };
}

function assertProofRequest(contentType: unknown, size: unknown) {
  if (!proofTypes.has(String(contentType))) throw new HttpsError('invalid-argument', 'Solo se aceptan archivos JPG, PNG o PDF.');
  if (!Number.isFinite(Number(size)) || Number(size) < 1 || Number(size) > MAX_PROOF_BYTES) {
    throw new HttpsError('invalid-argument', 'El comprobante debe pesar máximo 5 MB.');
  }
}

function proofSignatureMatches(buffer: Buffer, contentType: string) {
  if (contentType === 'image/jpeg') return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (contentType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return contentType === 'application/pdf' && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

export const getEvent = onCall({ enforceAppCheck: requireAppCheck }, async (request) => {
  const eventId = clean(request.data?.eventId);
  if (!eventId) throw new HttpsError('invalid-argument', 'Edición requerida.');
  const event = await db.doc(`events/${eventId}`).get();
  if (!event.exists || event.data()?.status !== 'published') throw new HttpsError('not-found', 'La edición no está disponible.');
  return publicEvent(event.data() as Record<string, unknown>);
});

export const createRegistration = onCall({ enforceAppCheck: requireAppCheck }, async (request) => {
  const input = request.data as RegistrationInput;
  const eventId = clean(input?.eventId);
  if (!eventId) throw new HttpsError('invalid-argument', 'Edición requerida.');
  const eventRef = db.doc(`events/${eventId}`);
  const configRef = db.doc(`events/${eventId}/private/config`);
  const registrationToken = token();
  const result = await db.runTransaction(async (tx: Transaction) => {
    const [eventSnapshot, configSnapshot] = await Promise.all([tx.get(eventRef), tx.get(configRef)]);
    if (!eventSnapshot.exists || !configSnapshot.exists || eventSnapshot.data()?.status !== 'published') {
      throw new HttpsError('not-found', 'La edición no está disponible.');
    }
    const event = eventSnapshot.data()!;
    const config = configSnapshot.data()!;
    const closeAt = event.closeAt as Timestamp;
    if (!closeAt || closeAt.toMillis() < Date.now()) throw new HttpsError('failed-precondition', 'Las inscripciones ya están cerradas.');
    const registration = validateRegistration(input, event.ticketTypes as TicketType[], Number(event.maxGroupSize ?? 10));
    const capacityRef = eventRef.collection('stats').doc('capacity');
    // A test-only header lets emulator tests model distinct clients; production ignores it.
    const testIp = process.env.FUNCTIONS_EMULATOR ? clean(request.rawRequest.get('x-vision-test-ip')) : '';
    const requesterIpHash = sha256(testIp || String(request.rawRequest.ip ?? ''));
    const [capacitySnapshot, matchingWhatsapp, matchingIp] = await Promise.all([
      tx.get(capacityRef),
      tx.get(eventRef.collection('groups').where('whatsapp', '==', registration.whatsapp)),
      tx.get(eventRef.collection('groups').where('ipHash', '==', requesterIpHash))
    ]);
    const active = (snapshot: QuerySnapshot) => snapshot.docs.filter((document: QueryDocumentSnapshot) => ['held', 'pending_review'].includes(String(document.data().status))).length;
    if (active(matchingWhatsapp) >= 3 || active(matchingIp) >= 3) {
      throw new HttpsError('resource-exhausted', 'En este momento no podemos recibir más solicitudes. Escríbenos por WhatsApp para ayudarte.');
    }
    const stats = capacitySnapshot.data() ?? { held: 0, pendingReview: 0, confirmed: 0 };
    const capacity = Number(config.capacity);
    const used = Number(stats.held ?? 0) + Number(stats.pendingReview ?? 0) + Number(stats.confirmed ?? 0);
    if (used + registration.attendees.length > capacity) {
      throw new HttpsError('resource-exhausted', 'En este momento no podemos recibir más solicitudes. Escríbenos por WhatsApp para ayudarte.');
    }
    const groupRef = eventRef.collection('groups').doc();
    const paymentRef = eventRef.collection('payments').doc();
    const now = Timestamp.now();
    const holdExpiresAt = Timestamp.fromMillis(Date.now() + Number(config.holdMinutes ?? 60) * 60_000);
    tx.set(groupRef, {
      responsibleName: `${clean(input.responsible.firstName)} ${clean(input.responsible.lastName)}`,
      whatsapp: registration.whatsapp,
      ipHash: requesterIpHash,
      status: 'held',
      expectedAmount: registration.expectedAmount,
      holdExpiresAt,
      paymentId: paymentRef.id,
      attendeeCount: registration.attendees.length,
      manageTokenHash: sha256(registrationToken),
      consent: { at: now, version: clean(input.consent.version), guardian: Boolean(input.consent.guardian) },
      createdAt: now
    });
    tx.set(paymentRef, { groupId: groupRef.id, expectedAmount: registration.expectedAmount, status: 'awaiting_proof', createdAt: now });
    registration.attendees.forEach((attendee) => tx.set(eventRef.collection('attendees').doc(), { ...attendee, groupId: groupRef.id, status: 'held', createdAt: now }));
    tx.set(capacityRef, { held: Number(stats.held ?? 0) + registration.attendees.length, pendingReview: Number(stats.pendingReview ?? 0), confirmed: Number(stats.confirmed ?? 0) }, { merge: true });
    return { groupId: groupRef.id, holdExpiresAt: holdExpiresAt.toDate().toISOString(), expectedAmount: registration.expectedAmount, paymentLinkUrl: String(config.paymentLinkUrl ?? ''), paymentQrPath: String(config.paymentQrPath ?? '') };
  });
  const paymentQrUrl = result.paymentQrPath
    ? (await bucket.file(result.paymentQrPath).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 60 * 60_000 }))[0]
    : '';
  return { ...result, paymentQrUrl, manageToken: registrationToken };
});

export const createProofUpload = onCall({ enforceAppCheck: requireAppCheck }, async (request) => {
  const { eventId, groupId, token: manageToken, contentType, size } = request.data ?? {};
  assertProofRequest(contentType, size);
  const groupRef = db.doc(`events/${clean(eventId)}/groups/${clean(groupId)}`);
  const group = await groupRef.get();
  if (!group.exists || group.data()?.manageTokenHash !== sha256(clean(manageToken))) throw new HttpsError('permission-denied', 'Enlace de gestión no válido.');
  if (group.data()?.status !== 'held') throw new HttpsError('failed-precondition', 'Este grupo no puede adjuntar un comprobante.');
  const paymentId = String(group.data()?.paymentId);
  const extension = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/png' ? 'png' : 'pdf';
  const proofPath = `proofs/${clean(eventId)}/${clean(groupId)}/${paymentId}.${extension}`;
  const [uploadUrl] = await bucket.file(proofPath).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 15 * 60_000, contentType: String(contentType) });
  await db.doc(`events/${clean(eventId)}/payments/${paymentId}`).update({ proofPath, proofExpectedType: contentType, proofExpectedSize: Number(size), uploadRequestedAt: FieldValue.serverTimestamp() });
  return { uploadUrl, proofPath };
});

export const finalizeProof = onCall({ enforceAppCheck: requireAppCheck }, async (request) => {
  const { eventId, groupId, token: manageToken } = request.data ?? {};
  const eventRef = db.doc(`events/${clean(eventId)}`);
  const groupRef = eventRef.collection('groups').doc(clean(groupId));
  const group = await groupRef.get();
  if (!group.exists || group.data()?.manageTokenHash !== sha256(clean(manageToken))) throw new HttpsError('permission-denied', 'Enlace de gestión no válido.');
  const paymentRef = eventRef.collection('payments').doc(String(group.data()?.paymentId));
  const payment = await paymentRef.get();
  const proofPath = String(payment.data()?.proofPath ?? '');
  if (!proofPath) throw new HttpsError('failed-precondition', 'Primero adjunta el comprobante.');
  const [buffer] = await bucket.file(proofPath).download();
  const [metadata] = await bucket.file(proofPath).getMetadata();
  const contentType = String(metadata.contentType ?? '');
  if (buffer.length > MAX_PROOF_BYTES || !proofSignatureMatches(buffer, contentType)) {
    throw new HttpsError('invalid-argument', 'El archivo no es un comprobante válido.');
  }
  const proofHash = sha256(buffer);
  const duplicate = await eventRef.collection('payments').where('proofHash', '==', proofHash).limit(1).get();
  await db.runTransaction(async (tx: Transaction) => {
    const [freshGroup, freshPayment, config, capacity, attendees] = await Promise.all([
      tx.get(groupRef), tx.get(paymentRef), tx.get(eventRef.collection('private').doc('config')), tx.get(eventRef.collection('stats').doc('capacity')),
      tx.get(eventRef.collection('attendees').where('groupId', '==', groupRef.id))
    ]);
    if (!freshGroup.exists || !freshPayment.exists || freshGroup.data()?.status !== 'held') throw new HttpsError('failed-precondition', 'El grupo ya fue procesado.');
    const groupData = freshGroup.data()!;
    const attendeeCount = Number(groupData.attendeeCount);
    const stats = capacity.data() ?? { held: 0, pendingReview: 0, confirmed: 0 };
    const hasExpired = (groupData.holdExpiresAt as Timestamp).toMillis() < Date.now();
    const usedWithoutThisHold = Number(stats.held ?? 0) - attendeeCount + Number(stats.pendingReview ?? 0) + Number(stats.confirmed ?? 0);
    if (hasExpired && usedWithoutThisHold + attendeeCount > Number(config.data()?.capacity)) {
      tx.update(groupRef, { status: 'needs_attention' });
      tx.update(paymentRef, { status: 'needs_attention', proofHash, duplicateProof: !duplicate.empty, finalizedAt: Timestamp.now() });
      tx.update(eventRef.collection('stats').doc('capacity'), { held: Math.max(0, Number(stats.held ?? 0) - attendeeCount) });
      return;
    }
    tx.update(groupRef, { status: 'pending_review' });
    tx.update(paymentRef, { status: 'pending_review', proofHash, duplicateProof: !duplicate.empty, finalizedAt: Timestamp.now() });
    tx.update(eventRef.collection('stats').doc('capacity'), { held: Math.max(0, Number(stats.held ?? 0) - attendeeCount), pendingReview: Number(stats.pendingReview ?? 0) + attendeeCount });
    attendees.docs.forEach((attendee: QueryDocumentSnapshot) => tx.update(attendee.ref, { status: 'pending_review' }));
  });
  return { status: 'pending_review' };
});

export const getTicket = onCall({ enforceAppCheck: requireAppCheck }, async (request) => {
  const ticketToken = clean(request.data?.ticketToken);
  if (!ticketToken) throw new HttpsError('invalid-argument', 'Boleta requerida.');
  const match = await db.collectionGroup('tickets').where('token', '==', ticketToken).limit(1).get();
  if (match.empty) throw new HttpsError('not-found', 'La boleta no está disponible.');
  const ticket = match.docs[0].data();
  const eventId = match.docs[0].ref.parent.parent?.id;
  const event = eventId ? await db.doc(`events/${eventId}`).get() : undefined;
  if (!event?.exists) throw new HttpsError('not-found', 'La boleta no está disponible.');
  return {
    displayName: event.data()?.displayName,
    year: event.data()?.year,
    date: event.data()?.date,
    venueText: event.data()?.venueText,
    attendeeName: ticket.attendeeName,
    ticketTypeId: ticket.ticketTypeId,
    code: ticket.code,
    status: ticket.status
  };
});

export const adminDashboard = onCall({ enforceAppCheck: requireAppCheck }, async (request) => {
  adminActor(request as AdminRequest, ['owner', 'reviewer', 'viewer']);
  const eventId = clean(request.data?.eventId);
  if (!eventId) throw new HttpsError('invalid-argument', 'Edición requerida.');
  const eventRef = db.doc(`events/${eventId}`);
  const [event, capacity, finance, pendingPayments] = await Promise.all([
    eventRef.get(),
    eventRef.collection('stats').doc('capacity').get(),
    eventRef.collection('stats').doc('finance').get(),
    eventRef.collection('payments').where('status', '==', 'pending_review').orderBy('finalizedAt', 'asc').get()
  ]);
  if (!event.exists) throw new HttpsError('not-found', 'La edición no existe.');
  return {
    event: publicEvent(event.data() as Record<string, unknown>),
    capacity: capacity.data() ?? { held: 0, pendingReview: 0, confirmed: 0 },
    finance: finance.data() ?? { approvedTotal: 0, approvedPayments: 0 },
    pendingPayments: pendingPayments.docs.map((payment) => ({ id: payment.id, groupId: payment.data().groupId, expectedAmount: payment.data().expectedAmount, duplicateProof: Boolean(payment.data().duplicateProof) }))
  };
});

export const approvePayment = onCall({ enforceAppCheck: requireAppCheck }, async (request) => {
  const actor = adminActor(request as AdminRequest, ['owner', 'reviewer']);
  const eventId = clean(request.data?.eventId);
  const paymentId = clean(request.data?.paymentId);
  const receivedAmount = Number(request.data?.receivedAmount);
  if (!eventId || !paymentId || !Number.isSafeInteger(receivedAmount) || receivedAmount < 0) {
    throw new HttpsError('invalid-argument', 'Datos de aprobación inválidos.');
  }
  const eventRef = db.doc(`events/${eventId}`);
  const paymentRef = eventRef.collection('payments').doc(paymentId);
  return db.runTransaction(async (tx: Transaction) => {
    const payment = await tx.get(paymentRef);
    if (!payment.exists || payment.data()?.status !== 'pending_review') {
      throw new HttpsError('failed-precondition', 'El pago no está pendiente de revisión.');
    }
    const paymentData = payment.data()!;
    const groupRef = eventRef.collection('groups').doc(String(paymentData.groupId));
    const [group, attendees, capacity, finance] = await Promise.all([
      tx.get(groupRef),
      tx.get(eventRef.collection('attendees').where('groupId', '==', groupRef.id)),
      tx.get(eventRef.collection('stats').doc('capacity')),
      tx.get(eventRef.collection('stats').doc('finance'))
    ]);
    if (!group.exists || group.data()?.status !== 'pending_review' || !attendees.size) {
      throw new HttpsError('failed-precondition', 'La inscripción no está lista para aprobación.');
    }
    const expectedAmount = Number(paymentData.expectedAmount);
    if (receivedAmount !== expectedAmount) {
      throw new HttpsError('failed-precondition', 'El monto recibido no coincide; márcalo como incompleto o recházalo.');
    }
    const now = Timestamp.now();
    const ticketRows = attendees.docs.map((attendee) => ({
      attendee,
      ref: eventRef.collection('tickets').doc(),
      code: ticketCode(),
      token: token()
    }));
    const stats = capacity.data() ?? { held: 0, pendingReview: 0, confirmed: 0 };
    const financeData = finance.data() ?? { approvedTotal: 0, approvedPayments: 0 };
    const auditRef = eventRef.collection('auditLog').doc();
    const communicationRef = eventRef.collection('communications').doc();

    tx.update(paymentRef, { status: 'approved', approvedAmount: receivedAmount, reviewedBy: actor.uid, reviewedAt: now });
    tx.update(groupRef, { status: 'confirmed', confirmedAt: now });
    tx.set(eventRef.collection('stats').doc('capacity'), {
      held: Number(stats.held ?? 0),
      pendingReview: Math.max(0, Number(stats.pendingReview ?? 0) - attendees.size),
      confirmed: Number(stats.confirmed ?? 0) + attendees.size
    }, { merge: true });
    tx.set(eventRef.collection('stats').doc('finance'), {
      approvedTotal: Number(financeData.approvedTotal ?? 0) + receivedAmount,
      approvedPayments: Number(financeData.approvedPayments ?? 0) + 1
    }, { merge: true });
    ticketRows.forEach(({ attendee, ref, code, token: ticketToken }) => {
      const attendeeData = attendee.data();
      tx.update(attendee.ref, { status: 'confirmed', ticketId: ref.id });
      tx.set(ref, {
        attendeeId: attendee.id,
        groupId: groupRef.id,
        attendeeName: `${attendeeData.firstName} ${attendeeData.lastName}`,
        ticketTypeId: attendeeData.ticketTypeId,
        code,
        token: ticketToken,
        status: 'active',
        issuedAt: now,
        checkIn: { at: null, by: null }
      });
    });
    tx.set(auditRef, { actorUid: actor.uid, action: 'payment_approved', targetRef: paymentRef.path, at: now, detail: { receivedAmount, ticketCount: ticketRows.length } });
    tx.set(communicationRef, { groupId: groupRef.id, channel: 'whatsapp', status: 'prepared', preparedBy: actor.uid, preparedAt: now, ticketIds: ticketRows.map(({ ref }) => ref.id) });
    return { paymentId, ticketCount: ticketRows.length, tickets: ticketRows.map(({ code, token: ticketToken }) => ({ code, ticketToken })) };
  });
});
