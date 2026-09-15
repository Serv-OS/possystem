/**
 * KioskTablePanel: README 1 table panel on the start screen (replaces the mode tiles
 * after Eat in, with no page change).
 *
 * tables.status (from KioskV2Root, read at mount and on every new session):
 *   'loading'          : 10 grey placeholder buttons
 *   'ok'               : one block per zone, 5 table buttons per row, labels as stored
 *   'empty' | 'failed' : the digits keypad (1 to 4 digits), today's fallback, so a
 *                        customer can always order even when the list cannot be read
 *
 * Height: the panel takes the free height of the start screen (KioskStartScreen lets it
 * shrink) instead of the prototype's fixed 1160px cap, so a normal table list shows whole.
 * When the list is still taller, the header stays put, the tables scroll, and a white fade
 * with a down chevron sits on the bottom edge until the end of the list is reached.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import KioskKeypad from './KioskKeypad';
import { ChevronDownIcon } from './KioskIcons';

const TABLE_DIGITS_MAX = 4;

export default function KioskTablePanel({ tables, selected = '', onPick, onChangeMode , entry = 'plan', numberKind = 'table' }) {
  // v5.8.76: the kiosk's table mode (lib/kioskFlow.js kioskStartModel). 'keypad' always types the
  // number (a table, or the number on a flag); 'plan' shows the tables, keypad only as fallback.
  const keypadOnly = entry === 'keypad';
  const titleKey = !keypadOnly ? 'k2.start.whichTable' : (numberKind === 'flag' ? 'k2.start.flagTitle' : 'k2.start.typeTable');
  const status = tables?.status || 'loading';
  const groups = Array.isArray(tables?.groups) ? tables.groups : [];
  const [digits, setDigits] = useState(() => (/^\d{1,4}$/.test(selected) ? selected : ''));
  const scrollRef = useRef(null);
  const [more, setMore] = useState(false);

  // More below: the list is taller than the room it has and is not scrolled to the end.
  const checkMore = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  }, []);

  useEffect(() => {
    checkMore();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(checkMore);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [checkMore, status, tables?.groups]);

  return (
    <div style={{
      position: 'relative', background: '#FFFFFF', borderRadius: 32, overflow: 'hidden', minHeight: 0, flex: '0 1 auto',
      display: 'flex', flexDirection: 'column', animation: 'kfade .22s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '36px 36px 0', marginBottom: 26, flex: 'none' }}>
        <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--k2Ink)' }}>{t(titleKey)}</div>
        <button
          type="button"
          onClick={onChangeMode}
          style={{ border: 0, background: 'var(--k2Neutral)', borderRadius: 999, padding: '14px 24px', fontSize: 20, fontWeight: 600, color: 'var(--k2InkBody)', cursor: 'pointer', minHeight: 64 }}
        >{t('k2.common.change')}</button>
      </div>

      <div ref={scrollRef} onScroll={checkMore} style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', padding: '0 36px 40px' }}>
        <div>
          {!keypadOnly && status === 'loading' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14 }} aria-busy="true">
              {Array.from({ length: 10 }, (_, i) => (
                <button key={i} type="button" disabled aria-hidden="true" tabIndex={-1}
                  style={{ ...tableButton(false), color: 'transparent', cursor: 'default' }} />
              ))}
            </div>
          )}

          {!keypadOnly && status === 'ok' && groups.map((g, gi) => (
            <div key={g.sectionId || `g${gi}`} style={{ marginBottom: gi === groups.length - 1 ? 0 : 26 }}>
              {g.label ? (
                <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--k2InkSubtle)', marginBottom: 14 }}>
                  {g.label}
                </div>
              ) : null}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14 }}>
                {(g.tables || []).map((tb) => (
                  <button
                    key={tb.id}
                    type="button"
                    aria-pressed={selected === tb.label}
                    onClick={() => onPick(tb.label)}
                    style={tableButton(selected === tb.label)}
                  >{tb.label}</button>
                ))}
              </div>
            </div>
          ))}

          {(keypadOnly || status === 'empty' || status === 'failed') && (
            <KioskKeypad
              value={digits}
              onChange={setDigits}
              maxLength={TABLE_DIGITS_MAX}
              placeholder={t(numberKind === 'flag' ? 'k2.start.flagKeypadPlaceholder' : 'k2.start.tableKeypadPlaceholder')}
              confirmLabel={t('k2.start.continue')}
              canConfirm={digits.length > 0}
              onConfirm={(d) => onPick(d)}
            />
          )}
        </div>
      </div>

      {more ? (
        <div aria-hidden="true" style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, height: 140, pointerEvents: 'none',
          background: 'linear-gradient(to bottom, rgba(255,255,255,0), #FFFFFF 78%)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 14,
        }}>
          <span style={{ width: 56, height: 56, borderRadius: 999, background: 'var(--k2Neutral)', color: 'var(--k2InkBody)', display: 'grid', placeItems: 'center' }}>
            <ChevronDownIcon size={30} />
          </span>
        </div>
      ) : null}
    </div>
  );
}

function tableButton(active) {
  return {
    border: `2px solid ${active ? 'var(--k2PrimaryLine)' : 'var(--k2Hairline)'}`,
    background: active ? 'var(--k2PrimaryTint)' : 'var(--k2Sunken)',
    borderRadius: 18,
    height: 104,
    fontSize: 30,
    fontWeight: 800,
    color: 'var(--k2Ink)',
    cursor: 'pointer',
    padding: '0 6px',
    overflow: 'hidden',
    overflowWrap: 'anywhere',
    lineHeight: 1.05,
  };
}
