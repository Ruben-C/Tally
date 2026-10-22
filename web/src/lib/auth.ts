import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, ApiError } from './api';

export type AuthState = { authenticated: boolean; hasPasskeys: boolean; fresh: boolean };
export const authState = () => api<AuthState>('/auth/state');

// Sign in, or (when already signed in) re-verify to unlock sensitive actions.
export async function login() {
  const options = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/login/options', { body: {} });
  const response = await startAuthentication({ optionsJSON: options });
  await api('/login/verify', { body: { response } });
}

export async function setup(code: string, name: string) {
  const options = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('/setup/options', { body: { code } });
  const response = await startRegistration({ optionsJSON: options });
  await api('/setup/verify', { body: { code, response, name } });
}

export async function addPasskey(name: string) {
  const options = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('/passkeys/options', { body: {} });
  const response = await startRegistration({ optionsJSON: options });
  await api('/passkeys/verify', { body: { response, name } });
}

// Runs fn; if the server wants a fresh passkey check first, does it and retries once.
export async function withFreshAuth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && /reauth/.test(e.message)) {
      await login();
      return fn();
    }
    throw e;
  }
}

export const deviceName = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
};
