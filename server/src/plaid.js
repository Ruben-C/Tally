// Plaid: Link tokens, public-token exchange, /transactions/sync, balances, item health and webhooks.
import crypto from 'node:crypto';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import { config } from './config.js';
import { q, one, tx } from './db.js';
import { seal, open } from './crypto.js';
import { loadCategorizer } from './categorize.js';
import { snapshot, rebuildDerived } from './balances.js';
import { refreshRecurring } from './recurring.js';
import { applyGoalSplits } from './goals.js';
import { copySplits, reconcileSplits } from './splits.js';
import { audit } from './store.js';

export const client = config.plaid.configured
  ? new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[config.plaid.env],
        baseOptions: { headers: { 'PLAID-CLIENT-ID': config.plaid.clientId, 'PLAID-SECRET': config.plaid.secret, 'Plaid-Version': '2020-09-14' } },
      }),
    )
  : null;

export class PlaidNotConfigured extends Error {
  constructor() {
    super('Plaid keys are not set yet (PLAID_CLIENT_ID / PLAID_SECRET in apps/tally/.env)');
    this.status = 503;
  }
}
const need = () => {
  if (!client) throw new PlaidNotConfigured();
  return client;
};

// Plaid errors come back as axios errors; surface the useful part.
export function plaidError(e) {
  const d = e?.response?.data;
  return d?.error_code ? { code: d.error_code, message: d.error_message || d.display_message || d.error_code } : { code: 'INTERNAL', message: e?.message || String(e) };
}

export async function createLinkToken({ itemId = null } = {}) {
  const req = {
    user: { client_user_id: 'owner' },
    client_name: 'Tally',
    language: 'en',
    country_codes: [CountryCode.Us],
  };
  if (config.plaid.webhook) req.webhook = config.plaid.webhook;
  if (config.plaid.redirectUri) req.redirect_uri = config.plaid.redirectUri;
  if (itemId) {
    // Update mode: re-authenticate an existing item (no products).
    const item = await one('select access_token_enc from plaid_items where id = $1', [itemId]);
    if (!item) throw Object.assign(new Error('no such connection'), { status: 404 });
    req.access_token = open(item.access_token_enc);
  } else {
    req.products = config.plaid.products.map((p) => Products[p[0].toUpperCase() + p.slice(1)] || p);
    req.transactions = { days_requested: 730 };
  }
  const { data } = await need().linkTokenCreate(req);
  return data.link_token;
}

export async function exchangePublicToken(publicToken, metadata = {}) {
  const { data } = await need().itemPublicTokenExchange({ public_token: publicToken });
  let inst = { name: metadata.institution?.name || null, id: metadata.institution?.institution_id || null, color: null, logo: null };
  if (inst.id) {
    try {
      const r = await client.institutionsGetById({ institution_id: inst.id, country_codes: [CountryCode.Us], options: { include_optional_metadata: true } });
      inst = { name: r.data.institution.name, id: inst.id, color: r.data.institution.primary_color || null, logo: r.data.institution.logo || null };
    } catch {
      /* cosmetic only */
    }
  }
  const row = await one(
    `insert into plaid_items (item_id, access_token_enc, institution_id, institution_name, institution_color, institution_logo)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (item_id) do update set access_token_enc = excluded.access_token_enc, status = 'ok', error_code = null, error_message = null
     returning id`,
    [data.item_id, seal(data.access_token), inst.id, inst.name, inst.color, inst.logo],
  );
  audit('plaid_item_linked', { institution: inst.name });
  await syncItem(row.id);
  return row.id;
}

// Plaid's own refresh times for the item. Cosmetic: a failure here never fails the sync.
async function refreshBankStatus(item, accessToken) {
  try {
    const { data } = await client.itemGet({ access_token: accessToken });
    const st = data.status?.transactions;
    await q('update plaid_items set bank_updated_at=$2, bank_failed_at=$3 where id=$1', [item.id, st?.last_successful_update || null, st?.last_failed_update || null]);
  } catch (e) {
    console.error(`plaid item/get failed for item ${item.id}: ${plaidError(e).message}`);
  }
}

async function refreshAccounts(item, accessToken) {
  const { data } = await client.accountsGet({ access_token: accessToken });
  for (const a of data.accounts) {
    const row = await one(
      `insert into accounts (item_id, plaid_account_id, name, official_name, mask, type, subtype, institution_name,
                             current_balance, available_balance, credit_limit, currency, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       on conflict (plaid_account_id) do update set name = excluded.name, official_name = excluded.official_name, mask = excluded.mask,
         type = excluded.type, subtype = excluded.subtype, current_balance = excluded.current_balance,
         available_balance = excluded.available_balance, credit_limit = excluded.credit_limit, updated_at = now()
       returning id`,
      [item.id, a.account_id, a.name, a.official_name, a.mask, a.type, a.subtype, item.institution_name,
       a.balances.current, a.balances.available, a.balances.limit, a.balances.iso_currency_code || 'USD'],
    );
    await snapshot(row.id, a.balances.current);
  }
}

