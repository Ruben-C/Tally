// Passkey-only auth: no passwords and no third-party identity provider.
// The only way to register a passkey without already being logged in is a
// one-time setup code minted on the host (`node src/setup-code.js` inside the container).
// Its own passkeys and sessions: nothing here is shared with any other app.
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { load, save, audit } from './store.js';

// config.js fills these in (defaults included) before this module loads.
export const RP_ID = process.env.RP_ID;
export const ORIGIN = process.env.ORIGIN;
const RP_NAME = 'Tally';

const SESSION_COOKIE = '__Host-tally_session';
const CEREMONY_COOKIE = '__Host-tally_ceremony';
const SESSION_IDLE_MS = 24 * 3600e3;
const SESSION_MAX_MS = 7 * 24 * 3600e3;
const FRESH_AUTH_MS = 15 * 60e3;
const CEREMONY_TTL_MS = 5 * 60e3;
export const SETUP_CODE_TTL_MS = 15 * 60e3;
export const SETUP_CODE_MAX_TTL_MS = 48 * 3600e3;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const b64 = (u8) => Buffer.from(u8).toString('base64url');

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ---- state ------------------------------------------------------------------

// credentials.json: { userID, passkeys: [{ id, publicKey, counter, transports, name, createdAt, lastUsedAt }] }
const loadCreds = () => load('credentials.json', { userID: null, passkeys: [] });
// sessions.json: { [sha256(token)]: { createdAt, lastSeenAt, authAt, ip, ua } }
let sessions = load('sessions.json', {});
const saveSessions = () => save('sessions.json', sessions);

// In-memory WebAuthn ceremonies, keyed by a random cookie: { challenge, kind, expires }
const ceremonies = new Map();

// ---- setup codes ------------------------------------------------------------

export function mintSetupCode({ reset = false, ttlMs = SETUP_CODE_TTL_MS } = {}) {
  ttlMs = Math.min(Math.max(ttlMs, 60e3), SETUP_CODE_MAX_TTL_MS);
  const code = token(18); // 144 bits
  if (reset) {
    save('credentials.json', { userID: null, passkeys: [] });
    sessions = {};
    saveSessions();
  }
  save('setup.json', { hash: sha256(code), expires: Date.now() + ttlMs });
  audit('setup_code_minted', { reset, minutes: Math.round(ttlMs / 60e3) });
  return code;
}

function checkSetupCode(code) {
  const s = load('setup.json', null);
  if (!s || Date.now() > s.expires) return false;
  return safeEqualHex(sha256(String(code || '')), s.hash);
}

function burnSetupCode() {
  save('setup.json', null);
}

// ---- rate limiting ----------------------------------------------------------

const hits = new Map(); // key -> [timestamps]
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (arr.every((t) => now - t > 3600e3)) hits.delete(k);
  for (const [k, c] of ceremonies) if (now > c.expires) ceremonies.delete(k);
}, 60e3).unref();

export function clientIP(req) {
  return req.get('cf-connecting-ip') || req.get('x-forwarded-for')?.split(',')[0].trim() || req.socket.remoteAddress;
}

// ---- cookies ----------------------------------------------------------------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeMs) {
  const attrs = [`${name}=${value}`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict'];
  attrs.push(maxAgeMs > 0 ? `Max-Age=${Math.floor(maxAgeMs / 1000)}` : 'Max-Age=0');
  res.append('Set-Cookie', attrs.join('; '));
}

function startCeremony(res, challenge, kind) {
  const id = token();
  ceremonies.set(id, { challenge, kind, expires: Date.now() + CEREMONY_TTL_MS });
  setCookie(res, CEREMONY_COOKIE, id, CEREMONY_TTL_MS);
}

function takeCeremony(req, res, kind) {
  const id = parseCookies(req)[CEREMONY_COOKIE];
  const c = id && ceremonies.get(id);
  ceremonies.delete(id);
  setCookie(res, CEREMONY_COOKIE, '', 0);
  if (!c || c.kind !== kind || Date.now() > c.expires) return null;
  return c.challenge;
}

// ---- sessions ---------------------------------------------------------------

function createSession(req, res) {
  const t = token();
  const now = Date.now();
  sessions[sha256(t)] = { createdAt: now, lastSeenAt: now, authAt: now, ip: clientIP(req), ua: (req.get('user-agent') || '').slice(0, 200) };
  saveSessions();
  setCookie(res, SESSION_COOKIE, t, SESSION_MAX_MS);
}

