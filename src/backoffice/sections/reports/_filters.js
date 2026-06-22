// v4.6.15: Period computation, check filters, and compare-period math.
// v4.6.24: Business-day-start + service-period support for reports.
//
// Used by every report in the reporting suite.

export const PERIODS = [
  { id:'today',      label:'Today'        },
  { id:'yesterday',  label:'Yesterday'    },
  { id:'this-week',  label:'This week'    },
  { id:'last-week',  label:'Last week'    },
  { id:'this-month', label:'This month'   },
  { id:'last-month', label:'Last month'   },
  { id:'last-7',     label:'Last 7 days'  },
  { id:'last-30',    label:'Last 30 days' },
  { id:'custom',     label:'Custom'       },
];

// v4.6.24: Build the filter row pills given the location config. Injects one
// pill per configured service period BEFORE the static list — most specific
// choices appear first. If config.shifts is empty, returns just PERIODS.
export function buildPeriods(config) {
  const shifts = config?.shifts || [];
  if (!shifts.length) return PERIODS;
  const serviceToday = shifts
    .filter(s => s.name && s.start && s.end)
    .map(s => ({
      id: `service:today:${s.id || s.name}`,
      label: `Today's ${s.name}`,
      isService: true,
      shift: s,
    }));
  return [...serviceToday, ...PERIODS];
}

const startOfDay = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = (d) => { const x = new Date(d); x.setHours(23,59,59,999); return x; };

// v4.6.24: Start of the business day that 'd' belongs to. If bds is '04:00'
// and d is 02:00 Thursday, this returns 04:00 Wednesday.
function businessDayStartFor(d, bds) {
  const [bh, bm] = (bds || '00:00').split(':').map(Number);
  const x = new Date(d);
  x.setHours(bh, bm, 0, 0);
  if (d.getTime() < x.getTime()) x.setDate(x.getDate() - 1);
  return x;
}

function businessDayEndFor(d, bds) {
  const start = businessDayStartFor(d, bds);
  const nextStart = new Date(start);
  nextStart.setDate(nextStart.getDate() + 1);
  return new Date(nextStart.getTime() - 1);
}

// Returns { from, to, prevFrom, prevTo } — prev period is same length, immediately preceding.
// v4.6.24: config = { businessDayStart: 'HH:MM', shifts: [{id,name,start,end}], timezone }
// config is optional — when absent, behaviour matches pre-v4.6.24 (midnight local).
export function getPeriodRange(periodId, custom, config = {}) {
  const now = new Date();
  const bds = config?.businessDayStart || '00:00';
  const hasBusinessDay = bds !== '00:00';

  // Service-period range: pick today's instance of a named service.
  if (typeof periodId === 'string' && periodId.startsWith('service:today:')) {
    const key = periodId.slice('service:today:'.length);
    const shifts = config?.shifts || [];
    const shift  = shifts.find(s => s.id === key || s.name === key);
    if (shift) {
      const [sh, sm] = shift.start.split(':').map(Number);
      const [eh, em] = shift.end.split(':').map(Number);
      const dayStart = hasBusinessDay ? businessDayStartFor(now, bds) : startOfDay(now);
      const from = new Date(dayStart);
      from.setHours(sh, sm, 0, 0);
      const to = new Date(dayStart);
      to.setHours(eh, em, 59, 999);
      if (from.getTime() > now.getTime()) {
        from.setDate(from.getDate() - 1);
        to.setDate(to.getDate() - 1);
      }
      if (to.getTime() <= from.getTime()) {
        to.setDate(to.getDate() + 1);
      }
      const lengthMs = to.getTime() - from.getTime();
      const prevTo   = new Date(from.getTime() - 1);
      const prevFrom = new Date(prevTo.getTime() - lengthMs);
      return { from, to, prevFrom, prevTo, kind:'service', shiftName: shift.name };
    }
  }

  const refStart = hasBusinessDay ? businessDayStartFor(now, bds) : startOfDay(now);
  const refEnd   = hasBusinessDay ? businessDayEndFor(now, bds)   : endOfDay(now);

  let from, to;
  switch (periodId) {
    case 'today':
      from = refStart; to = refEnd; break;
    case 'yesterday': {
      const y = new Date(refStart); y.setDate(refStart.getDate() - 1);
      from = y;
      to   = new Date(refStart.getTime() - 1);
      break;
    }
    case 'this-week': {
      const d = new Date(refStart); const dow = (d.getDay()+6)%7;
      d.setDate(d.getDate() - dow);
      from = d; to = refEnd; break;
    }
    case 'last-week': {
      const d = new Date(refStart); const dow = (d.getDay()+6)%7;
      d.setDate(d.getDate() - dow - 7);
      const t = new Date(d); t.setDate(d.getDate() + 6);
      from = d;
      to   = hasBusinessDay ? businessDayEndFor(t, bds) : endOfDay(t);
      break;
    }
    case 'this-month':
      from = hasBusinessDay
        ? businessDayStartFor(new Date(now.getFullYear(), now.getMonth(), 1, 12), bds)
        : startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
      to = refEnd;
      break;
    case 'last-month':
      from = hasBusinessDay
        ? businessDayStartFor(new Date(now.getFullYear(), now.getMonth()-1, 1, 12), bds)
        : startOfDay(new Date(now.getFullYear(), now.getMonth()-1, 1));
      to = hasBusinessDay
        ? businessDayEndFor(new Date(now.getFullYear(), now.getMonth(), 0, 12), bds)
        : endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
      break;
    case 'last-7': {
      const d = new Date(refStart); d.setDate(refStart.getDate() - 6);
      from = d; to = refEnd; break;
    }
    case 'last-30': {
      const d = new Date(refStart); d.setDate(refStart.getDate() - 29);
      from = d; to = refEnd; break;
    }
    case 'custom':
      from = custom?.from ? startOfDay(new Date(custom.from)) : refStart;
      to   = custom?.to   ? endOfDay(new Date(custom.to))     : refEnd;
      break;
    default:
      from = refStart; to = refEnd;
  }
  const lengthMs = to.getTime() - from.getTime();
  const prevTo   = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - lengthMs);
  return { from, to, prevFrom, prevTo };
}

