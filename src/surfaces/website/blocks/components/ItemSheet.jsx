// src/surfaces/website/blocks/components/ItemSheet.jsx
//
// 5.12.9 (Peter, 1 Nov: "I can't click on the menu to view more"). The detail sheet a menu card
// opens on the public site: photo, name, description, dietary badges, allergen words, price and
// one order button. Bottom sheet on a phone, centred dialog on a desktop. The server renders no
// sheet (it only appears after a tap), so hydration parity is untouched. What it shows comes from
// the pure model in ../itemSheet.js, which node:test covers.
//
// Colours are --w-* variables only (the venue's Appearance theme), see siteStyles.js "item sheet".

import { useEffect, useId, useRef } from 'react';
import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { menuLocation, isInternalHref } from '../../resolveHref.js';
import { itemSheetModel } from '../itemSheet.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');

/**
 * <ItemSheet item locationId onClose /> : `locationId` is the location_id prop of the block that
 * opened it, so the order button goes to the venue whose menu is on screen. The opener focuses the
 * card again after onClose.
 */
export function ItemSheet({ item, locationId, onClose }) {
  const { ctx, menuVenue, navigate } = useSite();
  const closeRef = useRef(null);
  const panelRef = useRef(null);
  const titleId = useId();
  const loc = ctx ? menuLocation(ctx, locationId) : null;
  const m = itemSheetModel(item, { ctx, loc, menuVenue, locationId });
  const close = () => { if (typeof onClose === 'function') onClose(); };

  // Open: focus the close button, lock the page behind, Escape closes, Tab stays inside. The
  // opener passes a stable onClose (useCallback), so this runs once per open.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    root.classList.add(CN.sheetOpen);
    if (closeRef.current && closeRef.current.focus) closeRef.current.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); if (typeof onClose === 'function') onClose(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { root.classList.remove(CN.sheetOpen); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  if (!item) return null;

  const onBackdrop = (e) => { if (e.target === e.currentTarget) close(); };
  const onOrder = (e) => {
    // An internal href (the choose your venue page) routes inside the site; a venue URL leaves it.
    if (!isInternalHref(m.orderHref) || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    close();
    if (typeof navigate === 'function') navigate(m.orderHref);
  };

  return (
    <div className={CN.sheetBackdrop} onClick={onBackdrop}>
      <div ref={panelRef} className={CN.sheet} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button ref={closeRef} type="button" className={CN.sheetClose} onClick={close} aria-label="Close">&times;</button>
        {m.image ? <img className={CN.sheetPhoto} src={m.image} alt="" /> : null}
        <div className={CN.sheetBody}>
          <h3 id={titleId} className={CN.sheetTitle}>{m.title || 'Menu item'}</h3>
          {m.description ? <p className={CN.menuDesc}>{m.description}</p> : null}
          {m.badges.length ? (
            <div className={CN.menuBadges}>{m.badges.map((b) => <span key={b.code} className={CN.badge} title={b.label}>{b.code}</span>)}</div>
          ) : null}
          {m.allergenText ? <p className={CN.menuAllergens}>{m.allergenText}</p> : null}
          {m.soldOut ? <span className={CN.soldOut}>Sold out today</span> : null}
        </div>
        <div className={CN.sheetFoot}>
          {m.priceText ? <div className={CN.menuPrice}>{m.priceText}</div> : <span />}
          {m.orderHref ? (
            <a className={cls(CN.btn, CN.btnPrimary)} href={m.orderHref} onClick={onOrder} {...(isInternalHref(m.orderHref) ? {} : { rel: 'noopener' })}>{m.orderLabel}</a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
