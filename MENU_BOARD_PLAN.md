# Digital Menu Board — Plan & Spec

> Android-TV digital menu board for ServOS/RPOS. A read-only display surface (`?mode=menuboard`) that runs on a cheap Android TV stick, configured from Back Office, updating live.
> Status: **Phase 1 in progress** (v5.5.45x). Read alongside `CLAUDE.md`, `DECISIONS.md`, `INVARIANTS.md`, `CURRENT_WORK.md`.

## Hardware
- **Targets that sideload an Android APK:** Amazon **Fire TV Stick 4K** (reference/cheapest), Android TV / Google TV boxes, generic Android HDMI sticks, existing Sunmi.
- **Apple TV is NOT a target** (tvOS can't sideload an APK, no general browser). A future tvOS native app or a dedicated signage box would be a separate effort.
- The "app" is the existing **thin WebView wrapper** (`android/`) pointing at `…/?mode=menuboard`; add a `menuboard` product flavor (`applicationId co.posup.rpos.menuboard`, own self-update channel `latest-menuboard.json`). Content updates over the air via realtime — no APK redeploy.

## What it is
Create a **"screen"** in Back Office → choose which **categories** go on that screen → **arrange the layout** (drag/stack/span) → publish to a paired display. A venue runs several screens (a wall), each its own categories/layout. The board shows each item's **title, description, allergens, price**, marks **86'd items "Sold out"** live, updates in real time on publish, supports a **background image + fonts/colours**, and a **marketing mode** (fullscreen video/still, no menu).

## Reuse map (already exists)
| Need | Reuse |
|---|---|
| App on the stick | Android WebView wrapper + self-updater (`UpdateChecker` → Supabase `app-releases`) |
| Read-only surface pattern | `CustomerDisplaySurface.jsx` (boots, resolves location, subscribes, renders, no SyncBridge) |
| Live menu/price/86 | Supabase Realtime: `eighty_six`, `menu_items`, `stock_levels` channels; `eightySixIds` model |
| Pair a screen | `devices` + pairing code + `rpos-device` (PairingScreen/ModeSelector) |
| Branding + uploads | `online_branding`; KioskSettings/ReceiptBranding upload pattern → Storage buckets |
| Menu data | `fetchMenuCategories` / `fetchMenuItems` / `fetch86List` (raw snake_case rows); item `menu_name/description/allergens/pricing.base/visibility`, category `label/sort_order/parent_id` |

## Data model — `menu_boards` (Ops DB)
One row = one **screen's** content + style.
```
id uuid pk · location_id uuid · org_id uuid · name text
orientation 'landscape'|'portrait'  · mode 'menu'|'marketing'
layout         jsonb  { columns:'auto'|2|3|4, blocks:[{ categoryId, col, order, span }] }
display_options jsonb { showDescription, showAllergens, showPrices, showImages, soldOut:'grey'|'hide' }
theme          jsonb  { bgImageUrl, bgColor, textColor, accent, font, footerNote, logoUrl, themeMode }
marketing      jsonb  { mediaUrl, mediaType:'image'|'video', fit:'cover'|'contain' }
published_at timestamptz · version int · created_at · updated_at
```
RLS: **public SELECT** (display config is no more sensitive than the public menu it shows — consistent with `menu_items` being anon-readable for kiosk/online); INSERT/UPDATE/DELETE restricted to authenticated users with location access. Realtime enabled. A paired display is assigned a board (Phase 5); until then the surface renders the location's first board, or a synthesized default (all visible top-level categories, auto layout).

## The layout engine (the core — "works fully as a menu board")
- **Auto-fit:** render, then measure content vs one screen and scale **all** type/spacing together (single root font-size, fit-loop) so it always fills exactly one screen. 3 categories → big & roomy; 9 → shrinks gracefully. If it can't fit at the minimum readable size → **auto-paginate** (rotate pages ~12s) rather than cram.
- **Auto-balance:** pack category blocks into columns shortest-column-first so column heights are even (no lopsided board). Column count `auto` (engine picks 2–4 by content volume; portrait capped lower) or forced.
- **Manual override:** drag blocks between columns, reorder, **span 2-col / full-width** (hero "Specials"), pin. Auto-fit re-runs after a move so it still looks intentional. Stored in `layout.blocks`.

## Back Office builder (Phase 3)
Customers/Settings → "Menu Boards": list + "New screen" → designer (KioskSettings pattern) with **live preview**: screen name, orientation, mode, **category list (on/off + drag)**, per-item show toggles (description/allergens/price/image), sold-out behaviour, columns + arrange canvas, theme (bg image, accent, font), **Publish** (bumps `version` → screens refresh ~1s), **Assign to screens**, **Reload screens** (remote `location.reload()`).

## Real-time
- Menu/price/86 already stream (existing channels) → board reflects instantly.
- Board **design** changes: surface subscribes to its `menu_boards` row → on `version`/`published_at` change, re-fetch + re-render (or reload).
- **Offline-first:** render last-good from `localStorage` instantly; never blank. Subtle "reconnecting" indicator; auto-recover. **Nightly auto-reload** (~4am venue tz) + realtime heartbeat/re-subscribe to survive weeks of uptime.

## Prices & VAT
Boards show the **customer-facing price** (`pricing.base` / item price = what the guest pays). Distinct from the P&L's ex-VAT net — do not confuse the two.

## Edge cases (tracked)
1. Content overflow → auto-fit scale, then paginate. 2. Dayparting (breakfast/lunch/dinner auto-switch by item availability + tz) — Phase 7. 3. Offline/network drop → cached last-good, never white-screen. 4. Long uptime → nightly reload + re-subscribe watchdog. 5. TV overscan → ~3–5% safe-area padding; 16:9 / ultrawide / portrait responsive. 6. OLED burn-in → subtle periodic pixel-shift. 7. Variant/price-ladder items (8/10/12 wings +£) — Phase 2. 8. Empty/all-86 category → hide orphan header. 9. Video → muted+autoplay+loop, H.264 mp4, size-capped, cached. 10. Allergens → 14 UK allergens + GF/dietary badges + disclaimer footer. 11. No board/bad config → branded "Menu coming soon", never blank. 12. Cheap-stick perf → light DOM, minimal animation. 13. Multi-language (later). 14. Currency from location.

## Phases (v1 = core, phases 1–6)
1. **`menu_boards` table + `?mode=menuboard` surface** — pair/resolve location, render one screen live (menu + 86) from cache, with the auto-fit + auto-balance engine. ← current
2. **Renderer depth** — variant price ladders, allergen/dietary badges, pagination fallback, overscan safe-area.
3. **BO builder** — create/edit screens, category picker + arrange canvas, display toggles, live preview, publish.
4. **Branding + marketing mode** — bg/fonts/colours, video/image upload + fit.
5. **Assign screens + remote reload**; offline cache + nightly refresh hardening.
6. **Android `menuboard` flavor** + self-update channel + Fire TV sideload guide.
7. (v2) Dayparting, mixed menu+marketing playlist, burn-in safeguards.