export function periodLabel(periodId, custom, range) {
  if (typeof periodId === 'string' && periodId.startsWith('service:today:')) {
    if (!range) return '';
    const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
    return `${range.from.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })} \u00b7 ${fmtTime(range.from)}\u2013${fmtTime(range.to)}`;
  }
  if (periodId === 'custom' && custom?.from && custom?.to) {
    return `${new Date(custom.from).toLocaleDateString('en-GB')} \u2192 ${new Date(custom.to).toLocaleDateString('en-GB')}`;
  }
  if (!range) return '';
  const sameDay = range.from.toDateString() === range.to.toDateString();
  return sameDay
    ? range.from.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })
    : `${range.from.toLocaleDateString('en-GB', { day:'numeric', month:'short' })} \u2192 ${range.to.toLocaleDateString('en-GB', { day:'numeric', month:'short' })}`;
}

// Apply server + order type + source filters (global filters live on the shell).
// v5.5.140: source filter — pos / kiosk / online / qr — for cross-channel report slicing.
export function applyFilters(checks, filters) {
  return (checks||[]).filter(c => {
    if (filters?.server    && filters.server    !== 'all' && (c.server || '') !== filters.server)        return false;
    if (filters?.orderType && filters.orderType !== 'all' && (c.orderType || 'dine-in') !== filters.orderType) return false;
    if (filters?.source    && filters.source    !== 'all' && (c.source || 'pos') !== filters.source)     return false;
    return true;
  });
}

// Signed percent change. Null when there's no prior data to compare.
export function pctDelta(current, previous) {
  if (!previous || !isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function uniqueServers(checks) {
  const set = new Set();
  (checks||[]).forEach(c => { if (c.server) set.add(c.server); });
  return [...set].sort();
}

export function uniqueOrderTypes(checks) {
  const set = new Set();
  (checks||[]).forEach(c => set.add(c.orderType || 'dine-in'));
  return [...set].sort();
}

// v5.5.140: collect distinct order sources present in the data so the BO
// reports filter dropdown only shows options that exist (e.g. don't render
// "Online" if the venue has never had an online order). Returns sorted.
export function uniqueSources(checks) {
  const set = new Set();
  (checks||[]).forEach(c => set.add(c.source || 'pos'));
  return [...set].sort();
}

// v5.5.140: pretty labels + emoji for the source filter pills. Falls back to
// title-case of the raw value for unknown sources.
export const SOURCE_LABEL = {
  pos:      '🧾 POS',
  mpos:     '📲 Mobile POS',
  kiosk:    '📟 Kiosk',
  online:   '🌐 Online',
  qr:       '📱 QR Code',
  catering: '🍽 Catering',
  delivery: '🛵 Delivery',
};

// v4.6.24: Classify a check timestamp into one of the configured service
// periods. Returns the shift object (or null for "outside any service").
// Honors overnight services where end < start (e.g. late bar 22:00-02:00).
export function classifyShift(timestamp, shifts, businessDayStart = '00:00') {
  if (!timestamp || !shifts?.length) return null;
  const d = new Date(timestamp);
  const minutes = d.getHours() * 60 + d.getMinutes();
  for (const s of shifts) {
    if (!s.start || !s.end) continue;
    const [sh, sm] = s.start.split(':').map(Number);
    const [eh, em] = s.end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end   = eh * 60 + em;
    const inside = end > start
      ? (minutes >= start && minutes < end)
      : (minutes >= start || minutes < end);
    if (inside) return s;
  }
  return null;
}
