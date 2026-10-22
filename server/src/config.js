// Evaluated first (server.js imports it before anything else): derives RP_ID / ORIGIN so auth.js sees them.
const PLACEHOLDER = 'CHANGEME';
const env = process.env;
const set = (v) => (v && v !== PLACEHOLDER ? v : null);

// Passkeys are bound to RP_ID, so set RP_ID and ORIGIN in .env to wherever Tally is served (see .env.example).
// Unset, Tally runs on localhost (http://localhost:PORT); any other domain is assumed to be behind HTTPS.
export const RP_ID = env.RP_ID || 'localhost';
export const ORIGIN = env.ORIGIN || (RP_ID === 'localhost' ? `http://localhost:${env.PORT || 3000}` : `https://${RP_ID}`);

export const config = {
  PORT: Number(env.PORT || 3000),
  HOST: env.HOST || '0.0.0.0',
  DATA_DIR: env.DATA_DIR || '/data',
  PUBLIC_DIR: env.PUBLIC_DIR || new URL('../public', import.meta.url).pathname,
  DATABASE_URL: env.DATABASE_URL || `postgres://tally:${encodeURIComponent(env.POSTGRES_PASSWORD || '')}@db:5432/tally`,
  TOKEN_ENC_KEY: env.TOKEN_ENC_KEY || '',
  RP_ID,
  ORIGIN,
  plaid: {
    clientId: set(env.PLAID_CLIENT_ID),
    secret: set(env.PLAID_SECRET),
    env: env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
    redirectUri: set(env.PLAID_REDIRECT_URI),
    products: (env.PLAID_PRODUCTS || 'transactions').split(',').map((s) => s.trim()).filter(Boolean),
    // Webhooks need a public https origin; loopback test instances don't get them.
    webhook: ORIGIN.startsWith('https://') ? `${ORIGIN}/api/plaid/webhook` : null,
  },
  // Background Plaid sync every N hours (0 disables).
  SYNC_HOURS: Number(env.SYNC_HOURS ?? 6),
};
config.plaid.configured = !!(config.plaid.clientId && config.plaid.secret);

if (!/^[0-9a-f]{64}$/i.test(config.TOKEN_ENC_KEY)) throw new Error('TOKEN_ENC_KEY must be 64 hex chars (openssl rand -hex 32)');

if (!env.RP_ID) env.RP_ID = RP_ID;
if (!env.ORIGIN) env.ORIGIN = ORIGIN;
