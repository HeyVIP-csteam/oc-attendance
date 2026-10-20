import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, type ApiErr } from './api';

export interface MetaEmployee { id: number; code: string; name: string; currency: string | null; status: string; thread: number | null }
export interface MetaShift { id: number; code: string; name: string; start_time: string; end_time: string; late_grace_min: number; early_grace_min: number; break_minutes: number | null; is_active: number; created_at: number; timezone: string }
export interface MetaRules { breakMinutes?: number | null; breakUnit?: 'h' | 'm'; lateAsException: boolean; botReply: boolean; otHours?: number; outAskMin?: number; outAskUnit?: 'h' | 'm'; earlyAskMin?: number; answerBy?: 'any' | 'own' }
/** The attendance rules of one currency. */
export const rulesOf = (m: Pick<Meta, 'rules' | 'rulesCur'>, cur: string | null | undefined): MetaRules => (cur && m.rulesCur?.[cur]) || m.rules;
export interface Meta {
  /** currencies: null = all currencies; owner: settings, accounts and bots. */
  user: { id: number; username: string; role: 'admin' | 'viewer'; currencies: string[] | null; owner: boolean };
  tz: string; today: string;
  currencies: { code: string; name: string; employees: number; active_employees: number }[];
  shifts: MetaShift[];
  employees: MetaEmployee[];
  keywords: Record<'CLOCK_IN' | 'BREAK_START' | 'BREAK_END' | 'CLOCK_OUT', string[]>;
  rules: MetaRules;
  rulesCur?: Record<string, MetaRules>; // each currency's own attendance rules
  rosterCodes?: { code: string; name: string; color: number }[];
  botTexts?: import('../../../src/shared/codes').BotTexts;
  botSwitches?: import('../../../src/shared/codes').BotSwitches;
  parser?: { skipLabels: string[]; typoTolerance: boolean; ignoreBrackets: boolean; typedTimeReview: boolean };
  dataVersion: number;
}

interface DataCtxT { meta: Meta; reloadMeta: () => Promise<void>; tick: number; refresh: () => void; readOnly: boolean; owner: boolean; nav: (page: string) => void }
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
/** Sets another page's filters before opening it (its defaults first if the page has not been opened yet). */
export function presetPage<T extends object>(key: string, init: () => T, patch: Partial<T>) {
  pageStore.set(key, { ...((pageStore.get(key) as T) ?? init()), ...patch });
}

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
