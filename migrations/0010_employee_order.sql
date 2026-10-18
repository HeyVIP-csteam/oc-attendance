-- Display order of employees: the row order of the last employee / roster file that listed them (NULL = after those).
ALTER TABLE employees ADD COLUMN sort_order INTEGER;
