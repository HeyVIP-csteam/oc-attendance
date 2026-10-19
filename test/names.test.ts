import { it, expect } from 'vitest';
import { personName } from '../src/shared/tgexport';
it('names', () => {
  const c: [string, string | null][] = [
    ['Start of Shift Agent :Ali Khan date: 15/10/2026', 'Ali Khan'], ['Agent Name: Hasnain', 'Hasnain'], ['back', null], ['🟢 Start of Shift\nClocked in! ⏰\nAgent: Joan\nAssigned: BJ | MP', 'Joan'],
    ['Agent: [Evans Scott].', 'Evans Scott'], ['Break — Darsh', 'Darsh'], ['Log in for the day _ Michael den.', 'Michael Den'], ['Taking Break ( David )', 'David'], ['Log In\nDaemon.', 'Daemon'],
    ['Taking Break (30 min)\njoan', 'Joan'], ['Short break—— Rohan', 'Rohan'], ['Break — Darsh ( 30 min)', 'Darsh'], ['Taking Break (30 min)', null], ['Dinner Break 1 Hour', null], ['Back to work', null],
    ['Short break (joan )', 'Joan'], ['Taking a break for 30 min Daemon.', null], ['Login for the day -  Sameer Sen', 'Sameer Sen'], ['Back online — Darsh', 'Darsh'], ['Toilet break 10minute.', null], ['Done for the day.', null],
  ];
  const bad = c.filter(([t, n]) => personName(t, new Set(['in','out','back','break','resume'])) !== n).map(([t, n]) => `${JSON.stringify(t)} → ${personName(t)} (want ${n})`);
  expect(bad).toEqual([]);
});
