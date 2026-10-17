import { createContext, useContext } from 'react';
import type { Bi } from '../../../src/shared/codes';

export type Lang = 'zh' | 'en';
export const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'zh', setLang: () => {} });

export function useI18n() {
  const { lang, setLang } = useContext(LangCtx);
  const L = (zh: string, en: string) => (lang === 'en' ? en : zh);
  const dt = (b: Bi | string | null | undefined) => (b == null ? '' : typeof b === 'string' ? b : lang === 'en' ? b.en : b.zh);
  return { lang, setLang, L, dt };
}

export function initialLang(): Lang {
  try { const l = localStorage.getItem('att_lang'); if (l === 'en' || l === 'zh') return l; } catch { /* storage unavailable */ }
  return 'zh';
}
export function saveLang(l: Lang) { try { localStorage.setItem('att_lang', l); } catch { /* ignore */ } }

/** Parses a stored bilingual JSON detail ({"zh":..,"en":..}) */
export function parseBi(s: string | null | undefined): Bi | string | null {
  if (!s) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' && 'en' in o ? (o as Bi) : s; } catch { return s; }
}
