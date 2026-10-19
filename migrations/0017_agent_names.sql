-- Telegram history import of a group where one Telegram account is shared by several people: the employee chosen for
-- a name written in the messages ("Agent: Joan", "Break — Darsh" …), remembered for the next import.
CREATE TABLE tg_agent_names (
  name_key     TEXT PRIMARY KEY,   -- lower case, single spaces ("michael den")
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL
);
CREATE INDEX idx_tg_agent_names_emp ON tg_agent_names(employee_id);
