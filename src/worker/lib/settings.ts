import { DEFAULT_KEYWORDS, DEFAULT_PARSER, DEFAULT_RULES, type KeywordConfig, type ParserRules, type RosterCode, type Rules, BIZ_TZ_DEFAULT } from '../../shared/codes';
import type { Env } from '../env';

/** rules = the base set (also used for a currency that was never saved); rulesCur = each saved currency's own complete set. */
export interface Settings { keywords: KeywordConfig; rules: Rules; rulesCur: Record<string, Rules>; parser: ParserRules; rosterCodes: RosterCode[]; dataVersion: number }

/** The attendance rules of one currency (every currency has its own set; an unsaved currency starts from the base set). */
export function rulesFor(s: Pick<Settings, 'rules' | 'rulesCur'>, cur: string | null | undefined): Rules {
  return (cur && s.rulesCur[cur]) || s.rules;
}

export const settingsStmt = (db: D1Database) => db.prepare("SELECT key, value FROM system_settings WHERE key IN ('keywords','rules','rules_cur','parser','roster_codes','data_version')");

export function parseSettings(rows: { key: string; value: string }[]): Settings {
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const safe = <T>(s: string | undefined, d: T): T => { try { return s ? { ...d, ...JSON.parse(s) } : d; } catch { return d; } };
  const rules = safe<Rules>(m.get('rules'), DEFAULT_RULES);
  if (!(Number(rules.otHours) > 0)) rules.otHours = DEFAULT_RULES.otHours;
  if (!(Number(rules.forgotOutHours) > 0)) rules.forgotOutHours = DEFAULT_RULES.forgotOutHours;
  delete (rules as { allowedChats?: unknown }).allowedChats; // retired setting: a group is accepted once an employee topic is bound in it
  const rulesCur: Record<string, Rules> = {};
  for (const [cur, r] of Object.entries(safe<Record<string, Partial<Rules>>>(m.get('rules_cur'), {}))) {
    if (!r || typeof r !== 'object') continue;
    const x = { ...rules, ...r } as Rules;
    if (!(Number(x.otHours) > 0)) x.otHours = rules.otHours;
    if (!(Number(x.forgotOutHours) > 0)) x.forgotOutHours = rules.forgotOutHours;
    rulesCur[cur] = x;
  }
  return {
    keywords: safe<KeywordConfig>(m.get('keywords'), DEFAULT_KEYWORDS),
    rules,
    rulesCur,
    parser: safe<ParserRules>(m.get('parser'), DEFAULT_PARSER),
    rosterCodes: (() => { try { const v = JSON.parse(m.get('roster_codes') ?? '[]'); return Array.isArray(v) ? (v as RosterCode[]) : []; } catch { return []; } })(),
    dataVersion: Number(m.get('data_version') ?? 0),
  };
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  const r = await settingsStmt(db).all<{ key: string; value: string }>();
  return parseSettings(r.results ?? []);
}

export const bizTz = (env: Env): string => env.BIZ_TZ || BIZ_TZ_DEFAULT;
