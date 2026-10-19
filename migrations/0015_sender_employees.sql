-- Telegram history import of a group without topics: which employee a Telegram account belongs to, as chosen by an
-- admin on the import page (remembered for the next import).
CREATE TABLE tg_sender_employees (
  from_user_id  INTEGER PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL
);
CREATE INDEX idx_tg_sender_emp ON tg_sender_employees(employee_id);
