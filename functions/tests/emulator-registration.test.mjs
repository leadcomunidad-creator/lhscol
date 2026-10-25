import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { seedPrivatePayment } from '../../scripts/seed-emulator-payment.mjs';

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-lhscol-vision';
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const functionsBase = `http://127.0.0.1:5001/${projectId}/southamerica-east1`;
const ephemeralCredentials = (() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { client_email: 'emulator-only@localhost', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
})();
const db = emulatorHost ? new Firestore({ projectId, servicePath: '127.0.0.1', port: 8080, ssl: false, credentials: ephemeralCredentials }) : undefined;
const storage = emulatorHost ? new Storage({ projectId, credentials: ephemeralCredentials, apiEndpoint: 'http://127.0.0.1:9199' }) : undefined;

const ticketTypes = [
  { id: 'adult', label: 'Adulto', price: 70000, ageMin: 12, ageMax: 120, enabled: true, countsTowardCapacity: true },
  { id: 'child', label: 'Niño', price: 35000, ageMin: 2, ageMax: 11, enabled: true, countsTowardCapacity: true }
];

async function callable(name, data, headers = {}) {
  const response = await fetch(`${functionsBase}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ data })
  });
  return { response, body: await response.json() };
}

async function seedEvent(capacity, { deliverQr = true } = {}) {
  const eventId = `test-${randomUUID()}`;
  const event = db.doc(`events/${eventId}`);
  await event.set({
    slug: eventId,
    displayName: 'Visión',
    year: '2027',
    date: '2026-12-19',
    startTime: '18:00',
    endTime: '21:00',
    venueText: 'Auditorio Fundación Batuta, Manizales, Caldas',
    tagline: 'Celebramos lo vivido. Descubrimos lo que viene.',
    ticketTypes,
    closeAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
    maxGroupSize: 10,
    legalText: 'Texto provisional',
    guardianText: 'Autorización de acudiente',
    contactWhatsapp: '3043229348',
    status: 'published'
  });
  await seedPrivatePayment({ db, storage, eventId, capacity });
  if (!deliverQr) await event.collection('private').doc('config').update({ paymentQrPath: '' });
  await event.collection('stats').doc('capacity').set({ held: 0, pendingReview: 0, confirmed: 0 });
  return eventId;
}

function registration(eventId, phone, people) {
  return {
    eventId,
    responsible: { firstName: 'Ana', lastName: 'Ruiz' },
    whatsapp: phone,
    attendees: people,
    consent: { accepted: true, guardian: people.some((person) => person.ticketTypeId === 'child'), version: 'test' },
    honeypot: ''
  };
}

if (!emulatorHost) {
  test('las pruebas de emulador requieren FIRESTORE_EMULATOR_HOST', { skip: true }, () => {});
} else {
  test('getEvent no expone pago y una inscripción de 2 adultos + 2 niños suma 210.000 COP', async () => {
    const eventId = await seedEvent(30);
    const publicEvent = await callable('getEvent', { eventId });
    assert.equal(publicEvent.response.status, 200);
    assert.equal(Object.hasOwn(publicEvent.body.result, 'paymentLinkUrl'), false);
    assert.equal(Object.hasOwn(publicEvent.body.result, 'paymentQrPath'), false);
    const people = [
      { firstName: 'Ana', lastName: 'Ruiz', ticketTypeId: 'adult' },
      { firstName: 'Luis', lastName: 'Ruiz', ticketTypeId: 'adult' },
      { firstName: 'Sofía', lastName: 'Ruiz', ticketTypeId: 'child', age: 8 },
      { firstName: 'Mateo', lastName: 'Ruiz', ticketTypeId: 'child', age: 4 }
    ];
    const created = await callable('createRegistration', registration(eventId, '3043229348', people), { 'x-vision-test-ip': '10.0.0.1' });
    assert.equal(created.response.status, 200);
    assert.equal(created.body.result.expectedAmount, 210000);
    assert.match(created.body.result.paymentLinkUrl, /^https:\/\//);
    assert.match(created.body.result.paymentQrUrl, /^https?:\/\//);
    const event = db.doc(`events/${eventId}`);
    const [groups, attendees, payments] = await Promise.all([
      event.collection('groups').get(), event.collection('attendees').get(), event.collection('payments').get()
    ]);
    assert.equal(groups.size, 1);
    assert.equal(attendees.size, 4);
    assert.equal(payments.size, 1);
    assert.equal(payments.docs[0].data().expectedAmount, 210000);
    const invalidProof = await callable('createProofUpload', { eventId, groupId: created.body.result.groupId, token: created.body.result.manageToken, contentType: 'text/plain', size: 10 });
    assert.equal(invalidProof.response.status, 400);
  });

  test('50 reservas simultáneas usan transacciones de Firestore sin superar aforo reducido', async () => {
    const eventId = await seedEvent(17, { deliverQr: false });
    const oneAdult = [{ firstName: 'Persona', lastName: 'Prueba', ticketTypeId: 'adult' }];
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => callable(
      'createRegistration',
      registration(eventId, `300000${String(index).padStart(4, '0')}`, oneAdult),
      { 'x-vision-test-ip': `10.0.1.${index + 1}` }
    )));
    const accepted = results.filter(({ response }) => response.status === 200).length;
    assert.ok(accepted > 0 && accepted <= 17, 'ninguna de las 50 transacciones puede superar el aforo de 17');
    const stats = (await db.doc(`events/${eventId}/stats/capacity`).get()).data();
    assert.deepEqual(stats, { held: accepted, pendingReview: 0, confirmed: 0 });
  });

  test('un reviewer aprueba una vez, emite 4 boletas, registra ingreso e historial', async () => {
    const eventId = await seedEvent(30);
    const people = [
      { firstName: 'Ana', lastName: 'Ruiz', ticketTypeId: 'adult' },
      { firstName: 'Luis', lastName: 'Ruiz', ticketTypeId: 'adult' },
      { firstName: 'Sofía', lastName: 'Ruiz', ticketTypeId: 'child', age: 8 },
      { firstName: 'Mateo', lastName: 'Ruiz', ticketTypeId: 'child', age: 4 }
    ];
    const created = await callable('createRegistration', registration(eventId, '3043229348', people), { 'x-vision-test-ip': '10.0.2.1' });
    assert.equal(created.response.status, 200);
    const event = db.doc(`events/${eventId}`);
    const group = event.collection('groups').doc(created.body.result.groupId);
    const paymentId = String((await group.get()).data().paymentId);
    const attendees = await event.collection('attendees').where('groupId', '==', group.id).get();
    const batch = db.batch();
    batch.update(group, { status: 'pending_review' });
    batch.update(event.collection('payments').doc(paymentId), { status: 'pending_review' });
    attendees.docs.forEach((attendee) => batch.update(attendee.ref, { status: 'pending_review' }));
    batch.set(event.collection('stats').doc('capacity'), { held: 0, pendingReview: 4, confirmed: 0 });
    batch.set(event.collection('stats').doc('finance'), { approvedTotal: 0, approvedPayments: 0 });
    await batch.commit();

    const denied = await callable('approvePayment', { eventId, paymentId, receivedAmount: 210000 });
    assert.equal(denied.response.status, 403);
    const approved = await callable('approvePayment', { eventId, paymentId, receivedAmount: 210000 }, { 'x-vision-test-role': 'reviewer' });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.body.result.ticketCount, 4);
    const [tickets, finance, capacity, auditLog, communications, payment] = await Promise.all([
      event.collection('tickets').get(), event.collection('stats').doc('finance').get(), event.collection('stats').doc('capacity').get(),
      event.collection('auditLog').get(), event.collection('communications').get(), event.collection('payments').doc(paymentId).get()
    ]);
    assert.equal(tickets.size, 4);
    assert.deepEqual(finance.data(), { approvedTotal: 210000, approvedPayments: 1 });
    assert.deepEqual(capacity.data(), { held: 0, pendingReview: 0, confirmed: 4 });
    assert.equal(payment.data().status, 'approved');
    assert.equal(auditLog.size, 1);
    assert.equal(auditLog.docs[0].data().action, 'payment_approved');
    assert.equal(communications.size, 1);
    assert.equal(communications.docs[0].data().status, 'prepared');
    const ticket = await callable('getTicket', { ticketToken: approved.body.result.tickets[0].ticketToken });
    assert.equal(ticket.response.status, 200);
    assert.match(ticket.body.result.code, /^VIS27-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const repeat = await callable('approvePayment', { eventId, paymentId, receivedAmount: 210000 }, { 'x-vision-test-role': 'reviewer' });
    assert.equal(repeat.response.status, 400);
  });

  test.after(async () => db.terminate());
}