function getSession(req) {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (!t) return null;
  const key = sha256(t);
  const s = sessions[key];
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeenAt > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS) {
    delete sessions[key];
    saveSessions();
    return null;
  }
  if (now - s.lastSeenAt > 60e3) {
    s.lastSeenAt = now;
    saveSessions();
  }
  return { key, ...s };
}

export function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'auth required' });
  req.session = s;
  next();
}

export function requireFreshAuth(req, res, next) {
  if (Date.now() - req.session.authAt > FRESH_AUTH_MS) return res.status(403).json({ error: 'reauth required' });
  next();
}

// ---- routes -----------------------------------------------------------------

function limited(req, res, bucket) {
  const ip = clientIP(req);
  if (!rateLimit(`${bucket}:${ip}`, 10, 10 * 60e3) || !rateLimit(`${bucket}:*`, 60, 3600e3)) {
    audit('rate_limited', { bucket, ip });
    res.status(429).json({ error: 'too many attempts, try again later' });
    return true;
  }
  return false;
}

async function registrationOptions(creds, name) {
  if (!creds.userID) creds.userID = b64(crypto.randomBytes(32));
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: 'owner',
    userDisplayName: name,
    userID: Buffer.from(creds.userID, 'base64url'),
    attestationType: 'none',
    excludeCredentials: creds.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

async function finishRegistration(req, res, kind) {
  const challenge = takeCeremony(req, res, kind);
  if (!challenge) return res.status(400).json({ error: 'ceremony expired, start again' });
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
  } catch (e) {
    audit(`${kind}_failed`, { ip: clientIP(req), reason: e.message });
    return res.status(400).json({ error: 'passkey verification failed' });
  }
  if (!v.verified) return res.status(400).json({ error: 'passkey verification failed' });
  const { credential, credentialBackedUp } = v.registrationInfo;
  const creds = loadCreds();
  const label = String(req.body.name || '').slice(0, 60) || `Passkey ${creds.passkeys.length + 1}`;
  creds.passkeys.push({
    id: credential.id,
    publicKey: b64(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    name: label,
    backedUp: credentialBackedUp,
    createdAt: Date.now(),
    lastUsedAt: null,
  });
  return { creds, label };
}

export function mountAuth(app) {
  app.get('/api/auth/state', (req, res) => {
    const s = getSession(req);
    const creds = loadCreds();
    res.json({
      authenticated: !!s,
      hasPasskeys: creds.passkeys.length > 0,
      fresh: !!s && Date.now() - s.authAt < FRESH_AUTH_MS,
    });
  });

  // First-time (or recovery) registration, gated by the one-time setup code.
  app.post('/api/setup/options', async (req, res) => {
    if (limited(req, res, 'setup')) return;
    if (!checkSetupCode(req.body.code)) {
      audit('setup_code_rejected', { ip: clientIP(req) });
      return res.status(403).json({ error: 'setup code is invalid, expired or already used' });
    }
    const creds = loadCreds();
    const options = await registrationOptions(creds, 'owner');
    save('credentials.json', creds); // persists userID
    startCeremony(res, options.challenge, 'setup');
    res.json(options);
  });

  app.post('/api/setup/verify', async (req, res) => {
    if (limited(req, res, 'setup')) return;
    if (!checkSetupCode(req.body.code)) return res.status(403).json({ error: 'setup code is invalid, expired or already used' });
    const out = await finishRegistration(req, res, 'setup');
    if (!out?.creds) return;
    // Re-check and burn with no await in between so two racing requests can't both use the code.
    if (!checkSetupCode(req.body.code)) return res.status(403).json({ error: 'setup code was already used' });
    burnSetupCode();
    save('credentials.json', out.creds);
    audit('passkey_registered', { via: 'setup_code', name: out.label, ip: clientIP(req) });
    createSession(req, res);
    res.json({ ok: true });
  });

  // Login with a discoverable passkey.
  app.post('/api/login/options', async (req, res) => {
    if (limited(req, res, 'login')) return;
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required' });
    startCeremony(res, options.challenge, 'login');
    res.json(options);
  });

  app.post('/api/login/verify', async (req, res) => {
    if (limited(req, res, 'login')) return;
    const challenge = takeCeremony(req, res, 'login');
    if (!challenge) return res.status(400).json({ error: 'login expired, try again' });
    const creds = loadCreds();
    const pk = creds.passkeys.find((p) => p.id === req.body.response?.id);
    if (!pk) {
      audit('login_failed', { ip: clientIP(req), reason: 'unknown passkey' });
      return res.status(401).json({ error: 'unknown passkey' });
    }
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id: pk.id, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports },
        requireUserVerification: true,
      });
    } catch (e) {
      audit('login_failed', { ip: clientIP(req), reason: e.message });
      return res.status(401).json({ error: 'passkey verification failed' });
    }
    if (!v.verified) return res.status(401).json({ error: 'passkey verification failed' });
    pk.counter = v.authenticationInfo.newCounter;
    pk.lastUsedAt = Date.now();
    save('credentials.json', creds);

    // A logged-in user re-verifying just refreshes authAt on the current session.
    const s = getSession(req);
    if (s) {
      sessions[s.key].authAt = Date.now();
      saveSessions();
      audit('reauth', { passkey: pk.name, ip: clientIP(req) });
    } else {
      createSession(req, res);
      audit('login', { passkey: pk.name, ip: clientIP(req), ua: (req.get('user-agent') || '').slice(0, 200) });
    }
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    const s = getSession(req);
    if (s) {
      delete sessions[s.key];
      saveSessions();
      audit('logout', { ip: clientIP(req) });
    }
    setCookie(res, SESSION_COOKIE, '', 0);
    res.json({ ok: true });
  });

  app.post('/api/logout-all', requireAuth, (req, res) => {
    sessions = {};
    saveSessions();
    setCookie(res, SESSION_COOKIE, '', 0);
    audit('logout_all', { ip: clientIP(req) });
    res.json({ ok: true });
  });

  // Passkey management (logged in).
  app.get('/api/passkeys', requireAuth, (req, res) => {
    res.json(loadCreds().passkeys.map(({ id, name, backedUp, createdAt, lastUsedAt }) => ({ id, name, backedUp, createdAt, lastUsedAt })));
  });

  app.post('/api/passkeys/options', requireAuth, requireFreshAuth, async (req, res) => {
    const creds = loadCreds();
    const options = await registrationOptions(creds, 'owner');
    save('credentials.json', creds);
    startCeremony(res, options.challenge, 'add');
    res.json(options);
  });

  app.post('/api/passkeys/verify', requireAuth, requireFreshAuth, async (req, res) => {
    const out = await finishRegistration(req, res, 'add');
    if (!out?.creds) return;
    save('credentials.json', out.creds);
    audit('passkey_registered', { via: 'session', name: out.label, ip: clientIP(req) });
    res.json({ ok: true });
  });

  app.delete('/api/passkeys/:id', requireAuth, requireFreshAuth, (req, res) => {
    const creds = loadCreds();
    if (creds.passkeys.length <= 1) return res.status(400).json({ error: "can't remove your only passkey" });
    const pk = creds.passkeys.find((p) => p.id === req.params.id);
    if (!pk) return res.status(404).json({ error: 'not found' });
    creds.passkeys = creds.passkeys.filter((p) => p !== pk);
    save('credentials.json', creds);
    audit('passkey_removed', { name: pk.name, ip: clientIP(req) });
    res.json({ ok: true });
  });

  // Session ids are a short prefix of the token hash: enough to address one, useless to authenticate.
  app.get('/api/sessions', requireAuth, (req, res) => {
    res.json(Object.entries(sessions).map(([k, s]) => ({ id: k.slice(0, 16), current: k === req.session.key, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, ua: s.ua })));
  });

  app.delete('/api/sessions/:id', requireAuth, (req, res) => {
    const key = Object.keys(sessions).find((k) => k.slice(0, 16) === req.params.id);
    if (!key) return res.status(404).json({ error: 'not found' });
    if (key === req.session.key) return res.status(400).json({ error: 'use sign out for this device' });
    delete sessions[key];
    saveSessions();
    audit('session_revoked', { ip: clientIP(req) });
    res.json({ ok: true });
  });

  app.patch('/api/passkeys/:id', requireAuth, (req, res) => {
    const creds = loadCreds();
    const pk = creds.passkeys.find((p) => p.id === req.params.id);
    if (!pk) return res.status(404).json({ error: 'not found' });
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'name required' });
    pk.name = name;
    save('credentials.json', creds);
    res.json({ ok: true });
  });
}

// For non-express requests (WebSocket upgrades): the session behind the cookie, or null.
export const sessionFromRequest = (req) => getSession(req);
