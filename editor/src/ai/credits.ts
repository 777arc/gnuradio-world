import { CREDITS_ORIGIN } from './providers';

export interface CreditAccount {
  user: { id: string; name: string; email: string; image?: string | null };
  wallet: {
    balance_micros: number;
    held_micros: number;
    available_micros: number;
    frozen: number;
  };
}

export const CREDIT_PACKS = [5, 10, 25, 50, 100].map(dollars => ({
  dollars,
  slug: `credits-${dollars}`,
}));

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${CREDITS_ORIGIN}${path}`, { ...init, credentials: 'include' });
}

interface RedirectPayload { url?: string; error?: { message?: string } }

async function redirectUrl(response: Response, fallback: string): Promise<string> {
  let payload: RedirectPayload;
  try {
    payload = await response.json() as RedirectPayload;
  } catch {
    throw new Error(`${fallback} (the credits service returned an empty or invalid response)`);
  }
  if (!response.ok || !payload.url) throw new Error(payload.error?.message || fallback);
  return payload.url;
}

export async function creditAccount(): Promise<CreditAccount | null> {
  const response = await api('/api/me');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Could not load the credits account (${response.status})`);
  return response.json();
}

export async function beginCreditSignIn(provider: 'google' | 'github'): Promise<void> {
  const callbackURL = location.origin + location.pathname + location.hash;
  const response = await api('/api/auth/sign-in/social', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // Better Auth otherwise adds a Location header. fetch() follows it to the
    // OAuth provider, where the cross-origin response body is unavailable for
    // this code to read. Ask for the authorization URL as JSON and navigate
    // the top-level page ourselves.
    body: JSON.stringify({ provider, callbackURL, disableRedirect: true }),
  });
  location.assign(await redirectUrl(response, `Could not start ${provider} sign-in`));
}

export async function beginCreditCheckout(slug: string): Promise<void> {
  const response = await api('/api/auth/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  location.assign(await redirectUrl(response, 'Could not start checkout'));
}

export async function openCreditPortal(): Promise<void> {
  const response = await api('/api/auth/customer/portal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect: true }),
  });
  location.assign(await redirectUrl(response, 'Could not open customer portal'));
}

export async function signOutCredits(): Promise<void> {
  const response = await api('/api/auth/sign-out', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!response.ok) throw new Error('Could not sign out');
}
