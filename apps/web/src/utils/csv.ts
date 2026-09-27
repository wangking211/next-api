type Col<T> = { label: string; value: (row: T) => unknown };

function esc(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(cols: Col<T>[], rows: T[]): string {
  const lines = [cols.map((c) => esc(c.label)).join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => esc(c.value(r))).join(','));
  }
  return lines.join('\n');
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadCsv(filename: string, csv: string): void {
  downloadBlob(filename, new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
}
