/**
 * OpenRouter's browser OAuth (PKCE, S256), so a user authorizes there instead
 * of pasting a key into the editor. Everything provider-neutral lives in
 * `client.ts`; the other provider (OpenAI) has no such flow and takes a key.
 */
import { apiError, attributionHeaders } from './client';
import { AI_PROVIDERS, OPENROUTER_ORIGIN, sessionGet, sessionSet } from './providers';

const API = AI_PROVIDERS.openrouter.api;

const OAUTH_MARKER = 'gr_openrouter';
const OAUTH_VERIFIER_STORAGE = 'gnuradio-world.openrouter-oauth-verifier';
const OAUTH_REMEMBER_STORAGE = 'gnuradio-world.openrouter-oauth-remember';
const OAUTH_GRAPH_STORAGE = 'gnuradio-world.openrouter-oauth-graph';
const OAUTH_HASH_STORAGE = 'gnuradio-world.openrouter-oauth-hash';

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function openRouterAuthorizationUrl(callbackUrl: string, challenge: string): string {
  const url = new URL(`${OPENROUTER_ORIGIN}/auth`);
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Starts OpenRouter's browser OAuth flow while keeping the canvas recoverable. */
export async function beginOpenRouterOAuth(graphState: string, remember: boolean): Promise<void> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  const callback = new URL(location.href);
  callback.searchParams.delete('code');
  callback.searchParams.set(OAUTH_MARKER, '1');
  callback.hash = '';
  sessionSet(OAUTH_VERIFIER_STORAGE, verifier);
  sessionSet(OAUTH_REMEMBER_STORAGE, remember ? 'yes' : 'no');
  sessionSet(OAUTH_GRAPH_STORAGE, graphState);
  sessionSet(OAUTH_HASH_STORAGE, location.hash);
  if (sessionGet(OAUTH_VERIFIER_STORAGE) !== verifier ||
      sessionGet(OAUTH_GRAPH_STORAGE) !== graphState) {
    for (const key of [OAUTH_VERIFIER_STORAGE, OAUTH_REMEMBER_STORAGE,
      OAUTH_GRAPH_STORAGE, OAUTH_HASH_STORAGE]) sessionSet(key, '');
    throw new Error('OpenRouter connection needs session storage; paste a key instead');
  }
  location.assign(openRouterAuthorizationUrl(callback.toString(), challenge));
}

export interface OpenRouterOAuthReturn {
  code: string;
  verifier: string;
  remember: boolean;
  graphState: string;
}

/** Reads and removes a one-time OAuth return, restoring the pre-redirect URL. */
export function takeOpenRouterOAuthReturn(): OpenRouterOAuthReturn | null {
  if (typeof location === 'undefined') return null;
  const url = new URL(location.href);
  if (url.searchParams.get(OAUTH_MARKER) !== '1') return null;
  const result = {
    code: url.searchParams.get('code') || '',
    verifier: sessionGet(OAUTH_VERIFIER_STORAGE),
    remember: sessionGet(OAUTH_REMEMBER_STORAGE) === 'yes',
    graphState: sessionGet(OAUTH_GRAPH_STORAGE),
  };
  const originalHash = sessionGet(OAUTH_HASH_STORAGE);
  for (const key of [OAUTH_VERIFIER_STORAGE, OAUTH_REMEMBER_STORAGE,
    OAUTH_GRAPH_STORAGE, OAUTH_HASH_STORAGE]) sessionSet(key, '');
  url.searchParams.delete('code');
  url.searchParams.delete(OAUTH_MARKER);
  url.hash = originalHash;
  history.replaceState(null, '', url);
  return result;
}

export async function exchangeOpenRouterCode(
  code: string, verifier: string, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`${API}/auth/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...attributionHeaders() },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256',
    }),
  });
  if (!response.ok) throw apiError(AI_PROVIDERS.openrouter, response.status, await response.text());
  const payload = await response.json();
  const key = String(payload?.key || '').trim();
  if (!key) throw new Error('OpenRouter did not return an API key');
  return key;
}
