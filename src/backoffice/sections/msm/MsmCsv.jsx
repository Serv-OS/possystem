// src/backoffice/sections/msm/MsmCsv.jsx
//
// MULTI SITE MENU (v5.11.75): the group menu as a spreadsheet, both ways (design 4g).
//   Export: central id, product, category, size of, group price, then "<Site> price" and
//   "<Site> active" per site. Excel safe (UTF-8 with a byte order mark, prices as plain numbers, a
//   cell that would run as a formula is quoted). It shows the menu with the draft's changes in.
//   Import: matched by central id, then by name and category. It changes PRICES and ON or OFF only,
//   never adds or deletes a product. Every change, every ignored row and every error is listed
//   first; "Put in the draft" stages them, and Publish then shows exactly what changes at each site.
// Pure rules: supabase/functions/_shared/msmCsv.js (tested).

import { useMemo, useState } from 'react';
import { exportCsv, readCsvChanges } from '../../../../supabase/functions/_shared/msmCsv.js';
import { csvFileName } from '../../../lib/msm/msmPublishView';
import { changeWords } from '../../../lib/msm/msmWords';
import { withBefore } from '../../../lib/msm/msmEdit';
import { Btn, Modal, Notice, Segmented, SiteChecklist, WindowedList } from './msmUi';
import { ui } from './msmStyle';
import { draftCount } from '../../../lib/msm/msmStatus';

export default function MsmCsv({ initial = 'export', menu, live, eff, sites, rows, editable, stage, setTab, onClose }) {
  const [mode, setMode] = useState(initial);
  const [shown, setShown] = useState(() => sites.map((s) => s.id));
  const [file, setFile] = useState(null);           // { name, text }
  const [readError, setReadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [staged, setStaged] = useState(false);

  const cols = useMemo(() => sites.filter((s) => shown.includes(s.id)).map((s) => ({ location_id: s.id, name: s.name })), [sites, shown]);
  const download = () => {
    const text = exportCsv(eff, cols);
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFileName(menu?.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const pick = async (f) => {
    setReadError(''); setStaged(false);
    if (!f) { setFile(null); return; }
    if (f.size > 5 * 1024 * 1024) { setReadError('That file is over 5 MB. Export the menu, change the prices in it, and import that.'); return; }
    try { setFile({ name: f.name, text: await f.text() }); } catch { setReadError('Could not read that file.'); }
  };
  const result = useMemo(() => (file ? readCsvChanges(file.text, eff, sites.map((s) => ({ location_id: s.id, name: s.name }))) : null), [file, eff, sites]);
  const names = useMemo(() => ({
    products: new Map((eff?.products || []).map((p) => [p.id, p.menu_name || p.name])),
    categories: new Map((eff?.categories || []).map((c) => [c.id, c.label])),
    sites: new Map(sites.map((s) => [s.id, s.name])),
  }), [eff, sites]);
  const lines = useMemo(() => (result ? result.changes.map((c) => changeWords(c, names)) : []), [result, names]);

  const put = async () => {
    if (!result?.changes.length) return;
    setSaving(true);
    const r = await stage(withBefore(live, result.changes), { done: `From ${file.name}: ${draftCount(result.changes, eff).words} (in the draft).` });
    setSaving(false);
    if (r?.ok) setStaged(true);
  };

  return (
    <Modal title="Prices in Excel" sub="1 Download, 2 change prices in Excel or Google Sheets, 3 bring it back. Nothing reaches the tills until you publish." width={760} onClose={onClose}
      dirty={mode === 'import' && !!file && !staged && !saving} dirtyWords="The file you picked is not in the draft yet."
      footer={mode === 'export' ? (
        <>
          <div style={{ flex: 1, ...ui.sub }}>{(eff?.products || []).filter((p) => !p.archived).length} products, {cols.length} site{cols.length === 1 ? '' : 's'}{rows.length ? ', with the draft\'s changes in' : ''}.</div>
          <Btn kind="primary" disabled={!cols.length} onClick={download}>Download the spreadsheet</Btn>
        </>
      ) : (
        <>
          <div style={{ flex: 1, ...ui.sub }}>{result ? result.summary : 'Nothing is changed until you put it in the draft and publish it.'}</div>
          {staged
            ? <Btn kind="primary" onClick={() => { onClose(); setTab('publish'); }}>See what changes at each site</Btn>
            : <Btn kind="primary" disabled={!editable || saving || !result?.changes.length} onClick={put}>{saving ? 'Adding…' : (result?.changes.length ? `Add to draft: ${draftCount(result.changes, eff).words}` : 'Nothing to add')}</Btn>}
        </>
      )}>
      <div style={{ marginBottom: 14 }}>
        <Segmented value={mode} onChange={setMode} options={[{ value: 'export', label: '1 Download' }, { value: 'import', label: '3 Bring it back' }]} />
      </div>
      {mode === 'export' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ ...ui.sub, fontSize: 13 }}>
            One row per product: its ServOS ID, name, category, what it is a size of and the group price, then each site's own price (blank when it follows the group price) and whether it is on sale there (Yes or No).
            <br /><br />2 Change prices or Yes and No in Excel. Leave the ServOS ID column as it is. 3 Bring the file back here. New rows are ignored: add products in the menu.
          </div>
          <div>
            <span style={ui.label}>Sites in the file</span>
            <SiteChecklist sites={sites} value={shown} groups={live?.siteGroups || []} onChange={setShown} />
          </div>
        </div>
      )}
      {mode === 'import' && (
        <div>
          {!editable && <div style={{ marginBottom: 10 }}><Notice>Only editors can bring prices back in. You can still download the file.</Notice></div>}
          <input type="file" accept=".csv,text/csv" aria-label="Spreadsheet file" onChange={(e) => pick(e.target.files?.[0] || null)} style={{ fontSize: 13, marginBottom: 12 }} />
          {readError && <Notice tone="bad">{readError}</Notice>}
          {result && (
            <div style={{ display: 'grid', gap: 12 }}>
              {result.errors.length > 0 && (
                <Notice tone="bad">
                  {result.errors.length} row{result.errors.length === 1 ? '' : 's'} could not be read and {result.errors.length === 1 ? 'is' : 'are'} left out:
                  {result.errors.slice(0, 8).map((e) => <div key={`${e.line}${e.words}`}>Row {e.line}: {e.words}</div>)}
                  {result.errors.length > 8 && <div>and {result.errors.length - 8} more.</div>}
                </Notice>
              )}
              {result.ignored.length > 0 && (
                <Notice>
                  {result.ignored.length} row{result.ignored.length === 1 ? '' : 's'} ignored:
                  {result.ignored.slice(0, 6).map((e) => <div key={`${e.line}${e.words}`}>Row {e.line}: {e.words}</div>)}
                  {result.ignored.length > 6 && <div>and {result.ignored.length - 6} more.</div>}
                </Notice>
              )}
              <div>
                <span style={ui.label}>{lines.length ? `${lines.length} change${lines.length === 1 ? '' : 's'}` : 'No changes'}</span>
                <WindowedList items={lines} rowHeight={30} height={300}
                  empty={<div style={ui.sub}>The file matches the menu: nothing to change.</div>}
                  renderRow={(w) => (
                    <div style={{ fontSize: 13, borderBottom: '1px solid var(--bdr)', height: '100%', display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      <strong>{w.subject}</strong><span style={{ color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.words}</span>
                    </div>
                  )} />
              </div>
              {staged && <Notice tone="good">In the draft. Publish shows exactly what changes at each site before anything reaches a till.</Notice>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
