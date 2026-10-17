// CSV / XLSX export and roster file reading — all done in the browser (keeps Worker CPU time tiny).

export function downloadBlob(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

type Cell = string | number | null;

export function exportCSV(name: string, cols: string[], rows: Cell[][]) {
  const q = (v: Cell) => {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^[=+\-@\t]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // spreadsheet formula injection guard
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = '﻿' + [cols, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
  downloadBlob(name + '.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
}

export async function exportXLSX(name: string, cols: string[], rows: Cell[][], info: [string, string][] = []) {
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  const head = cols.map((c) => ({ value: c, fontWeight: 'bold' as const }));
  const sheets: any[] = [{ data: [head, ...rows.map((r) => r.map((v) => (v === '' ? null : v)))], sheet: 'Report', columns: cols.map((c) => ({ width: Math.max(10, c.length + 2) })) }];
  if (info.length) sheets.push({ data: info, sheet: 'Info', columns: [{ width: 22 }, { width: 40 }] });
  const blob: Blob = await (writeExcelFile as any)(sheets).toBlob();
  downloadBlob(name + '.xlsx', blob);
}

export function parseCSV(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Reads a roster file into a grid of strings (dates as YYYY-MM-DD). */
export async function readGrid(file: File): Promise<(string | number | null)[][]> {
  if (/\.xlsx$/i.test(file.name)) {
    const { readSheet } = await import('read-excel-file/universal');
    const data = (await readSheet(file)) as unknown[][];
    return data.map((r) => r.map((v) => {
      if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
      if (v == null) return null;
      return typeof v === 'number' ? v : String(v);
    }));
  }
  return parseCSV(await file.text());
}
