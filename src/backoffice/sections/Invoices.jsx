/**
 * Invoices: the Purchasing > Invoices router (multi site stock Drop 3, v5.11.96, contract 3.2).
 *
 * A one site company gets today's screen (purchasing/InvoicesSite.jsx, moved there whole). A multi
 * site company gets the company invoices with match status, missing invoices, the inbox and Scan or
 * upload (purchasing/InvoicesCompany.jsx). Loading while the scope loads.
 */

import { useStockScope } from '../StockScope';
import InvoicesSite from './purchasing/InvoicesSite';
import InvoicesCompany from './purchasing/InvoicesCompany';

export default function Invoices({ orgCtx = null, siteId = null } = {}) {
  const sc = useStockScope();
  if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
  if (!sc.multi) return <InvoicesSite siteId={siteId} />;
  return <InvoicesCompany orgCtx={orgCtx} />;
}
