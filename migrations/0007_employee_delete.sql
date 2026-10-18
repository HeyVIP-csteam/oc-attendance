-- Allows an admin to permanently delete an employee (e.g. a test account) together with all of their data.
-- Raw messages, events and adjustments stay append-only: a delete is only accepted while the purge marker
-- (system_settings key 'purge_employee' = that employee's id) exists. The marker is written and removed inside the
-- same atomic batch as the delete, so it never stays behind. audit_logs remain append-only without exception.

DROP TRIGGER IF EXISTS trg_messages_no_delete;
CREATE TRIGGER trg_messages_no_delete BEFORE DELETE ON telegram_messages
WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'purge_employee'
                 AND (OLD.employee_id IS NULL OR value = CAST(OLD.employee_id AS TEXT)))
BEGIN
  SELECT RAISE(ABORT, 'telegram_messages is append-only');
END;

DROP TRIGGER IF EXISTS trg_adjustments_no_delete;
CREATE TRIGGER trg_adjustments_no_delete BEFORE DELETE ON attendance_adjustments
WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'purge_employee' AND value = CAST(OLD.employee_id AS TEXT))
BEGIN
  SELECT RAISE(ABORT, 'attendance_adjustments is append-only');
END;

DROP TRIGGER IF EXISTS trg_events_no_delete;
CREATE TRIGGER trg_events_no_delete BEFORE DELETE ON attendance_events
WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'purge_employee' AND value = CAST(OLD.employee_id AS TEXT))
BEGIN
  SELECT RAISE(ABORT, 'attendance_events is append-only');
END;
