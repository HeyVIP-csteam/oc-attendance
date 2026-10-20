-- Settings access per account (Settings → Admin accounts → Edit): JSON {"rules":"e","msgs":"v",…}.
-- NULL = an account saved before this existed: Attendance rules only (what non-owners had before).
-- The Worker also adds this column on first use (src/worker/lib/perms.ts), so running this migration is optional.
ALTER TABLE admin_users ADD COLUMN settings_perms TEXT;
