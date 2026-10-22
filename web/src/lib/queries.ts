import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api } from './api';
import type { AccountAlloc, GoalDetail, GoalsResponse, Account, Budgets, Breakdown, CashMonth, Category, Dashboard, Group, Meta, NWPoint, PlaidItem, RecurDefaults, Recurring, Rule, Txn, TxnDetail } from './types';

export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/meta') });
export const useDashboard = (month?: string) => useQuery({ queryKey: ['dashboard', month], queryFn: () => api<Dashboard>(`/dashboard${month ? `?month=${month}` : ''}`) });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
export const useNetWorth = (days: number) => useQuery({ queryKey: ['networth', days], queryFn: () => api<NWPoint[]>(`/networth?days=${days}`) });
export const useBudgets = (month: string) => useQuery({ queryKey: ['budgets', month], queryFn: () => api<Budgets>(`/budgets?month=${month}`) });
export const useCashflow = (months: number) => useQuery({ queryKey: ['cashflow', months], queryFn: () => api<CashMonth[]>(`/cashflow?months=${months}`) });
export const useBreakdown = (month: string, months = 1) => useQuery({ queryKey: ['breakdown', month, months], queryFn: () => api<Breakdown>(`/breakdown?month=${month}&months=${months}`) });
export const useCategoryTrend = (id: number | null, months = 6) =>
  useQuery({ queryKey: ['trend', id, months], queryFn: () => api<{ month: string; total: number }[]>(`/categories/${id}/trend?months=${months}`), enabled: id != null });
export const useRecurring = () => useQuery({ queryKey: ['recurring'], queryFn: () => api<Recurring[]>('/recurring') });
export const useRecurringDefaults = () => useQuery({ queryKey: ['recurring', 'settings'], queryFn: () => api<RecurDefaults>('/recurring/settings') });
export const useRules = () => useQuery({ queryKey: ['rules'], queryFn: () => api<Rule[]>('/rules') });
export const usePlaidItems = () => useQuery({ queryKey: ['plaid-items'], queryFn: () => api<PlaidItem[]>('/plaid/items') });
export const useTxn = (id: number | null) => useQuery({ queryKey: ['txn', id], queryFn: () => api<TxnDetail>(`/transactions/${id}`), enabled: id != null });

export const useGoals = () => useQuery({ queryKey: ['goals'], queryFn: () => api<GoalsResponse>('/goals') });
export const useAllocations = () => useQuery({ queryKey: ['goals', 'allocations'], queryFn: () => api<AccountAlloc[]>('/goals/allocations') });
export const useGoal = (id: number | null) => useQuery({ queryKey: ['goal', id], queryFn: () => api<GoalDetail>(`/goals/${id}`), enabled: id != null });

export function useCategories() {
  const qr = useQuery({ queryKey: ['categories'], queryFn: () => api<{ groups: Group[]; categories: Category[] }>('/categories'), staleTime: 60_000 });
  const byId = new Map((qr.data?.categories || []).map((c) => [c.id, c]));
  const groupById = new Map((qr.data?.groups || []).map((g) => [g.id, g]));
  return { ...qr, byId, groupById };
}

export interface TxnFilters { q?: string; account?: number; category?: number; group?: number; reviewed?: 'false'; from?: string; to?: string; recurring?: number; kind?: 'income' | 'expense' }
export function useTransactions(f: TxnFilters, limit = 60) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  params.set('limit', String(limit));
  return useInfiniteQuery({
    queryKey: ['transactions', f, limit],
    queryFn: ({ pageParam }) => api<{ items: Txn[]; next: string | null }>(`/transactions?${params}${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next || undefined,
  });
}

// Anything that changes money data invalidates every derived view.
const DATA_KEYS = ['goals', 'goal', 'dashboard', 'transactions', 'budgets', 'cashflow', 'breakdown', 'trend', 'recurring', 'accounts', 'networth', 'meta', 'txn', 'categories', 'plaid-items', 'rules'];
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => Promise.all(DATA_KEYS.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

export function useUpdateTxn() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; category_id?: number; display_name?: string | null; notes?: string | null; reviewed?: boolean; excluded?: boolean; tags?: string[]; applyToMerchant?: boolean }) =>
      api<Txn & { applied: number }>(`/transactions/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useMutate<B = unknown, R = unknown>(fn: (b: B) => Promise<R>) {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: fn, onSuccess: invalidate });
}
