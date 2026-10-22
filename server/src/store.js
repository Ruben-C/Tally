// Tiny JSON-file persistence for auth state (passkeys, sessions, setup code, audit log).
// Single user, low write volume, so whole-file atomic rewrites are fine. Financial data lives in Postgres.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || '/data';
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

export function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return structuredClone(fallback);
    throw e;
  }
}

export function save(name, value) {
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function audit(event, detail = {}) {
  const entry = { at: new Date().toISOString(), event, ...detail };
  fs.appendFileSync(path.join(DATA_DIR, 'audit.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export function readAudit(limit = 100) {
  try {
    const lines = fs.readFileSync(path.join(DATA_DIR, 'audit.jsonl'), 'utf8').trim().split('\n');
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
