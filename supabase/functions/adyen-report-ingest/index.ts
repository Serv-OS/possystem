// supabase/functions/adyen-report-ingest/index.ts
//
// ServOS Payments Phase 2 — Settlement details report ingestion (v5.6.99).
//
// Adyen reports its FEES per settlement batch, not per payment webhook: the
// merchant-level "Settlement details report" CSV carries every settled and
// refunded transaction with its interchange / scheme fees / commission /
// markup, plus batch-level fee and payout rows. adyen-webhook queues each
// REPORT_AVAILABLE announcement into platform `adyen_reports` and kicks this
// fn, which:
//   1. downloads the CSV with the Report user credentials
//      (ADYEN_REPORT_USER / ADYEN_REPORT_PASS — created in the Customer Area;
//      until they exist every ingest fails LOUDLY with a clear message and the
//      queue row stays pending for a later process_pending sweep),
//   2. parses it BY HEADER NAME (column sets vary per configuration; order is
//      never trusted; quoted fields handled; optional columns tolerated),
//   3. writes fees onto `adyen_payments` (fee_minor / fee_breakdown /
//      settled_at / payout_id / gratuity_minor),
//   4. builds one `adyen_payouts` row per settlement batch and replaces its
//      `adyen_payout_lines` (delete + insert per batch — nothing references
//      line ids, so replace is the simplest airtight idempotency).
//
// IDEMPOTENT BY CONSTRUCTION:
//   - adyen_payouts upserts on its unique `reference` = settlement:<merchantAccount>:<batch>
//   - lines are replaced wholesale per payout row
//   - adyen_payments.fee_breakdown is keyed per batch reference: re-ingesting a
//     report rewrites only its own key, and fee_minor is recomputed as the sum
//     over ALL keys — replaying any report any number of times cannot double.
//
// DURABLE FAILURE LEDGER (the swallowed-error lesson): every outcome is written
// to the adyen_reports queue row (status + error + counts) AND returned in the
// response. Nothing about a failed ingest lives only in logs.
//
// AUTH: service-role bearer ONLY. Callers: adyen-webhook's kick, and the
// operator running backfills by hand:
//   list             → known report names + status (+ whether creds are set)
//   ingest           → { report_name } or { url } — one report
//   process_pending  → sweep queued settlement reports (add retry_failed: true
//                      to also retry failures)
//
// ⚠ DEPLOY ME (edge functions deploy manually and drift silently):
//   npx supabase functions deploy adyen-report-ingest --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const REPORT_USER = Deno.env.get('ADYEN_REPORT_USER') ?? '';
const REPORT_PASS = Deno.env.get('ADYEN_REPORT_PASS') ?? '';
const CREDS_MISSING_MSG =
  'report credentials not configured yet — create a Report user in the Customer Area and set ADYEN_REPORT_USER / ADYEN_REPORT_PASS';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// Payments ledger + payouts + report queue all live in the PLATFORM DB.
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── CSV: strict RFC4180-ish parser (quoted fields, "" escapes, CR/LF/CRLF) ──
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

// ── Header resolution BY NAME, never position. Candidates cover the (GC)/(NC)
// suffixed settlement-details names plus bare fallbacks; headers are matched
// lowercased + whitespace-collapsed so cosmetic export differences cannot bite.
const HEADER_CANDIDATES: Record<string, string[]> = {
  type: ['type'],
  psp: ['psp reference'],
  merchant_account: ['merchant account'],
  merchant_reference: ['merchant reference'],
  modification_reference: ['modification reference'],
  creation_date: ['creation date'],
  gross_currency: ['gross currency'],
  gross_debit: ['gross debit (gc)', 'gross debit'],
  gross_credit: ['gross credit (gc)', 'gross credit'],
  net_currency: ['net currency'],
  net_debit: ['net debit (nc)', 'net debit'],
  net_credit: ['net credit (nc)', 'net credit'],
  commission: ['commission (nc)', 'commission'],
  markup: ['markup (nc)', 'markup'],
  scheme_fees: ['scheme fees (nc)', 'scheme fees'],
  interchange: ['interchange (nc)', 'interchange'],
  batch_number: ['batch number'],
  store: ['store'],
  gratuity: ['gratuity amount', 'gratuity (nc)', 'gratuity'],
  payment_method: ['payment method'],
};
const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');

