// v4.6.15: CSV export used by every report. BOM-prefixed so Excel picks up UTF-8.

export function toCsv(rows, headers) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [
    headers.map(h => escape(h.label)).join(','),
    ...rows.map(r => headers.map(h => escape(typeof h.key === 'function' ? h.key(r) : r[h.key])).join(','))
  ];
  return lines.join('\r\n');
}

export function downloadCsv(filename, csv) {
  const blob = new Blob(['﻿' + csv], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