const running = new Map(); // item id -> promise, so webhook + manual + scheduled syncs don't overlap

export function syncItem(itemId) {
  if (running.has(itemId)) return running.get(itemId);
  const p = doSync(itemId).finally(() => running.delete(itemId));
  running.set(itemId, p);
  return p;
}

async function doSync(itemId) {
  const item = await one('select * from plaid_items where id = $1', [itemId]);
  if (!item) return { added: 0, modified: 0, removed: 0 };
  const token = open(item.access_token_enc);
  try {
    need();
    await refreshAccounts(item, token);
    await refreshBankStatus(item, token);
    const accts = await q('select id, plaid_account_id, type from accounts where item_id = $1', [item.id]);
    const acctIds = Object.fromEntries(accts.map((a) => [a.plaid_account_id, a.id]));
    const acctType = Object.fromEntries(accts.map((a) => [a.plaid_account_id, a.type]));

    // Page through /transactions/sync; restart from the original cursor if data changes mid-pagination.
    let added = [], modified = [], removed = [], cursor = item.cursor;
    for (let attempt = 0; ; attempt++) {
      added = []; modified = []; removed = []; cursor = item.cursor;
      try {
        let more = true;
        while (more) {
          const { data } = await client.transactionsSync({ access_token: token, cursor: cursor || undefined, count: 500 });
          added.push(...data.added);
          modified.push(...data.modified);
          removed.push(...data.removed);
          cursor = data.next_cursor;
          more = data.has_more;
        }
        break;
      } catch (e) {
        if (plaidError(e).code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 3) continue;
        throw e;
      }
    }

    const categorize = await loadCategorizer();
    const inserted = [];
    await tx(async (t) => {
      for (const p of [...added, ...modified]) {
        const accountId = acctIds[p.account_id];
        if (!accountId) continue;
        const base = {
          name: p.name || p.merchant_name || 'Transaction',
          merchant_name: p.merchant_name || null,
          amount: p.amount,
          pfc_primary: p.personal_finance_category?.primary || null,
          pfc_detailed: p.personal_finance_category?.detailed || null,
          account_type: acctType[p.account_id],
          account_id: accountId,
        };
        const existing = await t.one('select id from transactions where plaid_transaction_id = $1', [p.transaction_id]);
        if (existing) {
          await t.q(
            `update transactions set account_id=$2, date=$3, authorized_date=$4, amount=$5, currency=$6, name=$7, merchant_name=$8,
               logo_url=$9, website=$10, pfc_primary=$11, pfc_detailed=$12, pending=$13, updated_at=now()
             where id=$1`,
            [existing.id, accountId, p.date, p.authorized_date, p.amount, p.iso_currency_code || 'USD', base.name, base.merchant_name,
             p.logo_url, p.website, base.pfc_primary, base.pfc_detailed, p.pending],
          );
          await reconcileSplits(t, existing.id);
          continue;
        }
        // A posted transaction replacing a pending one inherits everything the user did to the pending one.
        const prev = p.pending_transaction_id
          ? await t.one('select id, category_id, category_locked, display_name, notes, reviewed, excluded, tags from transactions where plaid_transaction_id = $1', [p.pending_transaction_id])
          : null;
        const auto = categorize(base);
        const ins = await t.one(
          `insert into transactions (account_id, plaid_transaction_id, pending_transaction_id, date, authorized_date, amount, currency,
             name, merchant_name, display_name, logo_url, website, category_id, category_locked, pfc_primary, pfc_detailed, pending,
             reviewed, excluded, notes, tags)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`,
          [accountId, p.transaction_id, p.pending_transaction_id, p.date, p.authorized_date, p.amount, p.iso_currency_code || 'USD',
           base.name, base.merchant_name, prev?.display_name ?? auto.display_name, p.logo_url, p.website,
           prev?.category_id ?? auto.category_id, prev?.category_locked ?? false, base.pfc_primary, base.pfc_detailed, p.pending,
           prev?.reviewed ?? auto.reviewed, prev?.excluded ?? false, prev?.notes ?? null, prev?.tags ?? []],
        );
        if (prev) await copySplits(t, prev.id, ins.id);
        inserted.push(ins.id);
      }
      if (removed.length) await t.q('delete from transactions where plaid_transaction_id = any($1::text[])', [removed.map((r) => r.transaction_id)]);
      await t.q(`update plaid_items set cursor=$2, status='ok', error_code=null, error_message=null, last_synced_at=now() where id=$1`, [item.id, cursor]);
    });

    for (const id of Object.values(acctIds)) await rebuildDerived(id);
    if (inserted.length) await applyGoalSplits({ txnIds: inserted }); // rules that split new transfers across goals
    await refreshRecurring();
    return { added: added.length, modified: modified.length, removed: removed.length };
  } catch (e) {
    if (e instanceof PlaidNotConfigured) throw e;
    const err = plaidError(e);
    const status = err.code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error';
    await q('update plaid_items set status=$2, error_code=$3, error_message=$4 where id=$1', [item.id, status, err.code, err.message]);
    console.error(`plaid sync failed for item ${item.id}: ${err.code} ${err.message}`);
    throw Object.assign(new Error(err.message), { status: 502, code: err.code });
  }
}

