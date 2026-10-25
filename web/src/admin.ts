import { GoogleAuthProvider, getAuth, getIdToken, signInWithPopup } from 'firebase/auth';
import { appCheckToken, configuredFirebaseApp } from './app-check';

type Dashboard = { capacity: { held: number; pendingReview: number; confirmed: number }; finance: { approvedTotal: number }; pendingPayments: { id: string; groupId: string; expectedAmount: number; duplicateProof: boolean }[] };
const env = import.meta.env as Record<string, string | undefined>;
const baseUrl = env.VITE_FUNCTIONS_BASE_URL?.replace(/\/$/, '');
const message = document.querySelector<HTMLElement>('#message')!;
const eventIdInput = document.querySelector<HTMLInputElement>('#eventId')!;
let idToken = '';

async function call<T>(name: string, data: unknown): Promise<T> {
  if (!baseUrl || !idToken) throw new Error('Inicia sesión y configura el panel antes de continuar.');
  const response = await fetch(`${baseUrl}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}`, 'X-Firebase-AppCheck': await appCheckToken() }, body: JSON.stringify({ data }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? 'No fue posible completar la acción.');
  return body.result as T;
}

function money(value: number) { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value); }

function render(data: Dashboard) {
  document.querySelector('#held')!.textContent = String(data.capacity.held);
  document.querySelector('#pending')!.textContent = String(data.capacity.pendingReview);
  document.querySelector('#confirmed')!.textContent = String(data.capacity.confirmed);
  document.querySelector('#income')!.textContent = money(data.finance.approvedTotal);
  const list = document.querySelector<HTMLUListElement>('#payments')!;
  list.replaceChildren(...data.pendingPayments.map((payment) => {
    const item = document.createElement('li');
    item.className = 'payment';
    item.innerHTML = `<span>Pago ${payment.id.slice(0, 8)} · ${money(payment.expectedAmount)}${payment.duplicateProof ? ' · posible duplicado' : ''}</span>`;
    const button = document.createElement('button');
    button.textContent = 'Aprobar';
    button.onclick = async () => { await approve(payment); };
    item.append(button);
    return item;
  }));
  if (!data.pendingPayments.length) list.innerHTML = '<li class="muted">No hay pagos pendientes.</li>';
}

async function refresh() {
  try { render(await call<Dashboard>('adminDashboard', { eventId: eventIdInput.value.trim() })); message.textContent = 'Resumen actualizado.'; }
  catch (error) { message.textContent = error instanceof Error ? error.message : 'No fue posible cargar el panel.'; }
}

async function approve(payment: Dashboard['pendingPayments'][number]) {
  if (!confirm(`¿Aprobar ${money(payment.expectedAmount)}?`)) return;
  try { await call('approvePayment', { eventId: eventIdInput.value.trim(), paymentId: payment.id, receivedAmount: payment.expectedAmount }); await refresh(); message.textContent = 'Pago aprobado y boletas emitidas.'; }
  catch (error) { message.textContent = error instanceof Error ? error.message : 'No fue posible aprobar.'; }
}

document.querySelector('#signIn')?.addEventListener('click', async () => {
  try { const credential = await signInWithPopup(getAuth(configuredFirebaseApp()), new GoogleAuthProvider()); idToken = await getIdToken(credential.user, true); message.textContent = 'Sesión iniciada. Carga la edición.'; }
  catch (error) { message.textContent = error instanceof Error ? error.message : 'No fue posible iniciar sesión.'; }
});
document.querySelector('#refresh')?.addEventListener('click', () => void refresh());
