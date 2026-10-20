// Server side of the per-tab Settings access (see src/shared/perms.ts).
import { hasLevel, type SettingLevel, type SettingTab } from '../../shared/perms';
import type { Ctx } from './scope';
import { ApiError, requireAdminRole } from './http';

let ready = false;
/** Adds admin_users.settings_perms on first use, so a deploy does not depend on running the migration first. */
export async function ensurePermsColumn(db: D1Database): Promise<void> {
  if (ready) return;
  try { await db.prepare('SELECT settings_perms FROM admin_users LIMIT 0').all(); }
  catch { await db.prepare('ALTER TABLE admin_users ADD COLUMN settings_perms TEXT').run().catch(() => undefined); }
  ready = true;
}
/** Tests only. */
export const resetPermsForTests = () => { ready = false; };

const TAB_NAME: Record<SettingTab, { zh: string; en: string }> = {
  shift3: { zh: '班次设置', en: 'Shift Setting' }, cur: { zh: '货币', en: 'Currency' }, kw: { zh: '打卡关键词', en: 'Punch keywords' },
  rules: { zh: '考勤规则', en: 'Attendance rules' }, msgs: { zh: 'Bot 消息', en: 'Bot messages' }, codes: { zh: '排班代号', en: 'Roster codes' }, bot: { zh: 'Bot 设置', en: 'Bot Setting' },
  admins: { zh: '管理员账号', en: 'Admin accounts' },
};

/** The owner passes; everyone else needs the tab at that level (and an admin role to edit). */
export function requireSetting(c: Ctx, tab: SettingTab, need: SettingLevel): void {
  const a = c.get('admin');
  if (a.owner) return;
  if (need === 'e') requireAdminRole(c);
  if (!hasLevel(a.perms, tab, need)) {
    const n = TAB_NAME[tab];
    throw new ApiError(403, 'NO_SETTING_ACCESS', need === 'e'
      ? { zh: `你没有修改「${n.zh}」的权限，请联系 Owner`, en: `You cannot change "${n.en}". Ask the owner for access.` }
      : { zh: `你没有查看「${n.zh}」的权限，请联系 Owner`, en: `You cannot view "${n.en}". Ask the owner for access.` });
  }
}