// Ask Plaid to pull from the bank now (/transactions/refresh). It answers at once and works in the background:
// new data arrives as a SYNC_UPDATES_AVAILABLE webhook, which syncs. A no-change refresh sends no webhook, so the
// bank time is re-read a little later either way.
export async function refreshItem(itemId) {
  const item = await one('select * from plaid_items where id = $1', [itemId]);
  if (!item) throw Object.assign(new Error('connection not found'), { status: 404 });
  const token = open(item.access_token_enc);
  try {
    await need().transactionsRefresh({ access_token: token });
  } catch (e) {
    if (e instanceof PlaidNotConfigured) throw e;
    const err = plaidError(e);
    console.error(`plaid refresh failed for item ${item.id}: ${err.code} ${err.message}`);
    throw Object.assign(new Error(err.message), { status: 502, code: err.code });
  }
  audit('plaid_refresh_requested', { institution: item.institution_name });
  for (const ms of [60e3, 180e3]) setTimeout(() => refreshBankStatus(item, token), ms).unref();
  return { ok: true };
}

export async function syncAll() {
  const items = await q('select id from plaid_items');
  const results = [];
  for (const i of items) {
    try {
      results.push({ id: i.id, ...(await syncItem(i.id)) });
    } catch (e) {
      results.push({ id: i.id, error: e.message });
    }
  }
  return results;
}

export async function removeItem(id) {
  const item = await one('select * from plaid_items where id = $1', [id]);
  if (!item) return false;
  if (client) {
    try {
      await client.itemRemove({ access_token: open(item.access_token_enc) });
    } catch (e) {
      console.error('plaid item/remove failed (deleting locally anyway):', plaidError(e).message);
    }
  }
  await q('delete from plaid_items where id = $1', [id]);
  await refreshRecurring();
  audit('plaid_item_removed', { institution: item.institution_name });
  return true;
}

// ---- webhooks ---------------------------------------------------------------
// Plaid signs each webhook with an ES256 JWT in the Plaid-Verification header whose payload carries
// the SHA-256 of the raw body. Keys come from /webhook_verification_key/get and are cached by kid.
const keyCache = new Map();

export async function verifyWebhook(rawBody, jwt) {
  if (!client || !jwt) return false;
  const [h, p, s] = String(jwt).split('.');
  if (!h || !p || !s) return false;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'ES256' || !header.kid) return false;
  let jwk = keyCache.get(header.kid);
  if (!jwk) {
    const { data } = await client.webhookVerificationKeyGet({ key_id: header.kid });
    jwk = data.key;
    keyCache.set(header.kid, jwk);
  }
  if (jwk.expired_at) return false;
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  if (!ok) return false;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (Math.abs(Date.now() / 1000 - payload.iat) > 300) return false;
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  return payload.request_body_sha256 && crypto.timingSafeEqual(Buffer.from(bodyHash), Buffer.from(String(payload.request_body_sha256)));
}

export async function handleWebhook(body) {
  const item = await one('select id from plaid_items where item_id = $1', [body.item_id]);
  if (!item) return;
  const code = `${body.webhook_type}:${body.webhook_code}`;
  if (body.webhook_type === 'TRANSACTIONS') {
    syncItem(item.id).catch(() => {});
  } else if (body.webhook_type === 'ITEM') {
    if (body.webhook_code === 'ERROR' || body.webhook_code === 'LOGIN_REPAIRED') {
      const status = body.webhook_code === 'LOGIN_REPAIRED' ? 'ok' : body.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error';
      await q('update plaid_items set status=$2, error_code=$3, error_message=$4 where id=$1', [item.id, status, body.error?.error_code || null, body.error?.error_message || null]);
    } else if (body.webhook_code === 'PENDING_EXPIRATION' || body.webhook_code === 'PENDING_DISCONNECT') {
      await q(`update plaid_items set status='pending_expiration' where id=$1`, [item.id]);
    } else if (body.webhook_code === 'USER_PERMISSION_REVOKED' || body.webhook_code === 'USER_ACCOUNT_REVOKED') {
      await q(`update plaid_items set status='login_required', error_code=$2 where id=$1`, [item.id, body.webhook_code]);
    }
  }
  audit('plaid_webhook', { code });
}
