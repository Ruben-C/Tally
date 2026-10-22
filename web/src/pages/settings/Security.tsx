import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Monitor, Pencil, Plus, Smartphone, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { addPasskey, deviceName, withFreshAuth } from '../../lib/auth';
import { timeAgo } from '../../lib/format';
import { Badge, Button, DataTable, Field, IconButton, Input, Modal, Panel, useToast } from '../../components/ui';
import { SettingsHeader, usePasskeys, useSessions, type Passkey } from './SettingsLayout';

const ago = (ms: number | null) => (ms ? timeAgo(new Date(ms).toISOString()) : 'never');
const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function device(ua: string) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return { label: br ? `${br} on ${os}` : os, mobile: /iPhone|Android|iPad/.test(ua) };
}

const EVENTS: Record<string, string> = {
  login: 'Signed in', logout: 'Signed out', logout_all: 'Signed out everywhere', reauth: 'Confirmed with passkey',
  passkey_registered: 'Passkey added', passkey_removed: 'Passkey removed', session_revoked: 'Device signed out',
  login_failed: 'Failed sign-in attempt', setup_code_minted: 'Setup link created', setup_code_rejected: 'Invalid setup link used',
  rate_limited: 'Too many attempts blocked', plaid_item_linked: 'Bank connected', plaid_item_removed: 'Bank removed',
  demo_loaded: 'Demo data loaded', demo_removed: 'Demo data removed',
};
type AuditEvent = { at: string; event: string; name?: string; passkey?: string; institution?: string; ip?: string };

