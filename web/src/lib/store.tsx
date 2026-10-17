import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, type ApiErr } from './api';

export interface MetaEmployee { id: number; code: string; name: string; currency: string | null; status: string; thread: number | null }
export interface MetaShift { id: number; code: string; name: string; start_time: string; end_time: string; late_grace_min: number; early_grace_min: number; break_minutes: number | null; is_active: number; created_at: number; timezone: string }
export interface Meta {
  user: { id: number; username: string; role: 'admin' | 'viewer' };
  tz: string; today: string;
  currencies: { code: string; name: string; employees: number; active_employees: number }[];
  shifts: MetaShift[];
  employees: MetaEmployee[];
  keywords: Record<'CLOCK_IN' | 'BREAK_START' | 'BREAK_END' | 'CLOCK_OUT', string[]>;
  rules: { windowHours: number; lateAsException: boolean; botReply: boolean; allowedChats: number[] };
  dataVersion: number;
}

interface DataCtxT { meta: Meta; reloadMeta: () => Promise<void>; tick: number; refresh: () => void; readOnly: boolean }
export const DataCtx = createContext<DataCtxT>(null as unknown as DataCtxT);
export const useData = () => useContext(DataCtx);

/** Fetch helper that re-runs when its path changes or when the data version changes (polling / after edits). */
export function useApi<T = any>(path: string | null) {
  const { tick } = useData();
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: ApiErr | null }>({ data: null, loading: !!path, error: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const d = await api<T>(path);
      if (id === seq.current) setState({ data: d, loading: false, error: null });
    } catch (e) {
      if (id === seq.current) setState((s) => ({ data: s.data, loading: false, error: e as ApiErr }));
    }
  }, [path]);
  useEffect(() => { void load(); }, [load, tick]);
  return { ...state, reload: load };
}

/** Per-page filter state that survives navigation between pages (like the preview). */
const pageStore = new Map<string, unknown>();
export function usePageState<T extends object>(key: string, init: () => T): [T, (patch: Partial<T>) => void] {
  const [s, set] = useState<T>(() => (pageStore.get(key) as T) ?? init());
  const update = useCallback((patch: Partial<T>) => set((cur) => { const n = { ...cur, ...patch }; pageStore.set(key, n); return n; }), [key]);
  return [s, update];
}
export const resetPageStore = () => pageStore.clear();

// ---------------------------------------------------------------- toast
type ToastL = (t: string) => void;
const toastL = new Set<ToastL>();
export const toast = (t: string) => toastL.forEach((f) => f(t));
export function useToastText() {
  const [t, setT] = useState('');
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const f: ToastL = (x) => { setT(x); setOn(true); clearTimeout(timer); timer = setTimeout(() => setOn(false), 2400); };
    toastL.add(f);
    return () => { toastL.delete(f); clearTimeout(timer); };
  }, []);
  return { t, on };
}
