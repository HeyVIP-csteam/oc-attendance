-- Migration 0005 — wider default punch keywords, taken from how the CS teams actually write in Telegram
-- ("Clocked in", "Log in for the day", "Taking Break", "WC", "back", "Done for the day", "Checked Out" …).
-- Only replaces the keyword list if it is still the original default; a list an admin has edited is left alone.
UPDATE system_settings
SET value = '{"CLOCK_IN":["IN","CLOCK IN","CLOCKED IN","CHECK IN","CHECKED IN","LOG IN","LOGIN","LOGGED IN","LOG IN FOR THE DAY","START OF SHIFT","START SHIFT"],"BREAK_START":["BREAK","BREAK START","BRAKE","SHORT BREAK","LUNCH BREAK","DINNER BREAK","TAKING BREAK","TAKING A BREAK","LUNCH","DINNER","WC","TOILET","CR","BRB"],"BREAK_END":["RESUME","BREAK END","BACK","I''M BACK","BACK FROM BREAK","BACK TO WORK","BREAK OVER","END BREAK"],"CLOCK_OUT":["OUT","CLOCK OUT","CLOCKED OUT","CHECK OUT","CHECKED OUT","LOG OUT","LOGOUT","LOGGED OUT","DONE FOR THE DAY","END OF SHIFT"]}',
    updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), updated_by = 'migration'
WHERE key = 'keywords'
  AND json(value) = json('{"CLOCK_IN":["IN","CLOCK IN"],"BREAK_START":["BREAK","BREAK START"],"BREAK_END":["RESUME","BREAK END"],"CLOCK_OUT":["OUT","CLOCK OUT"]}');