export default function Security() {
  const toast = useToast();
  const qc = useQueryClient();
  const passkeys = usePasskeys();
  const sessions = useSessions();
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api<AuditEvent[]>('/audit') });
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [newName, setNewName] = useState('');
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['passkeys'] }), qc.invalidateQueries({ queryKey: ['sessions'] }), qc.invalidateQueries({ queryKey: ['audit'] })]);
  const fail = (e: Error) => toast(e.message, { kind: 'error' });
  const logout = async (all = false) => {
    await api(all ? '/logout-all' : '/logout', { body: {} });
    location.href = '/';
  };
  const events = (audit.data || []).filter((e) => EVENTS[e.event] && e.event !== 'plaid_webhook').slice(0, 25);
  const sorted = [...(sessions.data || [])].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
  const saveName = () =>
    renaming && newName.trim() && api(`/passkeys/${encodeURIComponent(renaming.id)}`, { method: 'PATCH', body: { name: newName } }).then(() => { toast('Renamed'); setRenaming(null); refresh(); }).catch(fail);

  return (
    <>
      <SettingsHeader title="Passkeys & sign-in" sub="No passwords: each device you trust holds a passkey. Keep at least two." />

      {passkeys.data && passkeys.data.length < 2 && (
        <div className="inline-alert warn">{passkeys.data.length ? "Only one passkey: if you lose that device you'll need a recovery link from the server." : 'No passkeys registered: this session came from a recovery or setup link.'} Add a second device.</div>
      )}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Panel title="Passkeys" meta={passkeys.data ? `${passkeys.data.length}` : undefined} flush className="clip"
          actions={<Button size="sm" icon={<Plus />} onClick={() => withFreshAuth(() => addPasskey(deviceName())).then(() => { toast('Passkey added'); refresh(); }).catch(fail)}>Add passkey</Button>}>
          <DataTable
            sticky={false}
            rows={passkeys.data || []}
            rowKey={(p) => p.id}
            loading={passkeys.isLoading}
            skeletonRows={2}
            empty={<div className="dt-empty">No passkeys yet.</div>}
            columns={[
              { key: 'n', header: 'Name', wide: true, cell: (p) => <div className="cell"><KeyRound size={14} className="faint" style={{ flex: 'none' }} /><span className="primary ellipsis">{p.name}</span>{p.backedUp && <Badge>Synced</Badge>}</div>, sub: (p) => `Last used ${ago(p.lastUsedAt)}` },
              { key: 'c', header: 'Added', align: 'right', hide: 'sm', cell: (p) => <span className="muted num">{day(p.createdAt)}</span> },
              { key: 'u', header: 'Last used', align: 'right', hide: 'sm', cell: (p) => <span className="muted">{ago(p.lastUsedAt)}</span> },
              {
                key: 'x', shrink: true,
                cell: (p) => (
                  <span className="row-actions">
                    <IconButton size="sm" icon={<Pencil />} label="Rename" onClick={() => { setRenaming(p); setNewName(p.name); }} />
                    <IconButton size="sm" icon={<Trash2 />} label="Remove" className="danger" disabled={(passkeys.data?.length || 0) <= 1}
                      onClick={() => withFreshAuth(() => api(`/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' })).then(() => { toast('Passkey removed'); refresh(); }).catch(fail)} />
                  </span>
                ),
              },
            ]}
          />
        </Panel>

        <Panel title="Signed-in devices" meta={sessions.data ? `${sessions.data.length}` : undefined} flush className="clip"
          actions={<Button size="sm" variant="danger" onClick={() => logout(true)}>Sign out everywhere</Button>}>
          <DataTable
            sticky={false}
            rows={sorted}
            rowKey={(s) => s.id}
            loading={sessions.isLoading}
            skeletonRows={2}
            columns={[
              {
                key: 'd', header: 'Device', wide: true,
                cell: (s) => { const d = device(s.ua); return <div className="cell">{d.mobile ? <Smartphone size={14} className="faint" style={{ flex: 'none' }} /> : <Monitor size={14} className="faint" style={{ flex: 'none' }} />}<span className="primary ellipsis">{d.label}</span>{s.current && <Badge tone="good">This device</Badge>}</div>; },
                sub: (s) => `${s.current ? 'Active now' : `Active ${ago(s.lastSeenAt)}`}${s.ip ? ` · ${s.ip}` : ''}`,
              },
              { key: 'a', header: 'Active', align: 'right', hide: 'sm', cell: (s) => <span className="muted">{s.current ? 'now' : ago(s.lastSeenAt)}</span> },
              { key: 's', header: 'Signed in', align: 'right', hide: 'md', cell: (s) => <span className="muted">{ago(s.createdAt)}</span> },
              { key: 'i', header: 'IP', hide: 'xl', cell: (s) => <span className="muted num">{s.ip || '—'}</span> },
              {
                key: 'x', shrink: true,
                cell: (s) => s.current
                  ? <Button size="sm" icon={<LogOut />} onClick={() => logout()}>Sign out</Button>
                  : <Button size="sm" variant="danger" onClick={() => api(`/sessions/${s.id}`, { method: 'DELETE' }).then(() => { toast('Device signed out'); refresh(); }).catch(fail)}>Sign out</Button>,
              },
            ]}
          />
        </Panel>
      </div>

      <Panel title="Recent activity" meta="Sign-ins, passkeys and connections" flush className="clip">
        <DataTable
          rows={events}
          rowKey={(e) => `${e.at}-${e.event}`}
          loading={audit.isLoading}
          skeletonRows={5}
          empty={<div className="dt-empty">No activity yet.</div>}
          columns={[
            { key: 'e', header: 'Event', wide: true, cell: (e) => <span className={/failed|rejected|rate_limited/.test(e.event) ? 'neg' : 'primary'}>{EVENTS[e.event]}</span>, sub: (e) => e.passkey || e.name || e.institution || '' },
            { key: 'd', header: 'Detail', hide: 'sm', cell: (e) => <span className="muted">{e.passkey || e.name || e.institution || '—'}</span> },
            { key: 'i', header: 'IP', hide: 'md', cell: (e) => <span className="muted num">{e.ip || '—'}</span> },
            { key: 'w', header: 'When', align: 'right', cell: (e) => <span className="muted num" title={new Date(e.at).toLocaleString()}>{timeAgo(e.at)}</span> },
          ]}
        />
      </Panel>

      {renaming && (
        <Modal onClose={() => setRenaming(null)}>
          <h2>Rename passkey</h2>
          <form onSubmit={(e) => { e.preventDefault(); saveName(); }} style={{ marginTop: 12 }}>
            <Field label="Name">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus maxLength={60} onFocus={(e) => e.currentTarget.select()} onClear={() => setNewName('')} />
            </Field>
            <div className="modal-actions">
              <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!newName.trim()}>Save</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
