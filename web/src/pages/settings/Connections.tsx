import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CloudDownload, ExternalLink, Landmark, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { withFreshAuth } from '../../lib/auth';
import { useAccounts, useMeta, useMutate, usePlaidItems } from '../../lib/queries';
import { isLiability, money, timeAgo } from '../../lib/format';
import type { Account, PlaidItem } from '../../lib/types';
import { Badge, Button, DataTable, Empty, IconButton, Modal, Panel, Stat, StatGrid, useToast } from '../../components/ui';
import { usePlaidConnect } from '../../components/plaid';
import { AccountAvatar, ConnectButton } from '../Accounts';
import { SettingsHeader } from './SettingsLayout';

const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  ok: { label: 'Healthy', tone: 'good' },
  login_required: { label: 'Sign-in needed', tone: 'bad' },
  pending_expiration: { label: 'Expiring soon', tone: 'warn' },
  error: { label: 'Sync error', tone: 'bad' },
};

// When Plaid last pulled from the bank. Over a day old (or a newer failure) means Plaid is behind, not Tally.
const STALE_MS = 24 * 3600e3;
function bankFreshness(b: PlaidItem) {
  const ok = b.bank_updated_at ? Date.parse(b.bank_updated_at) : 0;
  const failed = b.bank_failed_at ? Date.parse(b.bank_failed_at) : 0;
  const stale = !ok || Date.now() - ok > STALE_MS || failed > ok;
  const title = failed > ok ? `Plaid's last refresh from the bank failed ${timeAgo(b.bank_failed_at)}` : 'When Plaid last pulled new data from the bank';
  return { label: ok ? timeAgo(b.bank_updated_at) : 'unknown', stale, title };
}

// Sync (ask Plaid for what it has) and Refresh (have Plaid pull from the bank now) for a healthy bank,
// Reconnect (Plaid update mode) for a broken one.
function BankAction({ item }: { item: PlaidItem }) {
  const toast = useToast();
  const sync = useMutate(() => api(`/plaid/items/${item.id}/sync`, { body: {} }));
  const refresh = useMutate(() => api(`/plaid/items/${item.id}/refresh`, { body: {} }));
  const repair = usePlaidConnect({ itemId: item.id });
  const bank = item.institution_name || 'the bank';
  return item.status === 'ok' ? (
    <>
      <IconButton size="sm" icon={<CloudDownload />} label={`Refresh from ${bank}: Plaid pulls new data now, then it syncs in a few minutes`} disabled={refresh.isPending}
        onClick={() => refresh.mutateAsync(undefined).then(() => toast(`Asked ${bank} for new data. New transactions show up within a few minutes.`)).catch((e) => toast(e.message, { kind: 'error' }))} />
      <Button size="sm" icon={<RefreshCw className={sync.isPending ? 'spin' : ''} />} disabled={sync.isPending} onClick={() => sync.mutateAsync(undefined).then(() => toast('Synced')).catch((e) => toast(e.message, { kind: 'error' }))}>
        Sync
      </Button>
    </>
  ) : (
    <Button size="sm" variant="primary" disabled={repair.busy} onClick={repair.start}>Reconnect</Button>
  );
}

