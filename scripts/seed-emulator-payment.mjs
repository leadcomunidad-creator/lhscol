import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localConfigPath = resolve(root, 'test-data', 'payment.local.json');
const functionsRequire = createRequire(resolve(root, 'functions', 'package.json'));
const { Firestore } = functionsRequire('@google-cloud/firestore');
const { Storage } = functionsRequire('@google-cloud/storage');

export async function readLocalPaymentData() {
  const config = JSON.parse(await readFile(localConfigPath, 'utf8'));
  if (!String(config.paymentLinkUrl).startsWith('https://')) throw new Error('payment.local.json debe contener un enlace HTTPS.');
  const paymentQrSource = resolve(root, 'test-data', String(config.paymentQrSource ?? ''));
  const paymentQr = await readFile(paymentQrSource);
  if (!paymentQr.length) throw new Error('El QR local de pruebas está vacío.');
  return { paymentLinkUrl: String(config.paymentLinkUrl), paymentQr };
}

export async function seedPrivatePayment({ db, storage, eventId, capacity, holdMinutes = 60 }) {
  const { paymentLinkUrl, paymentQr } = await readLocalPaymentData();
  const paymentQrPath = `private-payment/${eventId}/payment-qr.png`;
  const bucketName = `${storage.projectId}.firebasestorage.app`;
  await storage.bucket(bucketName).file(paymentQrPath).save(paymentQr, { contentType: 'image/png', resumable: false });
  await db.doc(`events/${eventId}/private/config`).set({ capacity, holdMinutes, paymentLinkUrl, paymentQrPath });
  return { paymentQrPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectId = process.env.GCLOUD_PROJECT ?? 'demo-lhscol-vision';
  const eventId = process.argv[2];
  if (!eventId || !process.env.FIRESTORE_EMULATOR_HOST || !process.env.STORAGE_EMULATOR_HOST) {
    throw new Error('Uso: con los emuladores activos, define FIRESTORE_EMULATOR_HOST y STORAGE_EMULATOR_HOST y ejecuta seed:emulator <eventId>.');
  }
  const db = new Firestore({ projectId });
  const storage = new Storage({ projectId, apiEndpoint: `http://${process.env.STORAGE_EMULATOR_HOST.replace(/^https?:\/\//, '')}` });
  await seedPrivatePayment({ db, storage, eventId, capacity: 300 });
  await db.terminate();
  process.stdout.write(`Datos privados de pago cargados localmente para ${eventId}.\n`);
}
