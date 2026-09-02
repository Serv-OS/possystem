// Deno twin of src/lib/collectionLabel.js. Keep the two in step.
function ymd(d: Date, tz: string) { return d.toLocaleDateString('en-CA', { timeZone: tz }); }
export function collectionLabel(source: unknown, tz = 'Europe/London', now = new Date()): string {
  const s = String(source ?? '').trim();
  if (!s) return '';
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;
  const inst = new Date(s);
  if (Number.isNaN(inst.getTime())) return s;
  const time = inst.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const today = ymd(now, tz);
  const that = ymd(inst, tz);
  if (that === today) return time;
  if (that === ymd(new Date(now.getTime() + 86400000), tz)) return `Tomorrow ${time}`;
  const day = inst.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}
