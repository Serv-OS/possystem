# RPOS session handoff — 25 May (v5.5.218)

> Loyalty system Phase 1 — POS store integration complete. Points earn, refund reversal, and customer lookup all wired up.

---

## What shipped: v5.5.218

### v5.5.218 — Loyalty system POS integration (Phase 1)

**Backend (deployed in earlier session):**
- 7 edge functions: `loyalty-config`, `loyalty-earn`, `loyalty-redeem`, `loyalty-refund`, `loyalty-balance`, `loyalty-member-lookup`, `loyalty-rewards`
- Shared utilities: `_shared/loyalty-utils.ts` (auth, member code generation, points calculation, balance updates)
- Database: `loyalty_config`, `loyalty_tiers`, `customer_loyalty`, `loyalty_rewards`, `loyalty_earning_rules` (Platform DB), `loyalty_transactions` (Ops DB), `loyalty` jsonb column on `closed_checks`

**POS store integration (this session):**
- `attributeOrderToCustomer` in `store/index.js` now fires `loyalty-earn` as async IIFE after customer_id is resolved (step 4/4 after customer upsert, visit stats, orders insert)
- Points earned summary stamped on closed check in local state + Supabase `closed_checks.loyalty` jsonb
- Item shape mapped correctly: `cat`, `id`, `isComp`, `staffDiscount`, `isGiftCard` → matches `calculateQualifyingAmount` expectations
- `refundCheck` in `store/index.js` fires `loyalty-refund` as async IIFE (after gift card reversal block). Triggers if check has customer_id, customer phone, or loyalty data
- `insertClosedCheck` in `db.js` now persists `loyalty` jsonb field

**Customer lookup integration:**
- `fetchCustomerByPhone` in `customerLookup.js` now fetches live loyalty data from `loyalty-balance` edge function
- Returns: `rewards[]` (affordable rewards), `credit` (points balance), `memberCode`, `tier`, `pointsEarnedTotal`, `enrolledAt`, `allRewards`
- Replaces the empty stubs from v5.5.37
- `platformSupabase` guarded for null (mock mode)
- `attributeOnlineOrder` now fires `loyalty-earn` for online orders (same edge function)

---

## Phase 1 Loyalty Architecture

```
Customer places order → POS closes check
  → attributeOrderToCustomer() fires
    → (existing) customer upsert, visit stats, customer_orders
    → (NEW) loyalty-earn edge function (fire-and-forget)
      → auto-enroll if first purchase (ensureMembership)
      → calculateQualifyingAmount (item-level exclusions)
      → calculatePoints (tier multiplier, rounding)
      → updateBalance (optimistic concurrency)
      → write loyalty_transactions ledger
      → return points_earned, balance, member_code

Refund processed → refundCheck() fires
  → (existing) gift card reversal
  → (NEW) loyalty-refund edge function (fire-and-forget)
    → find all earn/redeem transactions for check
    → reverse: earn → clawback, redeem → restore
    → update lifetime stats
    → idempotent via refund:{check_id}

Customer lookup (kiosk/POS) → fetchCustomerByPhone()
  → (existing) customers table lookup
  → (NEW) loyalty-balance edge function
    → returns points, tier, affordable rewards, recent transactions
```

---

## Next steps — Loyalty Phase 1 remaining

- [ ] **Back office loyalty config UI** — Settings panel to configure points_per_pound, rewards catalog CRUD, tier management
- [ ] **POS checkout loyalty display** — Show points earned on receipt, loyalty member indicator on checkout
- [ ] **Redemption UI on POS** — Allow staff to redeem rewards at checkout (calls loyalty-redeem)

## Next steps — Loyalty Phase 2+

- [ ] **Stamp cards** — category-based buy-X-get-next-free
- [ ] **Customer portal** — web portal at `<slug>.serv-os.app/account`
- [ ] **Wallet passes** — Apple/Google Wallet integration
- [ ] **Email marketing** — campaign builder with templates
- [ ] **Kiosk + Online + QR** — points across all surfaces

---

## Deployment status — 25 May

| Component | Status | Method |
|-----------|--------|--------|
| Frontend (Vercel) | 🔄 Ready to push | `git push origin main` |
| `loyalty-config` | ✅ Deployed | Supabase CLI |
| `loyalty-earn` | ✅ Deployed | Supabase CLI |
| `loyalty-redeem` | ✅ Deployed | Supabase CLI |
| `loyalty-refund` | ✅ Deployed | Supabase CLI |
| `loyalty-balance` | ✅ Deployed | Supabase CLI |
| `loyalty-member-lookup` | ✅ Deployed | Supabase CLI |
| `loyalty-rewards` | ✅ Deployed | Supabase CLI |
| DB migrations | ✅ Applied | Both Ops + Platform DB |
