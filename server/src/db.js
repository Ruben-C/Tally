// Postgres pool + tiny migration runner (src/db/migrations/NNN_*.sql, applied once, in order).
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric -> number (money is 2dp)
pg.types.setTypeParser(20, (v) => Number(v)); // bigint (ids, counts) -> number
pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
pool.on('error', (e) => console.error('pg pool error', e.message));

export const q = async (text, params) => (await pool.query(text, params)).rows;
export const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn({ q: async (t, p) => (await c.query(t, p)).rows, one: async (t, p) => (await c.query(t, p)).rows[0] ?? null });
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function waitForDb(tries = 60) {
  for (let i = 0; ; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function migrate() {
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.join(import.meta.dirname, 'db', 'migrations');
  const done = new Set((await q('select name from schema_migrations')).map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await tx(async (t) => {
      await t.q(fs.readFileSync(path.join(dir, f), 'utf8'));
      await t.q('insert into schema_migrations(name) values ($1)', [f]);
    });
    console.log(`migrated ${f}`);
  }
}
