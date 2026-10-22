import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useMeta, useMutate } from '../../lib/queries';
import { Badge, Button, ButtonLink, FormRow, Panel, useToast } from '../../components/ui';
import { SettingsHeader } from './SettingsLayout';

export default function Data() {
  const toast = useToast();
  const meta = useMeta();
  const loadDemo = useMutate(() => api<{ transactions: number }>('/demo', { body: {} }));
  const removeDemo = useMutate(() => api('/demo', { method: 'DELETE' }));
  const recurring = useMutate(() => api<{ found: number }>('/recurring/refresh', { body: {} }));
  return (
    <>
      <SettingsHeader title="Data & privacy" sub="Your data lives on your own server. Nothing is shared beyond Plaid's read-only bank link." />
      <Panel title="Your data" foot={<span>Tally · Plaid {meta.data?.plaid.configured ? meta.data.plaid.env : 'not configured'}</span>}>
        <FormRow label="Export transactions" hint="Every transaction as CSV: date, name, amount, category, account, notes, tags.">
          <div><ButtonLink href="/api/export/transactions.csv" size="sm" icon={<Download />}>Download CSV</ButtonLink></div>
        </FormRow>
        <FormRow
          label={<span className="row">Demo data {meta.data?.demo && <Badge tone="warn">Loaded</Badge>}</span>}
          hint="Seven months of sample accounts and transactions for trying things out. Removing it leaves your real data untouched."
        >
          <div>
            {meta.data?.demo ? (
              <Button size="sm" variant="danger" icon={<Trash2 />} loading={removeDemo.isPending} onClick={() => removeDemo.mutateAsync(undefined).then(() => toast('Demo data removed'))}>Remove demo data</Button>
            ) : (
              <Button size="sm" loading={loadDemo.isPending} onClick={() => loadDemo.mutateAsync(undefined).then((r) => toast(`Loaded ${r.transactions} demo transactions`))}>Load demo data</Button>
            )}
          </div>
        </FormRow>
        <FormRow label="Re-detect recurring payments" hint="Looks through the last 13 months again for subscriptions, bills and paychecks. Hidden and renamed ones are kept.">
          <div>
            <Button size="sm" icon={<RefreshCw className={recurring.isPending ? 'spin' : ''} />} disabled={recurring.isPending} onClick={() => recurring.mutateAsync(undefined).then((r) => toast(`Found ${r.found} recurring series`))}>Run detection</Button>
          </div>
        </FormRow>
      </Panel>
    </>
  );
}
