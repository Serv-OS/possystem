// src/surfaces/website/siteStyles.js
//
// The public site's stylesheet as one string. The SSR head inlines it (<style>) so the first paint
// is styled before any JS, and WebsiteSurface injects the same string on mount, so React's paint is
// identical. Every colour is a --w-* variable from theme.js: no literal colour anywhere in a rule
// that a customer sees (Peter's rule: customer screens follow the venue's Appearance branding).
// Phone first: the layout works at 390 px with a 16 px gutter; wider screens get the grid.

import { CN as C } from './blocks/classNames.js';

// 5.12.5/5.12.7: the SPA's global stylesheet pins html, body and #root to the viewport with overflow
// hidden (the till scrolls inside its own panes). A public website must scroll like a web page.
// The SSR shell injects this (api/_lib/website/shell.js) and WebsiteSurface adds it on mount for
// the client only path. Kept out of SITE_CSS on purpose: that string is also mounted inside the
// Back Office preview, where the app's pinning must stay.
export const SHELL_RESET_ID = 'w-shell-reset';
export const SHELL_RESET_CSS = 'html,body,#root{overflow:auto !important;height:auto !important;min-height:100%;position:static !important}body{overscroll-behavior:auto}';

export const SITE_CSS = `
.${C.site}{background:var(--w-bg);color:var(--w-ink);font-family:var(--w-font-body);min-height:100vh;line-height:1.55;-webkit-font-smoothing:antialiased}
.${C.site} *,.${C.site} *::before,.${C.site} *::after{box-sizing:border-box}
.${C.site} a{color:inherit}
.${C.site} img{max-width:100%;display:block}
.${C.site} h1,.${C.site} h2,.${C.site} h3,.${C.site} .${C.h2}{font-family:var(--w-font-display);line-height:1.12;margin:0 0 .5em;letter-spacing:-.01em}
.${C.site} h1{font-size:clamp(2rem,6vw,3.6rem);font-weight:700}
.${C.site} h2,.${C.site} .${C.h2}{font-size:clamp(1.5rem,4vw,2.2rem);font-weight:600}
.${C.inner}{max-width:1120px;margin:0 auto;padding:0 16px}
.${C.block}{padding:40px 0}
.${C.muted}{color:var(--w-muted)}
.${C.card}{background:var(--w-card);border:1px solid var(--w-line);border-radius:16px;padding:18px}
.${C.empty}{color:var(--w-muted);padding:18px;border:1px dashed var(--w-line);border-radius:14px;text-align:center}
.${C.btn}{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;padding:10px 20px;border-radius:var(--w-radius);font-weight:600;text-decoration:none;border:1.5px solid transparent;cursor:pointer;font-family:var(--w-font-body);font-size:1rem;line-height:1.1}
.${C.btnPrimary}{background:var(--w-brand);color:var(--w-on-brand);border-color:var(--w-brand)}
.${C.btnPrimary}:hover{background:var(--w-brand-deep);border-color:var(--w-brand-deep)}
.${C.btnSecondary}{background:transparent;color:var(--w-ink);border-color:var(--w-line)}
.${C.btnSecondary}:hover{border-color:var(--w-ink)}
.${C.btnLink}{background:none;border:0;padding:0;min-height:0;color:var(--w-brand);text-decoration:underline}
/* header + nav */
.${C.header}{position:sticky;top:0;z-index:20;background:var(--w-bg);border-bottom:1px solid var(--w-line)}
.${C.header} .${C.inner}{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px}
.${C.logo}{display:flex;align-items:center;gap:10px;text-decoration:none;font-family:var(--w-font-display);font-weight:700;font-size:1.15rem}
.${C.logo} img{height:40px;width:auto;max-width:160px;object-fit:contain}
.${C.nav}{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.${C.navLink}{padding:8px 12px;border-radius:10px;text-decoration:none;font-weight:500;color:var(--w-ink)}
.${C.navLink}:hover,.${C.navLink}[aria-current="page"]{background:var(--w-card)}
.${C.navToggle}{display:none;background:none;border:1px solid var(--w-line);border-radius:10px;padding:8px 12px;color:var(--w-ink);font:inherit}
@media (max-width:760px){
  .${C.navToggle}{display:inline-flex}
  .${C.nav}{display:none;position:absolute;left:0;right:0;top:100%;background:var(--w-bg);border-bottom:1px solid var(--w-line);padding:8px 16px 16px;flex-direction:column;align-items:stretch}
  .${C.nav}[data-open="true"]{display:flex}
}
.${C.header}[data-sticky="false"]{position:static}
.${C.headerCta}{background:var(--w-brand);color:var(--w-on-brand);font-weight:700}
.${C.headerCta}:hover{background:var(--w-brand-deep)}
/* venue switch above a menu (5.12.8) */
.${C.venueSwitch}{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px}
.${C.venueBtn}{display:inline-flex;align-items:center;min-height:40px;padding:8px 16px;border-radius:var(--w-radius);border:1.5px solid var(--w-line);color:var(--w-ink);text-decoration:none;font-weight:600}
.${C.venueBtn}:hover{border-color:var(--w-ink)}
.${C.venueBtn}[aria-current="true"]{background:var(--w-brand);color:var(--w-on-brand);border-color:var(--w-brand)}
.${C.venueForm}{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 20px}
.${C.venueForm} label{display:inline-flex;align-items:center;gap:8px;font-weight:600}
.${C.venueForm} select{min-height:40px;padding:6px 10px;border-radius:var(--w-radius);border:1.5px solid var(--w-line);background:var(--w-card);color:var(--w-ink);font:inherit}
/* row (5.12.9): columns with row and column backgrounds; nested blocks fill their column */
.${C.row}{position:relative;isolation:isolate;background-color:var(--w-row-bg,transparent);background-image:var(--w-row-img,none);background-size:cover;background-position:center}
.${C.row}[data-darken="true"]::before{content:"";position:absolute;inset:0;background:var(--w-dim);z-index:-1}
.${C.row}[data-width="wide"] .${C.rowGrid}{max-width:1400px}
.${C.row}[data-width="full"] .${C.rowGrid}{max-width:none;padding-left:0;padding-right:0}
.${C.row}[data-full="false"]{background:none}
.${C.row}[data-full="false"]::before{display:none}
.${C.row}[data-full="false"][data-bg="true"] .${C.rowGrid}{position:relative;isolation:isolate;background-color:var(--w-row-bg,transparent);background-image:var(--w-row-img,none);background-size:cover;background-position:center;border-radius:16px;padding:24px 16px}
.${C.row}[data-full="false"][data-darken="true"] .${C.rowGrid}::before{content:"";position:absolute;inset:0;background:var(--w-dim);border-radius:inherit;z-index:-1}
.${C.row}[data-tone="light"]{--w-ink:var(--w-on-photo);--w-muted:var(--w-on-photo);color:var(--w-ink)}
.${C.row}[data-tone="dark"]{--w-ink:var(--w-on-light);--w-muted:var(--w-on-light);color:var(--w-ink)}
.${C.row}[data-pad="none"]{padding:0}
.${C.row}[data-pad="small"]{padding:16px 0}
.${C.row}[data-pad="large"]{padding:72px 0}
.${C.row}[data-gap="none"]{--w-row-gap:0px}
.${C.row}[data-gap="small"]{--w-row-gap:12px}
.${C.row}[data-gap="large"]{--w-row-gap:40px}
.${C.rowGrid}{display:grid;gap:var(--w-row-gap,24px);grid-template-columns:1fr;align-items:start}
.${C.row}[data-align="center"] .${C.rowGrid}{align-items:center}
@media (min-width:760px){.${C.rowGrid}{grid-template-columns:repeat(var(--w-row-cols,2),1fr)}}
.${C.rowCol}{min-width:0}
.${C.rowCol}[data-bg="true"]{background:var(--w-col-bg);border-radius:16px;padding:20px}
.${C.rowCol} .${C.block}{padding:0}
.${C.rowCol} .${C.block}+.${C.block}{margin-top:24px}
.${C.rowCol} .${C.block} .${C.inner}{max-width:none;padding:0}
.${C.rowCol} .${C.hero}{min-height:280px;border-radius:16px}
/* image + heading blocks (5.12.10) */
.${C.image} .${C.imageBox} img{display:block;width:100%;height:auto}
.${C.image}[data-rounded="true"] .${C.imageBox} img{border-radius:var(--w-radius)}
.${C.image}[data-fit="cover"][data-height="short"] .${C.imageBox} img{height:220px;object-fit:cover}
.${C.image}[data-fit="cover"][data-height="medium"] .${C.imageBox} img{height:360px;object-fit:cover}
.${C.image}[data-fit="cover"][data-height="tall"] .${C.imageBox} img{height:520px;object-fit:cover}
.${C.image}[data-fit="contain"][data-height="short"] .${C.imageBox} img{height:220px;object-fit:contain}
.${C.image}[data-fit="contain"][data-height="medium"] .${C.imageBox} img{height:360px;object-fit:contain}
.${C.image}[data-fit="contain"][data-height="tall"] .${C.imageBox} img{height:520px;object-fit:contain}
.${C.image}[data-width="wide"] > .${C.inner}{max-width:1400px}
.${C.image}[data-width="full"] > .${C.inner}{max-width:none;padding:0}
.${C.image}[data-width="full"][data-rounded="true"] .${C.imageBox} img{border-radius:0}
.${C.imageCaption}{margin:8px 0 0;color:var(--w-muted);font-size:.95rem}
.${C.headingBlock}[data-align="center"]{text-align:center}
.${C.headingBlock} .${C.h2}{margin-bottom:6px}
.${C.headingSub}{margin:0;color:var(--w-muted)}
/* footer */
.${C.footer}{border-top:1px solid var(--w-line);padding:40px 0 60px;color:var(--w-muted);font-size:.95rem}
.${C.footer} .${C.inner}{display:grid;gap:16px}
.${C.footerLinks}{display:flex;flex-wrap:wrap;gap:8px 18px;padding:0;margin:0;list-style:none}
.${C.footerLinks} a{text-decoration:none}
.${C.powered} a{color:inherit}
/* item sheet (5.12.9): a tap on a menu card opens it; bottom sheet on a phone, centred dialog wider */
.${C.menuItem}[role="button"]{cursor:pointer}
.${C.menuItem}[role="button"]:focus-visible{outline:2px solid var(--w-brand);outline-offset:2px}
html.${C.sheetOpen},html.${C.sheetOpen} body{overflow:hidden !important}
.${C.sheetBackdrop}{position:fixed;inset:0;z-index:40;display:flex;align-items:flex-end;justify-content:center;background:var(--w-scrim);background:color-mix(in srgb,var(--w-ink) 55%,transparent);animation:w-sheet-fade .18s ease-out}
.${C.sheet}{position:relative;width:100%;max-width:560px;max-height:92dvh;overflow:auto;background:var(--w-bg);color:var(--w-ink);border:1px solid var(--w-line);border-bottom:0;border-radius:20px 20px 0 0;box-shadow:0 -12px 40px color-mix(in srgb,var(--w-ink) 25%,transparent);animation:w-sheet-rise .22s ease-out}
.${C.sheetClose}{position:absolute;top:12px;right:12px;z-index:2;width:38px;height:38px;border-radius:50%;border:1px solid var(--w-line);background:var(--w-card);color:var(--w-ink);font:inherit;font-size:1.4rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}
.${C.sheetClose}:hover{border-color:var(--w-ink)}
.${C.sheetPhoto}{display:block;width:100%;max-height:300px;aspect-ratio:16/10;object-fit:cover;background:var(--w-line)}
.${C.sheetBody}{display:grid;gap:10px;padding:18px 20px 8px}
.${C.sheetTitle}{font-size:1.45rem;margin:0;padding-right:48px}
.${C.sheet} .${C.menuDesc}{font-size:1rem}
.${C.sheetFoot}{position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 20px 20px;background:var(--w-bg);border-top:1px solid var(--w-line)}
.${C.sheetFoot} .${C.menuPrice}{font-size:1.25rem}
.${C.sheetFoot} .${C.btn}{flex:1 1 auto;max-width:320px}
@media (min-width:760px){.${C.sheetBackdrop}{align-items:center;padding:24px}.${C.sheet}{border-radius:20px;border-bottom:1px solid var(--w-line);max-height:86vh;animation-name:w-sheet-fade}.${C.sheetPhoto}{border-radius:20px 20px 0 0}}
@keyframes w-sheet-rise{from{transform:translateY(28px);opacity:.5}to{transform:none;opacity:1}}
@keyframes w-sheet-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.${C.sheetBackdrop},.${C.sheet}{animation:none}}
/* hero */
.${C.hero}{position:relative;display:flex;align-items:flex-end;background:var(--w-card);background-size:cover;background-position:center;color:var(--w-ink);overflow:hidden;isolation:isolate}
.${C.hero}[data-photo="true"]{color:var(--w-on-photo)}
.${C.hero}[data-photo="true"]::before{content:"";position:absolute;inset:0;background:var(--w-scrim);z-index:-1}
.${C.heroTall}{min-height:min(78vh,640px)}
.${C.heroShort}{min-height:320px}
.${C.heroBody}{padding:48px 16px;max-width:1120px;margin:0 auto;width:100%}
.${C.heroBody} p{font-size:clamp(1.05rem,2.4vw,1.35rem);max-width:60ch;margin:0 0 22px;opacity:.92}
.${C.heroBody} .${C.btn}+.${C.btn}{margin-left:10px}
.${C.hero}[data-photo="true"] .${C.btnSecondary}{color:var(--w-on-photo);border-color:var(--w-on-photo)}
/* hero slideshow (5.12.10): layers stacked in one grid cell, the active one fades in */
.${C.heroSlides}{display:grid;align-items:stretch}
.${C.heroSlides}::before{display:none}
.${C.heroSlide}{grid-area:1/1;position:relative;isolation:isolate;display:flex;align-items:flex-end;background:var(--w-card);background-size:cover;background-position:center;color:var(--w-ink);opacity:0;transition:opacity .8s ease;pointer-events:none}
.${C.heroSlide}[data-active="true"]{opacity:1;pointer-events:auto}
.${C.heroSlide}[data-photo="true"]{color:var(--w-on-photo)}
.${C.heroSlide}[data-photo="true"]::before{content:"";position:absolute;inset:0;background:var(--w-scrim);z-index:-1}
.${C.heroSlide}[data-photo="true"] .${C.btnSecondary}{color:var(--w-on-photo);border-color:var(--w-on-photo)}
.${C.heroDots}{grid-area:1/1;align-self:end;justify-self:center;display:flex;gap:8px;padding:0 0 14px;z-index:1}
.${C.heroDot}{width:10px;height:10px;border-radius:50%;border:0;padding:0;background:var(--w-on-photo);opacity:.45;cursor:pointer}
.${C.heroDot}[aria-selected="true"]{opacity:1;transform:scale(1.2)}
@media (prefers-reduced-motion:reduce){.${C.heroSlide}{transition:none}}
.${C.heroStatus}{display:inline-flex;align-items:center;gap:8px;font-size:.9rem;font-weight:600;margin-bottom:14px;padding:6px 12px;border-radius:999px;background:var(--w-card);color:var(--w-ink)}
.${C.heroStatus}::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--w-muted)}
.${C.heroStatus}.${C.open}::before{background:var(--w-brand)}
/* order bar */
.${C.orderBar} .${C.inner}{display:flex;flex-wrap:wrap;gap:10px}
/* menu */
.${C.menuSection}{margin-bottom:34px}
.${C.menuSection} h3{font-size:1.35rem;margin-bottom:12px}
.${C.menuGrid}{display:grid;gap:14px}
.${C.menuCards} .${C.menuGrid}{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.${C.menuItem}{display:grid;gap:8px;background:var(--w-card);border:1px solid var(--w-line);border-radius:16px;padding:14px;position:relative}
.${C.menuList} .${C.menuItem}{grid-template-columns:1fr auto;align-items:start;border-radius:12px}
.${C.menuBoard} .${C.menuGrid}{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.${C.menuBoard} .${C.menuItem}{background:transparent;border:0;border-bottom:1px solid var(--w-line);border-radius:0;padding:10px 0;grid-template-columns:1fr auto}
.${C.menuPhoto}{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;background:var(--w-line)}
.${C.menuName}{font-weight:600;font-size:1.05rem;margin:0}
.${C.menuDesc}{margin:0;color:var(--w-muted);font-size:.95rem}
.${C.menuPrice}{font-weight:700;white-space:nowrap}
.${C.menuBadges}{display:flex;gap:6px;flex-wrap:wrap}
.${C.badge}{font-size:.72rem;font-weight:700;padding:2px 7px;border-radius:999px;border:1px solid var(--w-line);color:var(--w-muted)}
.${C.menuAllergens}{font-size:.82rem;color:var(--w-muted);margin:0}
.${C.menuItemSoldOut}{opacity:.55}
.${C.soldOut}{font-size:.8rem;font-weight:600;color:var(--w-muted)}
/* embeds */
.${C.embedCard}{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.${C.iframe}{width:100%;border:1px solid var(--w-line);border-radius:16px;background:var(--w-card)}
/* loyalty + gift */
.${C.loyalty} .${C.inner},.${C.gift} .${C.inner}{display:grid;gap:22px;align-items:center}
@media (min-width:760px){.${C.loyalty} .${C.inner},.${C.gift} .${C.inner}{grid-template-columns:1.2fr 1fr}}
.${C.loyaltyCard},.${C.giftArt}{aspect-ratio:1.6;border-radius:20px;background:linear-gradient(135deg,var(--w-brand),var(--w-brand-deep));color:var(--w-on-brand);padding:22px;display:flex;flex-direction:column;justify-content:space-between;font-family:var(--w-font-display);font-weight:600;max-width:420px}
/* hours */
.${C.hoursTable}{width:100%;border-collapse:collapse;max-width:520px}
.${C.hoursTable} td{padding:9px 0;border-bottom:1px solid var(--w-line)}
.${C.hoursTable} td:last-child{text-align:right;color:var(--w-muted)}
.${C.hoursToday} td{font-weight:700;color:var(--w-ink)}
.${C.hours} h3{font-size:1.15rem;margin:18px 0 6px}
/* find us */
.${C.findusGrid}{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.${C.locCard}{display:grid;gap:10px;align-content:start}
.${C.locCard}.${C.nearest}{border-color:var(--w-brand);box-shadow:0 0 0 2px var(--w-brand) inset}
.${C.locName}{font-size:1.2rem;margin:0}
.${C.locAddr}{margin:0;color:var(--w-muted)}
.${C.locActions}{display:flex;flex-wrap:wrap;gap:8px}
.${C.nearestBtn}{margin-bottom:16px}
/* reviews */
.${C.reviews} .${C.inner}>div{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.${C.stars}{color:var(--w-brand);letter-spacing:2px}
/* blog */
.${C.blogList} .${C.inner}>div{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.${C.post}{text-decoration:none;display:grid;gap:8px}
.${C.postCover}{aspect-ratio:16/9;object-fit:cover;border-radius:12px;background:var(--w-line)}
.${C.postMeta}{color:var(--w-muted);font-size:.9rem}
.${C.postBody}{max-width:72ch}
/* content */
.${C.prose}{max-width:72ch}
.${C.prose} p,.${C.prose} li{font-size:1.05rem}
.${C.prose} img{border-radius:14px}
.${C.prose} blockquote{border-left:3px solid var(--w-brand);margin:0;padding:4px 18px;color:var(--w-muted)}
.${C.prose} code{background:var(--w-card);padding:2px 6px;border-radius:6px}
.${C.columns} .${C.inner}{display:grid;gap:24px}
@media (min-width:760px){.${C.cols2} .${C.inner}{grid-template-columns:1fr 1fr}.${C.cols3} .${C.inner}{grid-template-columns:1fr 1fr 1fr}}
.${C.gallery} .${C.inner}>div{display:grid;gap:10px;grid-template-columns:repeat(var(--w-gallery-cols,3),1fr)}
@media (max-width:600px){.${C.gallery} .${C.inner}>div{grid-template-columns:1fr 1fr}}
.${C.gallery} img{aspect-ratio:1;object-fit:cover;border-radius:12px;width:100%}
.${C.faqItem}{border-bottom:1px solid var(--w-line);padding:6px 0}
.${C.faqItem} summary{cursor:pointer;font-weight:600;padding:10px 0;font-size:1.05rem}
.${C.faqItem} div{padding:0 0 14px;color:var(--w-muted)}
.${C.divider} hr{border:0;border-top:1px solid var(--w-line);margin:0}
.${C.spacerS}{height:16px}.${C.spacerM}{height:40px}.${C.spacerL}{height:80px}
.${C.breadcrumb}{font-size:.9rem;color:var(--w-muted);padding:14px 0 0}
.${C.breadcrumb} a{text-decoration:none}
.${C.notFound}{padding:80px 16px;text-align:center}
`;
