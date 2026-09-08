# ServOS — every link (the catalog)

> **The one list of how to reach everything.** Update this file whenever a new
> surface, route, or app ships — it is generated from the code's actual routing
> (`src/App.jsx` + `src/lib/customerUrl.js`), last verified **19 Aug 2026 (v5.6.94)**. Master copy mirrored to the 'ServOS App Links' Google Doc.

**Base URLs** — both serve the SAME develop build:
- `https://possystem-liard.vercel.app` (Vercel, auto-deploys on push to develop)
- `https://dev.serv-os.app`
- Marketing site: `https://serv-os.app` (separate Next.js repo, auto-deploys on main)

Links below use `<app>` for either app host.

## Staff / venue surfaces (`?mode=...`)

| What | Link | Pairing |
|---|---|---|
| POS till | `<app>/?mode=pos` | pairs as device |
| Back Office | `<app>/?mode=office` (alias `backoffice`) | BO login |
| KDS (kitchen screen) | `<app>/?mode=kds` | pairs |
| Bar tabs | `<app>/?mode=bar` | pairs |
| Tables / floor plan | `<app>/?mode=tables` | pairs |
| Kiosk (self-order) | `<app>/?mode=kiosk` | pairs |
| MPOS (phone ordering) | `<app>/?mode=mpos` | pairs |
| Orders Hub (collection/delivery) | `<app>/?mode=orders` | pairs |
| Time Clock tablet | `<app>/?mode=clock` | pairs |
| Menu board (TV) | `<app>/?mode=menuboard` | self-pairs by code |
| Waitlist (Tables Ready) | `<app>/?mode=waitlist` | self-pairs |
| **Bookings host stand** | `<app>/?mode=bookings` | self-pairs |
| Manager app (phone) | `<app>/?mode=manager` | self-pairs |
| Owner app (KPIs) | `<app>/?mode=owner` | BO login |
| Customer display (rear screen) | `<app>/?mode=customer-display` | pairs |
| Company admin portal | `<app>/?mode=admin` | admin login |
| **Demo card reader** (NEW 19 Aug) | `<app>/?mode=readerdemo` | claim code, like a real terminal |
| Ryft sandbox harness (dev only) | `<app>/?mode=ryft-test` | none |

## Customer-facing (per venue)

Venue pages work on the venue's own host (`<slug>.serv-os.app/...`) or as
`<app>/online/<slug>` for online ordering.

| What | Link |
|---|---|
| Online ordering | `<app>/online/<slug>` or `<venue-host>/` |
| **Catering ordering** | `<venue-host>/catering` |
| QR table ordering | `<venue-host>/t/<tableId>` |
| **Booking widget** (embed + direct) | `<venue-host>/book` |
| Waitlist — join | `<venue-host>/waitlist` |
| **Waitlist — guest status page** | `<venue-host>/waitlist/status` (deep-linked with token) |
| Loyalty / customer account | `<venue-host>/account` |
| Gift cards — buy | `<venue-host>/gift` |
| Gift cards — check balance | `<venue-host>/gift/balance` |
| Review card | `<venue-host>/review` |
| WiFi captive portal | `<venue-host>/wifi` (UniFi external portal → `/guest/...` also lands here) |
| Order tracker | linked from order confirmation |
| Contract e-sign (workforce) | `/sign/<token>` (from onboarding email) |

## Android apps (sideloaded, self-updating)

| App | Where |
|---|---|
| POS (Sunmi) | `tinyurl.com/244jtfzz` (APK) — updates via `latest.json`, points at prod build |
| MPOS phone wrapper | `tinyurl.com/25zwvnr3` (APK) — updates via `latest-mpos.json` |
| Menu board (Fire TV) | `tinyurl.com/2ahdf54b` (APK) — updates via `latest-menuboard.json` |
| PaxPay (PAX A920) | `latest-paxpay.json` |

## Admin / infrastructure

| What | Link |
|---|---|
| Ops DB (Supabase) | `supabase.com/dashboard/project/tbetcegmszzotrwdtqhi` |
| Platform DB (Supabase) | `supabase.com/dashboard/project/yhzjgyrkyjabvhblqxzu` |
| Vercel (web deploys) | vercel.com → possystem |
| Adyen Customer Area (test) | `ca-test.adyen.com` |

## Dead / renamed — remove these from any old list

- `?mode=ai` — never existed as a mode; the AI assistant lives INSIDE the POS
- `?mode=staff` — removed (folded into Back Office → Workforce)
- `?mode=ops` — redirects to `?mode=manager` (retired v5.5.754)
- `<venue-host>/k` — broken kiosk shortcut, do not hand out
