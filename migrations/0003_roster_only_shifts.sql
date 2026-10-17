-- Migration 0003 — shifts are planned only in the roster (Shifts & Roster). The "default shift" field was removed
-- from the employee form, because employees rotate shifts.
-- This removes default-shift assignments and the FUTURE shift instances that were generated automatically from them.
-- Nothing in the past, nothing imported or edited in the roster, and nothing with attendance is touched.

-- business "today" in Asia/Colombo (UTC+05:30, no daylight saving)
-- 1. future, automatically generated, unchanged instances without any attendance
DELETE FROM shift_instances
WHERE source = 'ASSIGNMENT'
  AND adjustment_status = 'SCHEDULED'
  AND shift_date > date('now', '+330 minutes')
  AND NOT EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.shift_instance_id = shift_instances.id);

-- 2. assignments that have not started yet and are no longer referenced
DELETE FROM employee_shift_assignments
WHERE effective_from > date('now', '+330 minutes')
  AND NOT EXISTS (SELECT 1 FROM shift_instances i WHERE i.source_assignment_id = employee_shift_assignments.id);

-- 3. end the remaining (already started) assignments today so the daily job generates nothing new
UPDATE employee_shift_assignments
SET effective_until = date('now', '+330 minutes')
WHERE (effective_until IS NULL OR effective_until > date('now', '+330 minutes'))
  AND effective_from <= date('now', '+330 minutes');

-- 4. clear the stored default shift on every employee
UPDATE employees SET default_shift_id = NULL WHERE default_shift_id IS NOT NULL;

INSERT INTO audit_logs (created_at, actor, action, entity_type, entity_id, note)
VALUES (CAST(unixepoch('subsec') * 1000 AS INTEGER), 'migration', 'DEFAULT_SHIFTS_REMOVED', 'employee_shift_assignment', '0003',
        'Default shifts removed; shifts are planned in the roster only. Future auto-generated shifts without attendance were deleted.');
