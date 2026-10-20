// Settings access per account (Settings → Admin accounts → Edit): every Settings tab is Off, View only or Can edit.
// The owner always has everything. "Admin accounts" can be opened too, but only the owner ever changes Settings access
// (see src/worker/routes/admins.ts).

export const SETTING_TABS = ['shift3', 'cur', 'kw', 'rules', 'msgs', 'codes', 'bot', 'admins'] as const;
export type SettingTab = (typeof SETTING_TABS)[number];
/** v = view only, e = can edit; a tab missing from the map is off (hidden) */
export type SettingLevel = 'v' | 'e';
export type SettingPerms = Partial<Record<SettingTab, SettingLevel>>;

const RANK = { v: 1, e: 2 } as const;

/** The most a tab can be given: Bot Setting is view only (tokens hidden), read-only accounts are view only everywhere. */
export const capOf = (role: 'admin' | 'viewer', tab: SettingTab): SettingLevel => (role === 'viewer' || tab === 'bot' ? 'v' : 'e');

/** Accounts saved before this existed (NULL): what they had then — Attendance rules of their own currencies. */
export const defaultPerms = (role: 'admin' | 'viewer'): SettingPerms => ({ rules: role === 'viewer' ? 'v' : 'e' });

/** Stored JSON → a clean map (unknown tabs / values dropped, each level capped). A broken value fails closed (nothing). */
export function parsePerms(raw: string | null | undefined, role: 'admin' | 'viewer'): SettingPerms {
  if (raw == null) return defaultPerms(role);
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return {}; }
  return cleanPerms(o, role);
}

export function cleanPerms(o: unknown, role: 'admin' | 'viewer'): SettingPerms {
  const out: SettingPerms = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const t of SETTING_TABS) {
    const v = (o as Record<string, unknown>)[t];
    if (v !== 'v' && v !== 'e') continue;
    out[t] = RANK[v] > RANK[capOf(role, t)] ? capOf(role, t) : v;
  }
  return out;
}

export const hasLevel = (perms: SettingPerms, tab: SettingTab, need: SettingLevel) => {
  const v = perms[tab];
  return !!v && RANK[v] >= RANK[need];
};

const TAB_EN: Record<SettingTab, string> = { shift3: 'Shift Setting', cur: 'Currency', kw: 'Punch keywords', rules: 'Attendance rules', msgs: 'Bot messages', codes: 'Roster codes', bot: 'Bot Setting', admins: 'Admin accounts' };
/** For the audit log: "Attendance rules: Can edit · Bot messages: View only" ("None" = every tab off). */
export const permsText = (p: SettingPerms): string =>
  SETTING_TABS.filter((t) => p[t]).map((t) => `${TAB_EN[t]}: ${p[t] === 'e' ? 'Can edit' : 'View only'}`).join(' · ') || 'None';
