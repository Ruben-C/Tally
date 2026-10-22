import { useState } from 'react';
import { Fingerprint, KeyRound, Smartphone } from 'lucide-react';
import { Field, Input } from '../components/ui';
import { deviceName, login, setup } from '../lib/auth';

const msg = (e: unknown) => {
  const m = (e as Error)?.message || String(e);
  return /NotAllowed|abort|cancel/i.test((e as Error)?.name + m) ? 'Cancelled — try again when you’re ready.' : m;
};

export function Login({ hasPasskeys, onDone }: { hasPasskeys: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brandline"><img src="/icons/icon.svg" alt="" />Tally</div>
        <h1>Sign in</h1>
        <p>Use the passkey on this device.</p>
        {hasPasskeys ? (
          <button className="btn primary block" disabled={busy}
            onClick={async () => { setBusy(true); setErr(''); try { await login(); onDone(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } }}>
            <Fingerprint /> Sign in with passkey
          </button>
        ) : (
          <p className="faint">No passkey is registered yet. Open the one-time setup link from the server to create one.</p>
        )}
        <div className="auth-err">{err}</div>
      </div>
    </div>
  );
}

export function Setup({ onDone }: { onDone: () => void }) {
  const code = new URLSearchParams(location.hash.slice(1)).get('code') || '';
  const [name, setName] = useState(deviceName());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brandline"><img src="/icons/icon.svg" alt="" />Tally</div>
        <h1>Set up this device</h1>
        <p>Create a passkey on this device. It’s the only way in: no passwords to leak.</p>
        <Field label="Passkey name" hint="So you can tell your devices apart later.">
          <Input value={name} onChange={(e) => setName(e.target.value)} lead={<Smartphone />} maxLength={60} autoComplete="off" onClear={() => setName('')} />
        </Field>
        <button className="btn primary block" disabled={busy || !code}
          onClick={async () => {
            setBusy(true); setErr('');
            try { await setup(code, name); history.replaceState(null, '', '/'); onDone(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
          }}>
          <KeyRound /> Create passkey
        </button>
        <div className="auth-err">{code ? err : 'This link is missing its setup code.'}</div>
      </div>
    </div>
  );
}
