# Serv OS (RPOS)

Multi-tenant, multi-device SaaS **point-of-sale for hospitality**.

- **Live:** https://possystem-liard.vercel.app
- **Repo:** `Serv-OS/possystem`
- **Current build:** see `src/lib/version.js`

## Surfaces
POS · Back Office · KDS · Bar · Tables · Kiosk · MPOS · Orders Hub · Online Ordering · Customer Portal · Gift Cards · QR Order · AI Assistant
(each is a mode of the same app, e.g. `?mode=pos`, `?mode=kiosk`, `/online/:slug`)

## Stack
React 19 + Vite (no TypeScript) · Zustand · Supabase (Postgres / Realtime / Storage / Edge Functions) · Stripe (Terminal in-person + Checkout online) · Vercel (frontend) · Android WebView wrapper for Sunmi hardware.

## Develop
```bash
npm install
npm run dev      # mock mode — no Supabase needed
npm run build    # verify clean before pushing
```
Real keys live in Vercel env vars; local `.env.local` runs in mock mode.

## Deploy
```bash
# Frontend → push to develop, Vercel auto-deploys
git add … && git commit -m "vX.Y.Z — …" && git push origin develop
```
**Every web deploy:** bump `src/lib/version.js` AND add a top-of-`CHANGELOG` entry in `src/App.jsx`.

Edge functions deploy via the Supabase CLI + a personal access token (see `CLAUDE.md`).
The Android app is built by GitHub Actions and self-updates (see `android/RELEASING.md`).

## Read these first
| File | What |
|---|---|
| `CLAUDE.md` | Architecture, folder map, conventions, hard-won gotchas |
| `DECISIONS.md` | Architecture decision records (ADRs) |
| `INVARIANTS.md` | Rules that must never be broken |
| `CURRENT_WORK.md` | Latest session handoff + what's next |
| `android/RELEASING.md` · `android/AUTO_UPDATE_PLAN.md` | Android build + self-update |

---
Internal project — not for redistribution.
