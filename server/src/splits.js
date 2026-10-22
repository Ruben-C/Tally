// Split transactions (migration 008): one transaction's amount divided across categories. Lines must add up to the
// transaction; line 0 is the main one, mirrored to transactions.category_id so anything reading the row alone still
// sees a sensible category.

const cents = (n) => Math.round(Number(n) * 100);

// Replace a transaction's split with `lines` [{category_id, amount, note}], inside a db transaction `t`.
// Fewer than two lines removes the split and leaves the transaction in the first line's category (if any).
export async function setSplits(t, txnId, lines) {
  const txn = await t.one('select id, amount from transactions where id = $1 for update', [txnId]);
  if (!txn) throw Object.assign(new Error('not found'), { status: 404 });
  await t.q('delete from transaction_splits where transaction_id = $1', [txn.id]);
  if (!Array.isArray(lines) || lines.length < 2) {
    if (lines?.[0]?.category_id) await t.q('update transactions set category_id = $2, category_locked = true, updated_at = now() where id = $1', [txn.id, lines[0].category_id]);
    return [];
  }
  if (lines.length > 20) throw Object.assign(new Error('at most 20 lines'), { status: 400 });
  const clean = lines.map((l, i) => {
    const amount = Number(l.amount);
    if (!Number.isInteger(Number(l.category_id))) throw Object.assign(new Error(`line ${i + 1}: pick a category`), { status: 400 });
    if (!Number.isFinite(amount) || cents(amount) === 0) throw Object.assign(new Error(`line ${i + 1}: enter an amount`), { status: 400 });
    return { category_id: Number(l.category_id), amount: cents(amount) / 100, note: l.note ? String(l.note).trim().slice(0, 200) || null : null };
  });
  const sum = clean.reduce((a, l) => a + cents(l.amount), 0);
  if (sum !== cents(txn.amount)) throw Object.assign(new Error(`lines add up to ${(sum / 100).toFixed(2)}, the transaction is ${Number(txn.amount).toFixed(2)}`), { status: 400 });
  const known = await t.q('select id from categories where id = any($1::int[])', [clean.map((l) => l.category_id)]);
  if (new Set(known.map((r) => r.id)).size !== new Set(clean.map((l) => l.category_id)).size) throw Object.assign(new Error('unknown category'), { status: 400 });
  for (const [i, l] of clean.entries())
    await t.q('insert into transaction_splits (transaction_id, category_id, amount, note, sort) values ($1, $2, $3, $4, $5)', [txn.id, l.category_id, l.amount, l.note, i]);
  await t.q('update transactions set category_id = $2, category_locked = true, reviewed = true, updated_at = now() where id = $1', [txn.id, clean[0].category_id]);
  return clean;
}

// The bank changed a split transaction's amount (a tip posting, a pending → posted change): the main line takes the
// difference. If that would zero it or flip its sign, the split no longer makes sense and is dropped.
export async function reconcileSplits(t, txnId) {
  const lines = await t.q(
    `select s.id, s.amount, x.amount as total from transaction_splits s join transactions x on x.id = s.transaction_id
      where s.transaction_id = $1 order by s.sort, s.id`,
    [txnId],
  );
  if (!lines.length) return;
  const diff = cents(lines[0].total) - lines.reduce((a, l) => a + cents(l.amount), 0);
  if (!diff) return;
  const main = cents(lines[0].amount) + diff;
  if (main === 0 || Math.sign(main) !== Math.sign(cents(lines[0].amount))) await t.q('delete from transaction_splits where transaction_id = $1', [txnId]);
  else await t.q('update transaction_splits set amount = $2 where id = $1', [lines[0].id, main / 100]);
}

// A posted transaction replacing a pending one inherits its split (then fits it to the posted amount).
export async function copySplits(t, fromId, toId) {
  await t.q(
    `insert into transaction_splits (transaction_id, category_id, amount, note, sort)
     select $2, category_id, amount, note, sort from transaction_splits where transaction_id = $1`,
    [fromId, toId],
  );
  await reconcileSplits(t, toId);
}
