import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCapacityLedger, calculateRegistration, capacityAllows, isClosed, validateProofMetadata } from '../shared/registration-domain.mjs';

const ticketTypes = [
  { id: 'adult', price: 70000, ageMin: 12, ageMax: 120, enabled: true },
  { id: 'child', price: 35000, ageMin: 2, ageMax: 11, enabled: true }
];
const consent = { accepted: true, guardian: true };

test('un grupo de dos adultos y dos niños totaliza 210.000 COP', () => {
  const result = calculateRegistration({
    ticketTypes, consent, whatsapp: '+57 304 322 9348',
    responsible: { firstName: 'Ana', lastName: 'Ruiz' },
    attendees: [
      { firstName: 'Ana', lastName: 'Ruiz', ticketTypeId: 'adult' },
      { firstName: 'Luis', lastName: 'Ruiz', ticketTypeId: 'adult' },
      { firstName: 'Sofía', lastName: 'Ruiz', ticketTypeId: 'child', age: 8 },
      { firstName: 'Mateo', lastName: 'Ruiz', ticketTypeId: 'child', age: 4 }
    ]
  });
  assert.equal(result.expectedAmount, 210000);
  assert.equal(result.whatsapp, '3043229348');
  assert.equal(result.attendees.length, 4);
});

test('rechaza una edad incompatible con la categoría', () => {
  assert.throws(() => calculateRegistration({
    ticketTypes, consent, whatsapp: '3043229348', responsible: { firstName: 'Ana', lastName: 'Ruiz' },
    attendees: [{ firstName: 'Ana', lastName: 'Ruiz', ticketTypeId: 'child', age: 12 }]
  }), /no corresponde/);
});

test('cincuenta solicitudes concurrentes no superan un aforo reducido', async () => {
  const ledger = new InMemoryCapacityLedger(17);
  const results = await Promise.all(Array.from({ length: 50 }, () => ledger.reserve(1)));
  assert.equal(results.filter(Boolean).length, 17);
  assert.deepEqual(ledger.snapshot(), { held: 17, pendingReview: 0, confirmed: 0 });
  assert.equal(capacityAllows({ held: 17, pendingReview: 0, confirmed: 0 }, 1, 17), false);
});

test('cierre y metadatos inválidos de comprobante se rechazan', () => {
  assert.equal(isClosed('2026-12-05T23:59:59-05:00', new Date('2026-12-06T05:00:00Z')), true);
  assert.throws(() => validateProofMetadata({ contentType: 'text/plain', size: 100 }), /JPG/);
  assert.throws(() => validateProofMetadata({ contentType: 'image/png', size: 6 * 1024 * 1024 }), /5 MB/);
});
