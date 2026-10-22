// AES-256-GCM for Plaid access tokens at rest. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
import crypto from 'node:crypto';
import { config } from './config.js';

const key = Buffer.from(config.TOKEN_ENC_KEY, 'hex');

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function open(sealed) {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1') throw new Error('unknown token format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
