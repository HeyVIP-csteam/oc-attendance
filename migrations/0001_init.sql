-- Migration 0001 — initial schema for the Telegram Attendance system (Cloudflare D1 / SQLite)
--
-- Conventions
--   * All instants are INTEGER milliseconds since the Unix epoch (UTC).
--   * Business dates (work_date / shift_date) are TEXT 'YYYY-MM-DD' in the business time zone (Asia/Colombo).
--   * Data classes:
--       RAW (immutable):        telegram_messages (text/time/ids), attendance_events (Telegram-sourced)
--       ADMIN OVERLAY (append): attendance_adjustments, audit_logs
--       MASTER (admin-edited, audited): employees, telegram_topic_mappings, shift_templates,
--                                employee_shift_assignments, shift_instances, currencies, telegram_bots, system_settings
--       COMPUTED (rebuilt by code, never edited by hand): attendance_sessions, break_sessions,
--                                attendance_exceptions(source='COMPUTED') except their review status
--   * D1 has no interactive transactions; multi-statement writes use db.batch() which is atomic.

-- ---------------------------------------------------------------- currencies (replaces "departments")
CREATE TABLE currencies (
  code        TEXT PRIMARY KEY CHECK (length(code) BETWEEN 2 AND 10 AND code = upper(code)),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);

