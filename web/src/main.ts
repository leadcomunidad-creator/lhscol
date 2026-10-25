import { appCheckToken } from './app-check';

type Attendee = { firstName: string; lastName: string; ticketTypeId: 'adult' | 'child'; age?: number };
type FunctionResult<T> = { result: T };

const env = import.meta.env as Record<string, string | undefined>;
const functionBaseUrl = env.VITE_FUNCTIONS_BASE_URL?.replace(/\/$/, '');
const eventId = env.VITE_EVENT_ID;
type RegistrationState = { groupId: string; manageToken: string; paymentLinkUrl: string; paymentQrUrl: string };
let registrationState: RegistrationState | undefined;

async function call<T>(name: string, data: unknown): Promise<T> {
  if (!functionBaseUrl) throw new Error('La inscripción aún no está configurada.');
  const response = await fetch(`${functionBaseUrl}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Firebase-AppCheck': await appCheckToken() }, body: JSON.stringify({ data })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? 'No fue posible procesar la solicitud.');
  return (body as FunctionResult<T>).result;
}

function readAttendees(): Attendee[] {
  const adults = Number(document.querySelector<HTMLOutputElement>('#na')?.textContent ?? 0);
  const children = Number(document.querySelector<HTMLOutputElement>('#nn')?.textContent ?? 0);
  const value = (name: string) => (document.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? '').trim();
  const attendees: Attendee[] = [];
  for (let i = 1; i <= adults; i += 1) attendees.push({ firstName: value(`a${i}n`), lastName: value(`a${i}l`), ticketTypeId: 'adult' });
  for (let i = 1; i <= children; i += 1) attendees.push({ firstName: value(`n${i}n`), lastName: value(`n${i}l`), ticketTypeId: 'child', age: Number(value(`n${i}e`)) });
  return attendees;
}

function readRegistrationInput() {
  return {
    eventId,
    responsible: { firstName: document.querySelector<HTMLInputElement>('[name="a1n"]')?.value ?? '', lastName: document.querySelector<HTMLInputElement>('[name="a1l"]')?.value ?? '' },
    whatsapp: document.querySelector<HTMLInputElement>('[name="wa"]')?.value ?? '',
    attendees: readAttendees(),
    consent: { accepted: document.querySelector<HTMLInputElement>('#c1')?.checked ?? false, guardian: document.querySelector<HTMLInputElement>('#c2')?.checked ?? false, version: 'provisional-2026-10-25' },
    honeypot: ''
  };
}

function formIsComplete() {
  const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#frm input[required], #frm select[required]'));
  const invalid = fields.filter((field) => !field.value.trim());
  fields.forEach((field) => field.setAttribute('aria-invalid', invalid.includes(field) ? 'true' : 'false'));
  const consent = document.querySelector<HTMLInputElement>('#c1')?.checked && (Number(document.querySelector('#nn')?.textContent ?? 0) === 0 || document.querySelector<HTMLInputElement>('#c2')?.checked);
  return invalid.length === 0 && consent;
}

async function startRegistration() {
  const message = document.querySelector<HTMLElement>('#m3');
  if (!message || !eventId) return;
  if (!formIsComplete()) {
    message.textContent = 'Revisa los campos marcados y las autorizaciones para continuar.';
    return;
  }
  message.textContent = 'Preparando tu inscripción…';
  try {
    registrationState = await call<RegistrationState>('createRegistration', readRegistrationInput());
    const paymentLink = document.querySelector<HTMLAnchorElement>('#paymentLink');
    if (paymentLink && registrationState.paymentLinkUrl) paymentLink.href = registrationState.paymentLinkUrl;
    const paymentQr = document.querySelector<HTMLImageElement>('.qr img');
    if (paymentQr && registrationState.paymentQrUrl) {
      paymentQr.src = registrationState.paymentQrUrl;
      document.querySelector<HTMLElement>('#paymentQrContainer')?.removeAttribute('hidden');
    }
    sessionStorage.setItem('vision-manage', JSON.stringify({ eventId, groupId: registrationState.groupId, token: registrationState.manageToken }));
    (window as unknown as { go: (step: number) => void }).go(4);
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'No fue posible preparar la inscripción.';
  }
}

async function submitRegistration() {
  const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
  const message = document.querySelector<HTMLElement>('#fmsg');
  const button = document.querySelector<HTMLButtonElement>('#send');
  if (!file || !message || !button || !eventId || !registrationState) {
    if (message) message.textContent = 'Vuelve al paso anterior para preparar tu inscripción.';
    return;
  }
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Enviando…';
  message.textContent = '';
  try {
    const upload = await call<{ uploadUrl: string }>('createProofUpload', { eventId, groupId: registrationState.groupId, token: registrationState.manageToken, contentType: file.type, size: file.size });
    const uploadResponse = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!uploadResponse.ok) throw new Error('No fue posible subir el comprobante.');
    await call('finalizeProof', { eventId, groupId: registrationState.groupId, token: registrationState.manageToken });
    (window as unknown as { go: (step: number) => void }).go(5);
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'No fue posible enviar la inscripción.';
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

document.querySelector('#send')?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  void submitRegistration();
}, true);

document.querySelector('#frm')?.addEventListener('submit', (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  void startRegistration();
}, true);
