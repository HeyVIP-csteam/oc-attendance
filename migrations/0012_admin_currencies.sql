-- Account access.
--  * is_owner = 1: the owner — every currency, every setting, admin accounts, full audit log. Exactly the first admin.
--  * other accounts see only the currencies in `currencies` (JSON array such as ["PKR"]); NULL = all currencies,
--    which only the owner can grant ("access").
ALTER TABLE admin_users ADD COLUMN currencies TEXT;
ALTER TABLE admin_users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
UPDATE admin_users SET is_owner = 1
WHERE id = (SELECT id FROM admin_users WHERE role = 'admin' AND is_active = 1 ORDER BY created_at, id LIMIT 1);