function mapHeaders(headerRow: string[]): Record<string, number> {
  const byName = new Map<string, number>();
  headerRow.forEach((h, i) => { const n = norm(h); if (!byName.has(n)) byName.set(n, i); });
  const idx: Record<string, number> = {};
  for (const [key, candidates] of Object.entries(HEADER_CANDIDATES)) {
    for (const c of candidates) {
      const i = byName.get(c);
      if (i !== undefined) { idx[key] = i; break; }
    }
  }
  return idx;
}

// ── Money: report amounts are MAJOR units ("12.34"); ledger is minor. ───────
const CURRENCY_EXPONENT: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3 };
function toMinor(v: string | undefined, currency: string): number {
  const s = String(v ?? '').replace(/[",\s]/g, '');
  if (!s) return 0;
  const f = Number(s);
  if (!Number.isFinite(f)) return 0;
  const exp = CURRENCY_EXPONENT[currency.toUpperCase()] ?? 2;
  return Math.round(f * 10 ** exp);
}

function parseWhen(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(String(s).trim().replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Row types whose fee columns belong to a payment's fee_breakdown.
const FEE_ATTRIB_TYPES = new Set(['Settled', 'SettledExternally', 'Refunded', 'RefundedExternally']);
const SETTLE_TYPES = new Set(['Settled', 'SettledExternally']);

type ParsedLine = {
  type: string; psp: string; merchantAccount: string; batch: number;
  store: string; creationDate: string | null;
  grossDebit: number; grossCredit: number; netDebit: number; netCredit: number;
  commission: number; markup: number; schemeFees: number; interchange: number;
  gratuity: number; netCurrency: string; rawObj: Record<string, string>;
};

const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Stamp the queue row with the outcome — the durable half of every result.
async function stampReport(name: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await platformAdmin.from('adyen_reports')
    .upsert({ report_name: name, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'report_name' });
  if (error) console.error('[adyen-report-ingest] queue stamp failed:', error.message, name);
}

// ── The core: download, parse, write. Returns the full result; every failure
// is BOTH stamped onto the queue row and returned. ──────────────────────────
async function ingestReport(name: string, urlOverride: string | null): Promise<Record<string, unknown>> {
  // Queue row: source of the URL, and where the outcome lands.
  const { data: queueRow, error: qErr } = await platformAdmin.from('adyen_reports')
    .select('report_name, url, report_type, status').eq('report_name', name).maybeSingle();
  if (qErr) return { ok: false, report_name: name, error: `report queue read failed: ${qErr.message} (is migration 20260820_adyen_fees.sql applied?)` };

  const url = urlOverride || queueRow?.url || null;
  // Keep the type stamped so process_pending can sweep rows created via a
  // manual URL ingest (this fn only ever ingests settlement reports).
  const reportType = queueRow?.report_type ?? 'settlement_details';
  if (!url) {
    await stampReport(name, { report_type: reportType, status: 'failed', error: 'no download URL recorded for this report' });
    return { ok: false, report_name: name, error: 'no download URL recorded for this report' };
  }
  if (!REPORT_USER || !REPORT_PASS) {
    // Stays PENDING — this is a setup gap, not a report failure. The error text
    // is recorded so `list` shows exactly what is blocking ingestion.
    await stampReport(name, { url, report_type: reportType, status: queueRow?.status === 'ingested' ? 'ingested' : 'pending', error: CREDS_MISSING_MSG });
    return { ok: false, report_name: name, error: CREDS_MISSING_MSG };
  }

  const fail = async (msg: string) => {
    await stampReport(name, { url, report_type: reportType, status: 'failed', error: msg });
    return { ok: false, report_name: name, error: msg };
  };

  // ── 1. Download (HTTP basic auth with the Report user) ────────────────────
  let text = '';
  try {
    const res = await fetch(url, { headers: { Authorization: 'Basic ' + btoa(`${REPORT_USER}:${REPORT_PASS}`) } });
    if (!res.ok) return await fail(`report download failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    text = await res.text();
  } catch (e) {
    return await fail(`report download failed: ${(e as Error).message}`);
  }
  if (!text.trim()) return await fail('report download returned an empty body');
  if (text.trimStart().startsWith('<')) return await fail('report download returned HTML, not CSV — the Report user credentials are probably wrong');

  // ── 2. Parse by header name ───────────────────────────────────────────────
  const rows = parseCsv(text);
  if (rows.length < 2) return await fail(`report has no data rows (${rows.length} row(s) parsed)`);
  const header = rows[0];
  const idx = mapHeaders(header);
  if (idx.type === undefined || idx.batch_number === undefined || idx.net_currency === undefined) {
    return await fail(`unrecognised report format — required columns missing (Type / Batch Number / Net Currency). Headers seen: ${header.join(' | ')}`.slice(0, 900));
  }
  if (idx.psp === undefined) {
    return await fail(`unrecognised report format — no "Psp Reference" column. Headers seen: ${header.join(' | ')}`.slice(0, 900));
  }
  const get = (row: string[], key: string): string => idx[key] === undefined ? '' : String(row[idx[key]] ?? '').trim();

  const lines: ParsedLine[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const type = get(row, 'type');
    if (!type) continue;                       // trailing blank / summary rows
    const netCurrency = get(row, 'net_currency') || get(row, 'gross_currency') || 'GBP';
    const grossCurrency = get(row, 'gross_currency') || netCurrency;
    const rawObj: Record<string, string> = {};
    header.forEach((h, i) => { const v = String(row[i] ?? '').trim(); if (v !== '') rawObj[h.trim()] = v; });
    lines.push({
      type,
      psp: get(row, 'psp'),
      merchantAccount: get(row, 'merchant_account'),
      batch: Number(get(row, 'batch_number')) || 0,
      store: get(row, 'store'),
      creationDate: parseWhen(get(row, 'creation_date')),
      grossDebit: toMinor(get(row, 'gross_debit'), grossCurrency),
      grossCredit: toMinor(get(row, 'gross_credit'), grossCurrency),
      netDebit: toMinor(get(row, 'net_debit'), netCurrency),
      netCredit: toMinor(get(row, 'net_credit'), netCurrency),
      commission: toMinor(get(row, 'commission'), netCurrency),
      markup: toMinor(get(row, 'markup'), netCurrency),
      schemeFees: toMinor(get(row, 'scheme_fees'), netCurrency),
      interchange: toMinor(get(row, 'interchange'), netCurrency),
      gratuity: toMinor(get(row, 'gratuity'), netCurrency),
      netCurrency,
      rawObj,
    });
  }
  if (!lines.length) return await fail('report parsed to zero usable rows');

  // ── 3. Resolve venues: Store column → merchant_adyen_accounts.store_id ────
  const stores = [...new Set(lines.map((l) => l.store).filter(Boolean))];
  const storeToLocation = new Map<string, string>();
  if (stores.length) {
    const { data, error } = await platformAdmin.from('merchant_adyen_accounts')
      .select('store_id, location_id').in('store_id', stores);
    if (error) return await fail(`store lookup failed: ${error.message}`);
    for (const a of data ?? []) if (a.store_id && a.location_id) storeToLocation.set(a.store_id, a.location_id);
  }

  // Existing ledger rows for every psp the report touches (fallback location +
  // the fee_breakdown we merge into). A missing fee column here means the
  // hand-applied migration has not run yet — say so in as many words.
  const psps = [...new Set(lines.map((l) => l.psp).filter(Boolean))];
  const paymentRows = new Map<string, { location_id: string | null; fee_breakdown: Record<string, unknown> | null; settled_at: string | null; payout_id: string | null }>();
  for (const part of chunk(psps, 200)) {
    const { data, error } = await platformAdmin.from('adyen_payments')
      .select('psp_reference, location_id, fee_breakdown, settled_at, payout_id')
      .in('psp_reference', part);
    if (error) {
      const hint = /fee_breakdown|payout_id|does not exist/i.test(error.message)
        ? ' — apply migration 20260820_adyen_fees.sql to the platform DB first' : '';
      return await fail(`payments ledger read failed: ${error.message}${hint}`);
    }
    for (const p of data ?? []) paymentRows.set(p.psp_reference, p);
  }

  const lineLocation = (l: ParsedLine): string | null =>
    (l.store && storeToLocation.get(l.store)) || paymentRows.get(l.psp)?.location_id || null;

  // ── 4. One payout per settlement batch ────────────────────────────────────
  const groups = new Map<string, ParsedLine[]>();
  for (const l of lines) {
    const k = `${l.merchantAccount}|${l.batch}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  }

  const errors: string[] = [];
  const payoutsOut: Record<string, unknown>[] = [];
  let paymentsUpdated = 0;
  const missingPsps: string[] = [];

  for (const [, gl] of groups) {
    const merchantAccount = gl[0].merchantAccount;
    const batch = gl[0].batch;
    const reference = `settlement:${merchantAccount}:${batch}`;
    const currency = gl.find((l) => l.netCurrency)?.netCurrency ?? 'GBP';

    const payoutRows = gl.filter((l) => l.type === 'MerchantPayout');
    const nonPayout = gl.filter((l) => l.type !== 'MerchantPayout');
    const merchantPayoutNet = payoutRows.reduce((s, l) => s + (l.netDebit - l.netCredit), 0);
    const computedNet = nonPayout.reduce((s, l) => s + (l.netCredit - l.netDebit), 0);
    const netTotal = merchantPayoutNet > 0 ? merchantPayoutNet : computedNet;
    const grossTotal = nonPayout.reduce((s, l) => s + (l.grossCredit - l.grossDebit), 0);
    const feesTotal = grossTotal - netTotal;     // every deduction, incl. Fee/InvoiceDeduction rows

    const lineLocs = [...new Set(gl.map(lineLocation).filter(Boolean))] as string[];
    const payoutLocation = lineLocs.length === 1 ? lineLocs[0] : null;
    const payoutDate =
      payoutRows.map((l) => l.creationDate).find(Boolean)
      ?? gl.map((l) => l.creationDate).filter(Boolean).sort().pop()
      ?? new Date().toISOString();

    const { data: payoutRow, error: poErr } = await platformAdmin.from('adyen_payouts').upsert({
      reference,
      merchant_account: merchantAccount,
      batch_number: batch,
      location_id: payoutLocation,
      payout_date: String(payoutDate).slice(0, 10),
      currency,
      gross_minor: grossTotal,
      fees_minor: feesTotal,
      amount_minor: netTotal,                    // NET — what lands in the bank
      status: 'settled',
      report_name: name,
      raw: { report_name: name, line_count: gl.length, merchant_payout_rows: payoutRows.length, computed_net_minor: computedNet },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'reference' }).select('id').single();
    if (poErr || !payoutRow?.id) {
      errors.push(`payout upsert failed for ${reference}: ${poErr?.message ?? 'no row returned'}`);
      continue;
    }
    const payoutId = payoutRow.id as string;

    // Replace this batch's lines wholesale — airtight idempotency, and nothing
    // references adyen_payout_lines ids.
    const { error: delErr } = await platformAdmin.from('adyen_payout_lines').delete().eq('payout_id', payoutId);
    if (delErr) { errors.push(`line clear failed for ${reference}: ${delErr.message}`); continue; }
    const lineRows = gl.map((l) => ({
      payout_id: payoutId,
      psp_reference: l.psp || null,
      line_type: l.type,
      gross_minor: l.grossCredit - l.grossDebit,
      fee_minor: l.commission + l.markup + l.schemeFees + l.interchange,
      net_minor: l.netCredit - l.netDebit,
      gratuity_minor: l.gratuity || null,
      currency: l.netCurrency,
      location_id: lineLocation(l),
      raw: l.rawObj,
    }));
    for (const part of chunk(lineRows, 500)) {
      const { error: insErr } = await platformAdmin.from('adyen_payout_lines').insert(part);
      if (insErr) { errors.push(`line insert failed for ${reference}: ${insErr.message}`); break; }
    }

    // ── 5. Fees onto the payments ledger, batch-keyed for replay safety ─────
    const perPsp = new Map<string, ParsedLine[]>();
    for (const l of gl) {
      if (!l.psp || !FEE_ATTRIB_TYPES.has(l.type)) continue;
      if (!perPsp.has(l.psp)) perPsp.set(l.psp, []);
      perPsp.get(l.psp)!.push(l);
    }
    for (const [psp, pl] of perPsp) {
      const existing = paymentRows.get(psp);
      if (!existing) { missingPsps.push(psp); continue; }
      const sum = (f: (l: ParsedLine) => number) => pl.reduce((s, l) => s + f(l), 0);
      const entry = {
        interchange_minor: sum((l) => l.interchange),
        scheme_fees_minor: sum((l) => l.schemeFees),
        commission_minor: sum((l) => l.commission),
        markup_minor: sum((l) => l.markup),
        total_minor: sum((l) => l.interchange + l.schemeFees + l.commission + l.markup),
        types: [...new Set(pl.map((l) => l.type))],
        report: name,
      };
      const breakdown: Record<string, unknown> = { ...((existing.fee_breakdown as Record<string, unknown>) ?? {}) };
      breakdown[reference] = entry;
      const feeMinor = Object.values(breakdown)
        .reduce((s: number, b) => s + (Number((b as Record<string, unknown>)?.total_minor) || 0), 0);

      const patch: Record<string, unknown> = {
        fee_minor: feeMinor,
        fee_breakdown: breakdown,
        updated_at: new Date().toISOString(),
      };
      const settledLine = pl.find((l) => SETTLE_TYPES.has(l.type));
      if (settledLine) {
        // The batch that settled the sale owns settled_at + payout_id; a later
        // batch carrying only this payment's refund fee must not re-point them.
        patch.settled_at = settledLine.creationDate ?? existing.settled_at ?? new Date().toISOString();
        patch.payout_id = payoutId;
      }
      const grat = pl.reduce((s, l) => s + l.gratuity, 0);
      if (grat > 0) patch.gratuity_minor = grat;   // report beats the webhook: it itemises the tip
      const loc = lineLocation(pl[0]);
      if (!existing.location_id && loc) patch.location_id = loc;  // report heals unresolved venues

      const { error: upErr } = await platformAdmin.from('adyen_payments').update(patch).eq('psp_reference', psp);
      if (upErr) errors.push(`payment fee update failed for ${psp}: ${upErr.message}`);
      else paymentsUpdated++;
    }

    payoutsOut.push({
      reference, batch_number: batch, merchant_account: merchantAccount,
      payout_date: String(payoutDate).slice(0, 10), currency,
      gross_minor: grossTotal, fees_minor: feesTotal, net_minor: netTotal,
      line_count: gl.length, location_id: payoutLocation,
    });
  }

  const ok = errors.length === 0;
  await stampReport(name, {
    url,
    report_type: 'settlement_details',
    status: ok ? 'ingested' : 'failed',
    error: ok ? null : errors.join(' | ').slice(0, 2000),
    rows_parsed: lines.length,
    payments_updated: paymentsUpdated,
    payouts_upserted: payoutsOut.length,
    payments_missing: missingPsps.length,
    ingested_at: ok ? new Date().toISOString() : null,
  });
  return {
    ok, report_name: name, rows_parsed: lines.length,
    payouts: payoutsOut, payments_updated: paymentsUpdated,
    payments_missing: missingPsps.length, payments_missing_sample: missingPsps.slice(0, 10),
    errors,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Service-role only — this fn is internal plumbing, never called by a browser.
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim();
  if (!SERVICE_ROLE || token !== SERVICE_ROLE) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '');

  // ── list: the queue + status — the manual trigger's dashboard ─────────────
  if (action === 'list') {
    const { data, error } = await platformAdmin.from('adyen_reports')
      .select('report_name, report_type, status, error, rows_parsed, payments_updated, payouts_upserted, payments_missing, ingested_at, created_at')
      .order('created_at', { ascending: false }).limit(100);
    if (error) return json({ error: `report list failed: ${error.message} (is migration 20260820_adyen_fees.sql applied?)` }, 500);
    return json({ ok: true, creds_configured: !!(REPORT_USER && REPORT_PASS), reports: data ?? [] });
  }

  // ── ingest: one report, by queued name or by explicit URL (backfill) ──────
  if (action === 'ingest') {
    let name = String(body?.report_name ?? '').trim();
    const url = typeof body?.url === 'string' && /^https?:\/\//i.test(body.url) ? body.url : null;
    if (!name && url) name = url.split('?')[0].split('/').pop() ?? '';
    if (!name) return json({ error: 'report_name or url required' }, 400);
    const result = await ingestReport(name, url);
    return json(result, result.ok ? 200 : 500);
  }

  // ── process_pending: sweep the queue (backfill once credentials exist) ────
  if (action === 'process_pending') {
    if (!REPORT_USER || !REPORT_PASS) return json({ ok: false, error: CREDS_MISSING_MSG }, 503);
    const statuses = body?.retry_failed === true ? ['pending', 'failed'] : ['pending'];
    const { data: pending, error } = await platformAdmin.from('adyen_reports')
      .select('report_name').eq('report_type', 'settlement_details').in('status', statuses)
      .order('created_at', { ascending: true }).limit(20);
    if (error) return json({ error: `pending read failed: ${error.message}` }, 500);
    const results: Record<string, unknown>[] = [];
    for (const r of pending ?? []) results.push(await ingestReport(r.report_name, null));
    const failed = results.filter((r) => !r.ok).length;
    return json({ ok: failed === 0, processed: results.length, failed, results }, failed === 0 ? 200 : 500);
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