export default function Connections() {
  const toast = useToast();
  const nav = useNavigate();
  const meta = useMeta();
  const items = usePlaidItems();
  const accounts = useAccounts();
  const [confirm, setConfirm] = useState<PlaidItem | null>(null);
  const remove = useMutate((id: number) => withFreshAuth(() => api(`/plaid/items/${id}`, { method: 'DELETE' })));
  const plaid = meta.data?.plaid;
  const banks = items.data || [];
  const linked = (accounts.data || []).filter((a) => a.item_id != null);
  const bankName = (id: number | null) => banks.find((b) => b.id === id)?.institution_name || 'Bank';
  const bal = (a: Account) => (isLiability(a.type) ? -(a.current_balance || 0) : a.current_balance || 0);

  return (
    <>
      <SettingsHeader title="Connections" sub="Banks, cards and loans linked through Plaid (read-only)." actions={plaid?.configured ? <ConnectButton label="Connect a bank" className="btn primary sm" /> : null} />

      {plaid && !plaid.configured && (
        <Panel title="Set up bank connections" actions={<Badge tone="warn">Not configured</Badge>}>
          <p className="muted" style={{ marginBottom: 12 }}>Tally uses Plaid to read balances and transactions. Three steps:</p>
          <ol className="steps">
            <li><span><b>Get your Plaid keys.</b><span className="muted">Sign in at <a className="link" href="https://dashboard.plaid.com/developers/keys" target="_blank" rel="noreferrer">dashboard.plaid.com <ExternalLink /></a> and copy the client ID and secret.</span></span></li>
            <li><span><b>Add them to Tally's environment.</b><span className="muted">Set <code>PLAID_CLIENT_ID</code> and <code>PLAID_SECRET</code> in Tally's <code>.env</code> file (next to <code>compose.yml</code>). Keep <code>PLAID_ENV=sandbox</code> to test first.</span></span></li>
            <li><span><b>Restart Tally and connect.</b><span className="muted">Run <code>docker compose up -d</code> in Tally's folder so it picks up the new keys; this page then shows a <b>Connect a bank</b> button.</span></span></li>
          </ol>
        </Panel>
      )}

      {plaid?.configured && (
        <StatGrid>
          <Stat label="Environment" value={<Badge tone={plaid.env === 'production' ? 'good' : 'warn'}>{plaid.env === 'production' ? 'Production' : 'Sandbox'}</Badge>} sub={plaid.env !== 'production' ? <>Test login <code>user_good</code> / <code>pass_good</code></> : 'Real banks'} />
          <Stat label="Live updates" value={plaid.webhook ? 'On' : 'Off'} sub={plaid.webhook ? 'Webhooks' : 'Syncs every few hours'} />
          <Stat label="OAuth banks" value={plaid.oauthRedirect ? 'Ready' : 'Off'} sub={plaid.oauthRedirect ? undefined : 'Redirect URI not set'} />
          <Stat label="Banks" value={banks.length} sub={`${linked.length} accounts`} />
        </StatGrid>
      )}

      <Panel title="Banks" meta={banks.length ? `${banks.length}` : undefined} flush className="clip">
        <DataTable
          rows={banks}
          rowKey={(b) => b.id}
          loading={items.isLoading}
          skeletonRows={2}
          empty={
            <Empty icon={<Landmark />} title="No banks connected" action={plaid?.configured ? <ConnectButton label="Connect your first bank" className="btn primary sm" /> : undefined}>
              {plaid?.configured ? 'Link a checking account or card to start.' : 'Finish the setup above to link real accounts.'}
            </Empty>
          }
          columns={[
            {
              key: 'n', header: 'Institution', wide: true,
              cell: (b) => (
                <div className="cell">
                  <AccountAvatar a={{ type: 'depository', institution_logo: b.institution_logo, institution_color: b.institution_color }} />
                  <span className="primary ellipsis">{b.institution_name || 'Bank'}</span>
                </div>
              ),
              sub: (b) => `${(STATUS[b.status] || STATUS.error).label} · bank updated ${bankFreshness(b).label}`,
            },
            { key: 's', header: 'Status', hide: 'sm', cell: (b) => { const s = STATUS[b.status] || STATUS.error; return <Badge tone={s.tone}>{s.label}</Badge>; } },
            { key: 'e', header: 'Problem', hide: 'md', width: 260, cell: (b) => (b.status !== 'ok' && b.error_message ? <span className="neg ellipsis" style={{ display: 'block', maxWidth: 260 }} title={b.error_message}>{b.error_message}</span> : <span className="faint">—</span>) },
            { key: 'a', header: 'Accounts', num: true, hide: 'sm', cell: (b) => b.accounts },
            { key: 'u', header: 'Bank updated', align: 'right', hide: 'sm', cell: (b) => { const f = bankFreshness(b); return <span className={f.stale ? 'warn' : 'muted'} title={f.title}>{f.label}</span>; } },
            { key: 'l', header: 'Last checked', align: 'right', hide: 'sm', cell: (b) => <span className="muted" title="When Tally last asked Plaid for new data">{timeAgo(b.last_synced_at)}</span> },
            { key: 'c', header: 'Connected', align: 'right', hide: 'lg', cell: (b) => <span className="muted num">{new Date(b.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span> },
            {
              key: 'x', shrink: true,
              cell: (b) => (
                <span className="row" style={{ gap: 2 }}>
                  <BankAction item={b} />
                  <IconButton size="sm" icon={<Trash2 />} label="Remove connection" className="danger" onClick={() => setConfirm(b)} />
                </span>
              ),
            },
          ]}
        />
      </Panel>

      {linked.length > 0 && (
        <Panel title="Linked accounts" meta={`${linked.length}`} flush className="clip">
          <DataTable
            rows={linked}
            rowKey={(a) => a.id}
            onRowClick={(a) => nav(`/transactions?account=${a.id}`)}
            rowClass={(a) => a.hidden && 'dim'}
            columns={[
              { key: 'n', header: 'Account', wide: true, sort: (a) => a.label.toLowerCase(), cell: (a) => <span className="primary ellipsis" style={{ display: 'block' }}>{a.label}</span>, sub: (a) => `${bankName(a.item_id)}${a.mask ? ` ··${a.mask}` : ''}` },
              { key: 'b', header: 'Bank', hide: 'sm', sort: (a) => bankName(a.item_id), cell: (a) => <span className="muted">{bankName(a.item_id)}</span> },
              { key: 't', header: 'Type', hide: 'md', sort: (a) => a.subtype || a.type, cell: (a) => <span className="muted">{a.subtype || a.type}</span> },
              { key: 'm', header: 'Number', hide: 'md', cell: (a) => <span className="muted num">{a.mask ? `··${a.mask}` : '—'}</span> },
              { key: 'h', header: 'Visibility', hide: 'lg', cell: (a) => (a.hidden ? <Badge>Hidden</Badge> : <span className="faint">Shown</span>) },
              { key: 'v', header: 'Balance', num: true, sort: (a) => bal(a), cell: (a) => <span className={bal(a) < 0 ? 'neg' : ''}>{money(bal(a))}</span> },
            ]}
          />
        </Panel>
      )}

      {confirm && (
        <Modal onClose={() => setConfirm(null)}>
          <h2>Remove {confirm.institution_name || 'this bank'}?</h2>
          <p className="muted" style={{ marginTop: 6 }}>Its {confirm.accounts} account{confirm.accounts === 1 ? '' : 's'}, balances and transactions are deleted from Tally and Plaid's access is revoked. This can't be undone. You'll confirm with your passkey.</p>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" className="solid" loading={remove.isPending}
              onClick={() => remove.mutateAsync(confirm.id).then(() => { toast('Connection removed'); setConfirm(null); }).catch((e) => toast(e.message, { kind: 'error' }))}>Remove</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
