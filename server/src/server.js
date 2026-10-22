// Tally — personal finance (budgets, transactions, net worth, recurring) over Plaid.
import { config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { mountAuth, requireAuth, ORIGIN } from './auth.js';
import { pool, waitForDb, migrate } from './db.js';
import { api } from './routes/api.js';
import * as plaid from './plaid.js';

await waitForDb();
await migrate();

const app = express();
app.disable('x-powered-by');

// Strict CSP. Plaid Link runs from cdn.plaid.com in an iframe; merchant/institution logos come from Plaid's CDN.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.plaid.com",
  "frame-src https://cdn.plaid.com https://*.plaid.com",
  "connect-src 'self' https://*.plaid.com",
  "img-src 'self' data: https://plaid-merchant-logos.plaid.com https://*.plaid.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=31536000',
  });
  next();
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Plaid webhook: unauthenticated by design, verified by Plaid's signed JWT over the raw body.
app.post('/api/plaid/webhook', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  try {
    if (!(await plaid.verifyWebhook(req.body, req.get('plaid-verification')))) return res.status(401).end();
    await plaid.handleWebhook(JSON.parse(req.body.toString('utf8')));
    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e.message);
    res.status(400).end();
  }
});

app.use(express.json({ limit: '256kb' }));

// CSRF: session cookies are SameSite=Strict; additionally refuse cross-origin state changes outright.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin && origin !== ORIGIN) return res.status(403).json({ error: 'cross-origin request refused' });
  next();
});

mountAuth(app);
app.use('/api', requireAuth, api);
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.use('/api', (err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(req.method, req.path, err);
  res.status(status).json({ error: status >= 500 && !err.code ? 'server error' : err.message, code: err.code });
});

// The React PWA (built by Vite). Hashed assets are immutable; the shell and service worker never cache.
const pub = config.PUBLIC_DIR;
app.use('/assets', express.static(path.join(pub, 'assets'), { immutable: true, maxAge: '1y', index: false }));
app.use(express.static(pub, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
const shell = () => fs.readFileSync(path.join(pub, 'index.html'));
app.get('/{*path}', (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(shell()));

app.listen(config.PORT, config.HOST, () => console.log(`tally listening on ${config.HOST}:${config.PORT} as ${ORIGIN}`));

// Background sync (SYNC_HOURS=0 disables it).
if (config.SYNC_HOURS > 0 && config.plaid.configured) {
  const run = () => plaid.syncAll().then((r) => r.length && console.log('scheduled sync', JSON.stringify(r))).catch((e) => console.error('scheduled sync failed', e.message));
  setTimeout(run, 60e3).unref();
  setInterval(run, config.SYNC_HOURS * 3600e3).unref();
}
