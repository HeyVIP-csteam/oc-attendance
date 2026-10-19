-- The bot's OT questions in the employee's topic and their answers (Settings → Attendance rules / Bot messages).
--  EARLY: asked when the employee clocks in early (YES = OT from the clock in to the shift start, NO = not OT)
--  LATE:  asked when there is no clock out the set hours after the clock in
--         (STILL = still working, no OT · OT = OT after the shift end · FORGOT = clock out set to the shift end)
CREATE TABLE ot_questions (
  id               INTEGER PRIMARY KEY,
  employee_id      INTEGER NOT NULL REFERENCES employees(id),
  work_date        TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('EARLY','LATE')),
  chat_id          INTEGER NOT NULL,
  thread_id        INTEGER,
  bot_id           INTEGER,
  tg_message_id    INTEGER,           -- the bot's question message (its buttons)
  owner_tg_id      INTEGER,           -- the employee's Telegram account (when only the employee may answer)
  in_at            INTEGER NOT NULL,  -- the clock in the question is about
  asked_at         INTEGER NOT NULL,
  answer           TEXT CHECK (answer IN ('YES','NO','STILL','OT','FORGOT')),
  answered_by      TEXT,
  answered_by_tg   INTEGER,
  answered_at      INTEGER,
  forgot_event_id  INTEGER,           -- the clock out added by "Forgot clock out"
  UNIQUE (employee_id, work_date, kind)
);
CREATE INDEX idx_otq_message ON ot_questions(chat_id, tg_message_id);
-- OT confirmed through the questions (ms); filled when sessions are recalculated
ALTER TABLE attendance_sessions ADD COLUMN ot_ms INTEGER;
-- Missing clock out now waits 16 hours after the clock in (the bot asks about OT before that): re-evaluate open sessions
UPDATE attendance_sessions SET next_check_at = 0
WHERE actual_in_at IS NOT NULL AND actual_out_at IS NULL AND work_date >= date('now', '-3 days');
