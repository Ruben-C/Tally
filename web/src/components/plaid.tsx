import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';
import { api } from '../lib/api';
import { useInvalidateAll } from '../lib/queries';
import { useToast } from './ui';

const LS_KEY = 'tally-link-token';

// Opens Plaid Link. Pass itemId to repair a connection (update mode). Handles the OAuth return trip too.
export function usePlaidConnect({ itemId, oauthReturn = false, onDone }: { itemId?: number; oauthReturn?: boolean; onDone?: () => void } = {}) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [token, setToken] = useState<string | null>(() => {
    if (!oauthReturn) return null;
    try {
      return localStorage.getItem(LS_KEY);
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);
  const [wantOpen, setWantOpen] = useState(oauthReturn);

  const onSuccess = useCallback(
    async (public_token: string, metadata: PlaidLinkOnSuccessMetadata) => {
      setBusy(true);
      try {
        if (itemId) {
          await api(`/plaid/items/${itemId}/repaired`, { body: {} });
          toast('Connection repaired');
        } else {
          await api('/plaid/exchange', { body: { public_token, metadata } });
          toast(`${metadata.institution?.name || 'Account'} connected — transactions are syncing`);
        }
        await invalidate();
      } catch (e) {
        toast((e as Error).message, { kind: 'error' });
      } finally {
        setBusy(false);
        setToken(null);
        try {
          localStorage.removeItem(LS_KEY);
        } catch {}
        onDone?.();
      }
    },
    [itemId, toast, invalidate, onDone],
  );

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
    onExit: (err) => {
      setWantOpen(false);
      setToken(null);
      if (err) toast(err.display_message || err.error_message || 'Plaid closed', { kind: 'error' });
      onDone?.();
    },
    ...(oauthReturn ? { receivedRedirectUri: window.location.href } : {}),
  });

  useEffect(() => {
    if (wantOpen && ready && token) {
      open();
      setWantOpen(false);
    }
  }, [wantOpen, ready, token, open]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const { link_token } = await api<{ link_token: string }>('/plaid/link-token', { body: { item_id: itemId } });
      try {
        localStorage.setItem(LS_KEY, link_token);
      } catch {}
      setToken(link_token);
      setWantOpen(true);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }, [itemId, toast]);

  return { start, busy: busy || (wantOpen && !ready) };
}
