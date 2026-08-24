/**
 * receiptTax.js - shared receipt tax rendering helpers (v5.7.34, receipts half).
 *
 * Two questions every receipt renderer (thermal ESC/POS, email HTML + text,
 * browser/WebView fallback) has to answer, answered ONCE here:
 *
 *   1. WORDING - taxTermFor(): what does this venue call its tax? Inclusive-only
 *      venues (every UK site) keep "VAT" exactly as today; a venue with ANY
 *      exclusive line or rate on the check says "Sales Tax".
 *
 *   2. NAMED LINES - v2ReceiptLines(): the closed check's version-2 breakdown
 *      (taxV2, written by taxCompute.js since the cutover) rendered as printable
 *      lines: name + amount, percent only for rate lines. Per-unit lines carry
 *      rate: null in the v2 record, so they print amount only - never a NaN or
 *      0% percent. Returns null when the check has no v2 record (legacy checks),
 *      and callers fall back to today's rendering unchanged.
 *
 * PURE MODULE: no imports, runs under `node --test`.
 */

/** The venue's tax vocabulary for one check: 'VAT' or 'Sales Tax'. */
export function taxTermFor(taxBk) {
  if (!taxBk || typeof taxBk !== 'object') return 'VAT';
  const v2 = taxBk.taxV2;
  if (Array.isArray(v2?.lines) && v2.lines.length) {
    return v2.lines.some(l => l?.mode === 'exclusive') ? 'Sales Tax' : 'VAT';
  }
  if (taxBk.hasExclusiveTax) return 'Sales Tax';
  const bd = taxBk.breakdown;
  if (Array.isArray(bd) && bd.some(b => b?.rate?.type === 'exclusive')) return 'Sales Tax';
  return 'VAT';
}

/**
 * Should this check render the v2 NAMED-LINES tax block at all?
 *
 * v5.7.34 UK REGRESSION FIX: post-cutover EVERY check carries a taxV2 record -
 * including every UK inclusive check, whose v2 lines are just the legacy VAT
 * rates wearing adapter ids. Rendering those through the named-lines path
 * changed the UK receipt output. The rule, applied ONCE here for every
 * renderer (thermal, HTML fallback, email, on-page):
 *
 *   v2 rendering ONLY when the record carries an exclusive or per_unit
 *   component, OR its source is 'profiles' through a non-mirror profile
 *   (a real profile line, not a 'legacy-line:<rateId>' adapter line).
 *   Pure inclusive legacy-shaped checks keep the EXACT legacy rendering -
 *   byte-identical "of which VAT" output.
 */
export function shouldRenderV2(taxBk) {
  const v2 = taxBk?.taxV2;
  const lines = v2?.lines;
  if (!Array.isArray(lines) || !lines.length) return false;
  // Any added-on component (per_unit lines are always mode 'exclusive', and
  // additionally carry rate: null) needs the named-lines rendering.
  if (lines.some(l => l && (l.mode === 'exclusive' || l.rate == null))) return true;
  // Pure inclusive: only a real profile (non-adapter line ids) earns v2.
  return v2.source === 'profiles'
    && lines.some(l => l && !String(l.lineId || '').startsWith('legacy-line:'));
}

/**
 * The v2 named tax lines of a closed check's tax breakdown, ready to print:
 *   [{ name, pct, amount, exclusive }]
 *     pct     - trimmed percent STRING ('20', '10.25') or null (per-unit lines:
 *               the v2 record stamps rate null, so no percent is ever printed)
 *     amount  - rounded line amount (number, major units)
 *     exclusive - true = added on top; false = extracted from the price
 * Zero-amount lines are dropped (matches today's "only print br.tax > 0" rule).
 * Returns null when the check should NOT use the v2 rendering (no v2 record,
 * nothing to print, or a pure inclusive legacy-shaped check - see
 * shouldRenderV2) - callers fall back to the legacy breakdown rendering,
 * which for UK inclusive checks is byte-identical to the pre-cutover output.
 */
export function v2ReceiptLines(taxBk) {
  if (!shouldRenderV2(taxBk)) return null;
  const lines = taxBk.taxV2.lines;
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    const amount = Number(l.amount) || 0;
    if (!(amount > 0.0001)) continue;
    const rate = l.rate;
    const pct = (rate == null || !Number.isFinite(Number(rate)))
      ? null
      : String(+(Number(rate) * 100).toFixed(3));
    out.push({
      name: l.name || 'Tax',
      pct,
      amount,
      exclusive: l.mode === 'exclusive',
    });
  }
  return out.length ? out : null;
}

/** "Name (20%)" for rate lines, plain "Name" for per-unit lines. */
export function taxLineLabel(l) {
  return l.pct != null ? `${l.name} (${l.pct}%)` : l.name;
}

/**
 * rate-null guard for LEGACY-SHAPED breakdown entries [{ rate, tax, ... }].
 * Per-unit lines book rate: null there (taxEngine legacyBreakdown), so any
 * renderer doing `br.rate.rate` / `br.rate.name` crashes the moment a per_unit
 * profile line sells. Answered once here:
 *
 *   breakdownPct(br, dp)  - percent STRING exactly as the legacy renderers
 *                           format it ((rate*100).toFixed(dp).replace trailing
 *                           zeros), or null when there is no rate to show.
 *                           dp 1 = '.toFixed(1).replace(".0","")' (UK style),
 *                           dp 3 = '.toFixed(3).replace(/\.?0+$/,"")',
 *                           dp 0 = '.toFixed(0)'.
 *   breakdownName(br)     - the printable line name: rate name, or the
 *                           per-unit line name the engine stamps at top level.
 *   breakdownLabel(br,dp) - "Name (20%)" or plain "Name" (no percent).
 *   breakdownIsExclusive(br) - added-on? per-unit (rate null) counts as
 *                           exclusive: it is always added on top.
 *
 * For every entry with a rate object the output strings are byte-identical to
 * the inline expressions they replace.
 */
export function breakdownPct(br, dp = 1) {
  const r = br?.rate;
  if (!r || r.rate == null || !Number.isFinite(Number(r.rate))) return null;
  const s = (Number(r.rate) * 100).toFixed(dp);
  if (dp === 1) return s.replace('.0', '');
  if (dp === 3) return s.replace(/\.?0+$/, '');
  return s;
}

export function breakdownName(br) {
  return br?.rate?.name || br?.name || 'Tax';
}

export function breakdownLabel(br, dp = 1) {
  const pct = breakdownPct(br, dp);
  const name = breakdownName(br);
  return pct != null ? `${name} (${pct}%)` : name;
}

export function breakdownIsExclusive(br) {
  return !br?.rate || br.rate.type === 'exclusive';
}
