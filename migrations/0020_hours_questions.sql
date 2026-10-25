-- The bot's "Incomplete working hours" question, sent with the clock-out confirmation when the shift length (breaks
-- included; a late employee counts from the clock in) was not completed. Buttons: Yes (clock out confirmed),
-- No (the clock out is cancelled — still working), Forgot clock in (an exception for the admin to approve).
-- One question per clock-out punch. IF NOT EXISTS: the Worker also creates this table on first use
-- (src/worker/lib/hoursQuestions.ts), so applying this migration before or after a deploy is harmless.
CREATE TABLE IF NOT EXISTS hours_questions (
  id               INTEGER PRIMARY KEY,
  employee_id      INTEGER NOT NULL REFERENCES employees(id),
  work_date        TEXT NOT NULL,
  out_event_id     INTEGER NOT NULL UNIQUE,   -- the clock out the question is about
  out_at           INTEGER NOT NULL,
  chat_id          INTEGER NOT NULL,
  thread_id        INTEGER,
  bot_id           INTEGER,
  tg_message_id    INTEGER,                   -- the bot's question message (its buttons)
  owner_tg_id      INTEGER,                   -- the employee's Telegram account (when only the employee may answer)
  text             TEXT NOT NULL,             -- the question as sent (shown again with the answer)
  vars             TEXT NOT NULL,             -- JSON of the filled-in fields, for the replies
  asked_at         INTEGER NOT NULL,
  answer           TEXT CHECK (answer IN ('YES','NO','FORGOT_IN')),
  answered_by      TEXT,
  answered_by_tg   INTEGER,
  answered_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hq_session ON hours_questions(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_hq_message ON hours_questions(chat_id, tg_message_id);