-- ---------------------------------------------------------------- one Telegram bot per currency
CREATE TABLE telegram_bots (
  id                 INTEGER PRIMARY KEY,
  currency_code      TEXT NOT NULL UNIQUE REFERENCES currencies(code) ON DELETE CASCADE,
  bot_user_id        INTEGER UNIQUE,
  username           TEXT,
  token_ciphertext   TEXT,          -- AES-256-GCM with the ENCRYPTION_KEY secret; never sent to the browser
  token_last4        TEXT,
  secret_salt        TEXT NOT NULL, -- webhook secret_token = HMAC-SHA256(ENCRYPTION_KEY, 'wh:'||id||':'||salt)
  webhook_url        TEXT UNIQUE,
  status             TEXT NOT NULL DEFAULT 'NOT_SET' CHECK (status IN ('NOT_SET','ACTIVE','DISABLED','ERROR')),
  can_read_all_group_messages INTEGER,
  pending_update_count INTEGER,
  last_error         TEXT,
  last_checked_at    INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- A bot row is created automatically for every new currency.
CREATE TRIGGER trg_currency_bot AFTER INSERT ON currencies
BEGIN
  INSERT INTO telegram_bots (currency_code, secret_salt, status, created_at, updated_at)
  VALUES (NEW.code, lower(hex(randomblob(16))), 'NOT_SET', NEW.created_at, NEW.created_at);
END;

-- ---------------------------------------------------------------- administrators
CREATE TABLE admin_users (
  id               INTEGER PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name     TEXT,
  password_hash    TEXT NOT NULL,   -- pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
  role             TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','viewer')),
  is_active        INTEGER NOT NULL DEFAULT 1,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     INTEGER,
  last_login_at    INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE admin_sessions (
  id            TEXT PRIMARY KEY,   -- SHA-256 of the session token (the token itself is only in the HttpOnly cookie)
  admin_id      INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_admin_sessions_admin   ON admin_sessions(admin_id);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);

-- ---------------------------------------------------------------- shift templates
CREATE TABLE shift_templates (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 3),
  name             TEXT NOT NULL,
  timezone         TEXT NOT NULL DEFAULT 'Asia/Colombo',
  start_time       TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time         TEXT NOT NULL CHECK (end_time   GLOB '[0-2][0-9]:[0-5][0-9]'),
  late_grace_min   INTEGER NOT NULL DEFAULT 5 CHECK (late_grace_min >= 0),
  early_grace_min  INTEGER NOT NULL DEFAULT 5 CHECK (early_grace_min >= 0),
  break_minutes    INTEGER CHECK (break_minutes IS NULL OR break_minutes >= 0), -- break policy: total break per shift
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (start_time <> end_time)
);

-- ---------------------------------------------------------------- employees
CREATE TABLE employees (
  id                 INTEGER PRIMARY KEY,
  employee_code      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name               TEXT NOT NULL,
  currency_code      TEXT REFERENCES currencies(code) ON DELETE RESTRICT,
  employment_status  TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (employment_status IN ('ACTIVE','INACTIVE')),
  deactivated_at     INTEGER,
  default_shift_id   INTEGER REFERENCES shift_templates(id),
  timezone           TEXT NOT NULL DEFAULT 'Asia/Colombo',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_employees_currency ON employees(currency_code);
CREATE INDEX idx_employees_status   ON employees(employment_status);

-- ---------------------------------------------------------------- topic mappings (identity = chat_id + message_thread_id)
CREATE TABLE telegram_topic_mappings (
  id                 INTEGER PRIMARY KEY,
  employee_id        INTEGER NOT NULL REFERENCES employees(id),
  chat_id            INTEGER NOT NULL,
  message_thread_id  INTEGER NOT NULL,
  valid_from         INTEGER NOT NULL,
  valid_until        INTEGER,
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CHECK ((is_active = 1 AND valid_until IS NULL) OR (is_active = 0 AND valid_until IS NOT NULL))
);
-- the same topic cannot be bound to two active employees; an employee has at most one active topic
CREATE UNIQUE INDEX uq_mapping_topic_active    ON telegram_topic_mappings(chat_id, message_thread_id) WHERE is_active = 1;
CREATE UNIQUE INDEX uq_mapping_employee_active ON telegram_topic_mappings(employee_id) WHERE is_active = 1;
CREATE INDEX idx_mapping_lookup   ON telegram_topic_mappings(chat_id, message_thread_id, valid_from);
CREATE INDEX idx_mapping_employee ON telegram_topic_mappings(employee_id, valid_from);

-- ---------------------------------------------------------------- default shift assignments (used to generate instances)
CREATE TABLE employee_shift_assignments (
  id               INTEGER PRIMARY KEY,
  employee_id      INTEGER NOT NULL REFERENCES employees(id),
  shift_id         INTEGER NOT NULL REFERENCES shift_templates(id),
  effective_from   TEXT NOT NULL,
  effective_until  TEXT,
  work_days        TEXT NOT NULL DEFAULT '0123456',  -- weekdays the shift applies (0 = Sunday)
  assigned_by      TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  CHECK (effective_until IS NULL OR effective_until >= effective_from)
);
CREATE INDEX idx_assignments_employee ON employee_shift_assignments(employee_id, effective_from);

-- ---------------------------------------------------------------- shift instances (the actual roster; parameters are snapshotted)
CREATE TABLE shift_instances (
  id                    INTEGER PRIMARY KEY,
  employee_id           INTEGER NOT NULL REFERENCES employees(id),
  shift_date            TEXT NOT NULL,
  shift_id              INTEGER NOT NULL REFERENCES shift_templates(id),
  shift_code            TEXT NOT NULL,
  shift_name            TEXT NOT NULL,
  timezone              TEXT NOT NULL,
  scheduled_start_at    INTEGER NOT NULL,
  scheduled_end_at      INTEGER NOT NULL,
  late_grace_min        INTEGER NOT NULL,
  early_grace_min       INTEGER NOT NULL,
  break_minutes         INTEGER,
  source                TEXT NOT NULL CHECK (source IN ('ASSIGNMENT','ROSTER_IMPORT','MANUAL')),
  source_assignment_id  INTEGER REFERENCES employee_shift_assignments(id),
  adjustment_status     TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (adjustment_status IN ('SCHEDULED','ADJUSTED','MANUAL','CANCELLED')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  updated_by            TEXT,
  UNIQUE (employee_id, shift_date),
  CHECK (scheduled_end_at > scheduled_start_at)
);
CREATE INDEX idx_instances_date      ON shift_instances(shift_date);
CREATE INDEX idx_instances_emp_start ON shift_instances(employee_id, scheduled_start_at);

-- ---------------------------------------------------------------- raw Telegram messages (immutable source data)
CREATE TABLE telegram_messages (
  id                    INTEGER PRIMARY KEY,
  bot_id                INTEGER REFERENCES telegram_bots(id) ON DELETE SET NULL,
  update_id             INTEGER NOT NULL,
  chat_id               INTEGER NOT NULL,
  message_id            INTEGER NOT NULL,
  message_thread_id     INTEGER,
  from_user_id          INTEGER,
  from_name             TEXT,
  from_username         TEXT,
  raw_text              TEXT,
  is_edit               INTEGER NOT NULL DEFAULT 0,
  is_forwarded          INTEGER NOT NULL DEFAULT 0,
  telegram_message_ts   INTEGER NOT NULL,   -- message.date from Telegram (seconds → ms)
  edit_ts               INTEGER,            -- edited_message.edit_date
  received_at           INTEGER NOT NULL,   -- when the Worker received the webhook
  processed_at          INTEGER,
  parsed_event_type     TEXT,
  processing_status     TEXT NOT NULL CHECK (processing_status IN
                          ('PROCESSED','IGNORED','PENDING_REVIEW','REJECTED_IDENTITY','EDITED_REVIEW','REPARSED','ERROR')),
  error_code            TEXT,
  employee_id           INTEGER REFERENCES employees(id),
  created_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_messages_update   ON telegram_messages(bot_id, update_id);
CREATE UNIQUE INDEX uq_messages_original ON telegram_messages(chat_id, message_id) WHERE is_edit = 0;
CREATE UNIQUE INDEX uq_messages_edit     ON telegram_messages(chat_id, message_id, edit_ts) WHERE is_edit = 1;
CREATE INDEX idx_messages_received ON telegram_messages(received_at);
CREATE INDEX idx_messages_status   ON telegram_messages(processing_status);

-- message content and timestamps can never be rewritten
CREATE TRIGGER trg_messages_immutable BEFORE UPDATE OF update_id, chat_id, message_id, message_thread_id, from_user_id,
  raw_text, telegram_message_ts, edit_ts, received_at, is_edit, is_forwarded ON telegram_messages
BEGIN
  SELECT RAISE(ABORT, 'telegram_messages content is immutable');
END;
CREATE TRIGGER trg_messages_no_delete BEFORE DELETE ON telegram_messages
BEGIN
  SELECT RAISE(ABORT, 'telegram_messages is append-only');
END;

-- ---------------------------------------------------------------- admin adjustments (overlay; raw events are never changed)
CREATE TABLE attendance_adjustments (
  id               INTEGER PRIMARY KEY,
  employee_id      INTEGER NOT NULL REFERENCES employees(id),
  work_date        TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('ADD_EVENT','VOID_EVENT')),
  event_type       TEXT CHECK (event_type IS NULL OR event_type IN ('CLOCK_IN','BREAK_START','BREAK_END','CLOCK_OUT')),
  event_ts         INTEGER,
  target_event_id  INTEGER,
  reason           TEXT NOT NULL CHECK (length(trim(reason)) >= 4),
  before_json      TEXT,
  after_json       TEXT,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  CHECK ((action = 'ADD_EVENT' AND event_type IS NOT NULL AND event_ts IS NOT NULL)
      OR (action = 'VOID_EVENT' AND target_event_id IS NOT NULL))
);
CREATE INDEX idx_adjustments_session ON attendance_adjustments(employee_id, work_date);
CREATE TRIGGER trg_adjustments_no_delete BEFORE DELETE ON attendance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'attendance_adjustments is append-only');
END;
CREATE TRIGGER trg_adjustments_immutable BEFORE UPDATE OF employee_id, work_date, action, event_type, event_ts,
  target_event_id, reason, created_by, created_at ON attendance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'attendance_adjustments is append-only');
END;

-- ---------------------------------------------------------------- attendance events (one per accepted punch; admin events reference an adjustment)
CREATE TABLE attendance_events (
  id                        INTEGER PRIMARY KEY,
  message_id                INTEGER UNIQUE REFERENCES telegram_messages(id),
  adjustment_id             INTEGER UNIQUE REFERENCES attendance_adjustments(id),
  employee_id               INTEGER NOT NULL REFERENCES employees(id),
  work_date                 TEXT NOT NULL,
  event_type                TEXT NOT NULL CHECK (event_type IN ('CLOCK_IN','BREAK_START','BREAK_END','CLOCK_OUT')),
  event_ts                  INTEGER NOT NULL,   -- Telegram message time (or admin-entered time)
  tg_message_id             INTEGER,            -- Telegram message_id, used to order events with identical timestamps
  received_at               INTEGER NOT NULL,
  source                    TEXT NOT NULL CHECK (source IN ('TELEGRAM','ADMIN')),
  is_voided                 INTEGER NOT NULL DEFAULT 0,
  voided_by_adjustment_id   INTEGER REFERENCES attendance_adjustments(id),
  sm_result                 TEXT,               -- state-machine result code from the last computation (NULL = accepted)
  created_at                INTEGER NOT NULL,
  CHECK ((source = 'TELEGRAM' AND message_id IS NOT NULL) OR (source = 'ADMIN' AND adjustment_id IS NOT NULL))
);
CREATE INDEX idx_events_session ON attendance_events(employee_id, work_date);
CREATE INDEX idx_events_emp_ts  ON attendance_events(employee_id, event_ts);
CREATE INDEX idx_events_created ON attendance_events(created_at);
CREATE TRIGGER trg_events_immutable BEFORE UPDATE OF message_id, adjustment_id, employee_id, event_type, event_ts,
  tg_message_id, received_at, source, created_at ON attendance_events
BEGIN
  SELECT RAISE(ABORT, 'attendance_events core fields are immutable');
END;
CREATE TRIGGER trg_events_no_delete BEFORE DELETE ON attendance_events
BEGIN
  SELECT RAISE(ABORT, 'attendance_events is append-only');
END;

-- ---------------------------------------------------------------- computed sessions (one per employee per work date)
CREATE TABLE attendance_sessions (
  id                   INTEGER PRIMARY KEY,
  employee_id          INTEGER NOT NULL REFERENCES employees(id),
  work_date            TEXT NOT NULL,
  shift_instance_id    INTEGER REFERENCES shift_instances(id) ON DELETE SET NULL,
  state                TEXT NOT NULL CHECK (state IN ('NOT_STARTED','WORKING','ON_BREAK','COMPLETED')),
  status               TEXT NOT NULL,
  missing              TEXT NOT NULL DEFAULT 'NONE',
  scheduled_start_at   INTEGER,
  scheduled_end_at     INTEGER,
  actual_in_at         INTEGER,
  actual_out_at        INTEGER,
  late_min             INTEGER,
  early_min            INTEGER,
  break_count          INTEGER NOT NULL DEFAULT 0,
  open_break_count     INTEGER NOT NULL DEFAULT 0,
  total_break_ms       INTEGER NOT NULL DEFAULT 0,
  shift_duration_ms    INTEGER,
  net_worked_ms        INTEGER,
  break_exceeded       INTEGER,
  exception_count      INTEGER NOT NULL DEFAULT 0,
  has_major_exception  INTEGER NOT NULL DEFAULT 0,
  adjusted             INTEGER NOT NULL DEFAULT 0,
  event_count          INTEGER NOT NULL DEFAULT 0,
  next_check_at        INTEGER,   -- when the status may change by the passage of time (cron re-evaluates)
  computed_at          INTEGER NOT NULL,
  UNIQUE (employee_id, work_date)
);
CREATE INDEX idx_sessions_date   ON attendance_sessions(work_date, status);
CREATE INDEX idx_sessions_next   ON attendance_sessions(next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX idx_sessions_inst   ON attendance_sessions(shift_instance_id);

CREATE TABLE break_sessions (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  start_at     INTEGER NOT NULL,
  end_at       INTEGER,
  duration_ms  INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  UNIQUE (session_id, seq)
);

-- ---------------------------------------------------------------- exceptions (ingest-time + computed); review status is admin-editable
CREATE TABLE attendance_exceptions (
  id            INTEGER PRIMARY KEY,
  dedupe_key    TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL CHECK (source IN ('INGEST','COMPUTED')),
  code          TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('HIGH','MEDIUM','LOW')),
  employee_id   INTEGER REFERENCES employees(id),
  work_date     TEXT NOT NULL,
  occurred_at   INTEGER NOT NULL,
  message_id    INTEGER REFERENCES telegram_messages(id),
  event_id      INTEGER REFERENCES attendance_events(id),
  detail        TEXT,          -- JSON {"zh": "...", "en": "..."}
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  note          TEXT,
  handled_by    TEXT,
  handled_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_exceptions_status   ON attendance_exceptions(status, occurred_at);
CREATE INDEX idx_exceptions_occurred ON attendance_exceptions(occurred_at);
CREATE INDEX idx_exceptions_session  ON attendance_exceptions(employee_id, work_date);

-- ---------------------------------------------------------------- audit log (append-only)
CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  note         TEXT,
  ip           TEXT
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_entity  ON audit_logs(entity_type, entity_id);
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

-- ---------------------------------------------------------------- settings (JSON values)
CREATE TABLE system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
