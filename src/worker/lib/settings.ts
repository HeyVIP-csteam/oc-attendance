import { DEFAULT_KEYWORDS, DEFAULT_PARSER, DEFAULT_RULES, type KeywordConfig, type ParserRules, type Rules, BIZ_TZ_DEFAULT } from '../../shared/codes';
import type { Env } from '../env';

export interface Settings { keywords: KeywordConfig; rules: Rules; parser: ParserRules; dataVersion: number }

export const settingsStmt = (db: D1Database) => db.prepare("SELECT key, value FROM system_settings WHERE key IN ('keywords','rules','parser','data_version')");

export function parseSettings(rows: { key: string; value: string }[]): Settings {
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const safe = <T>(s: string | undefined, d: T): T => { try { return s ? { ...d, ...JSON.parse(s) } : d; } catch { return d; } };
  const rules = safe<Rules>(m.get('rules'), DEFAULT_RULES);
  if (!(Number(rules.otHours) > 0)) rules.otHours = DEFAULT_RULES.otHours;
  delete (rules as { allowedChats?: unknown }).allowedChats; // retired setting: a group is accepted once an employee topic is bound in it
  return {
    keywords: safe<KeywordConfig>(m.get('keywords'), DEFAULT_KEYWORDS),
    rules,
    parser: safe<ParserRules>(m.get('parser'), DEFAULT_PARSER),
    dataVersion: Number(m.get('data_version') ?? 0),
  };
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  const r = await settingsStmt(db).all<{ key: string; value: string }>();
  return parseSettings(r.results ?? []);
}

export const bizTz = (env: Env): string => env.BIZ_TZ || BIZ_TZ_DEFAULT;
