# RPOS session handoff — 26 May (v5.5.238)

> Location isolation hardening complete. Four-layer defence against cross-location data bleed.

---

## What shipped: v5.5.235 → v5.5.238

### v5.5.235 — Fix multi-location menu bleed (root cause)
- SyncBridge was reading `rpos-device.locationId` directly, bypassing `rpos-bo-location` override
- Fixed: now uses `getActiveLocationSync()` with correct priority chain

### v5.5.236 — Cross-user location bleed on sign-out/sign-in
- `rpos-bo-location` survived logout — second user inherited first user's location
- Fixed: both sign-out buttons clear override; sign-in validates against accessible locations

### v5.5.237 — HOTFIX: MPOS menu + table loading
- v5.5.235 used async `getLocationId()` in SyncBridge boot — hangs on POS/MPOS without auth session
- Fixed: switched to synchronous `getActiveLocationSync()` (localStorage-only)

### v5.5.238 — Location isolation hardening
- **Auth state SIGNED_OUT handler**: clears `rpos-bo-location` + `_resolvedLocationId` on session expiry
- **Sidebar sign-out reload**: `.then(() => window.location.reload())` flushes all in-memory state
- **Runtime store guard**: `_dataLocationId` stamp on Zustand store; SyncBridge pre-load purge if location changed; post-load validation filters cross-location items
- **RLS tightening**: dropped permissive "allow all" policies on menu tables, floor_tables, config_pushes; replaced with `_auth_write`
- **INVARIANTS.md**: documented location isolation rules, resolution priority chain, and all guard layers

---

## Location isolation architecture (v5.5.238)

```
Layer 1: Tenant Fence (App.jsx boot)
  enforceTenantFence() purges localStorage when location changes

Layer 2: Auth Event Handler (BackOfficeApp.jsx)
  onAuthStateChange(SIGNED_OUT) clears rpos-bo-location + cache
  Sign-in validates override against fetchAccessibleLocations()

Layer 3: Runtime Store Guard (SyncBridge.jsx)
  _dataLocationId stamp → pre-load purge → post-load validation
  Any menuItems with wrong location_id are filtered out

Layer 4: Database RLS
  _auth_write policies on menu_items, menu_categories, menus,
  menu_category_links, floor_tables, config_pushes
```

---

## Key rule for future development

**NEVER use async `getLocationId()` in SyncBridge's boot path.** It calls `supabase.auth.getUser()` — a network round-trip that hangs on POS/MPOS devices without auth sessions. Use `getActiveLocationSync()` instead (synchronous, localStorage-only, same priority chain).

---

## Next steps

- [ ] **Loyalty Phase 1 remaining**: BO config UI, POS checkout display, redemption UI
- [ ] **Wallet passes**: Apple Pay / Google Pay on online ordering (deferred post-launch)
- [ ] **Loyalty Phase 2**: stamp cards, customer portal, wallet passes, email marketing
