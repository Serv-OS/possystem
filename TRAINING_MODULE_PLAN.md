# Training module — plan

Peter's spec, 6 Aug 2026:

> The ability to create and manage training. Needs to be part of the system the staff already use,
> or part of their workforce staff-facing app. Also needs to create AI-based training from reviews.
> Based upon tasks and modules that have times and dates to complete, then recorded, and alert
> managers on completion. Then templates like "new starter training" that new starters get applied
> to them automatically.

Assessed against the codebase on 6 Aug (five-agent recon, findings verified in source). The short
version: **most of the machinery already exists.** The build is mostly wiring, not invention.
**~4–5 days across five slices**, each shippable on its own.

---

## What already exists that this reuses

| Need | Already built | Where |
|---|---|---|
| Staff-facing surface they already use | **Time Clock** (`?mode=clock`) — after PIN it already shows announcements, fed server-side by `workforce-clock` | `src/surfaces/TimeClockSurface.jsx`, `supabase/functions/workforce-clock/index.ts:112` |
| Per-staff step tracking | **Onboarding** already tracks `steps jsonb [{key, status}]` per new starter | `wf_onboarding`, `20260608_workforce.sql:405` |
| The new-starter hook | Staff creation (`saveMember`/`saveStaff`) + the onboarding case creation | `Workforce.jsx:110`, `WfOnboarding.jsx` |
| Certificate records + expiry traffic-light | **Compliance vault** (`wf_documents`) — now grouped Compliance/Training (v5.5.994) | `WfCompliance.jsx` |
| Manager alerting w/ SMS + escalation | **Ops alert pipeline** — `ops_alerts` + `ops_notification_rules` + the `ops-escalate` cron (already runs every 5 min) surfaces in BO, `?mode=ops` AND the Manager app with zero new UI | `20260624_operations_foundation.sql:149`, `supabase/functions/ops-escalate` |
| Nightly sweeps | **pg_cron → edge fn bridge** (`call_edge_fn`), exemplar migration to copy | `20260805b_edge_cron_bridge.sql`, `20260806e_loyalty_reconcile_cron.sql` |
| Tamper-evident completion records | **wf_audit** (append-only, hash-chained) | existing pattern |
| AI generation | **The rota AI pattern** (`buildWithAI`): one JSON prompt → strict "JSON only" contract → parse → validate → land as DRAFTS for human approval | `WfRota.jsx:668`, `api/ai.js` mode switch |
| Review data for the AI | `review_feedback` (rating, comment, private detail, platform, date) — plus **`review_themes`, a table designed for AI theme extraction that has NO writer**; this feature becomes its first | `20260612e_review_manager.sql:31,90` |

## What genuinely does not exist

- Any table linking **a training module to a staff member with a due date**.
- Any staff-facing view of training (documents are shown to staff **nowhere** today).
- Per-role required-training config (`requiredTypes` hardcodes RTW + SIA).
- Anything producing `overdue_task`-style alerts — the sweep here would be the first.

---

## Design

### Data (new tables, Ops DB, standard tenant RLS)

```
wf_training_modules      one row per module (a course)
  id, location_id, org_id, name, description,
  tasks jsonb            [{id, title, detail}]  — ordered task list
  due_days int           deadline = assigned_at + due_days
  auto_assign_new_starters boolean   ← "new starter template" is just this flag
  status                 'draft' | 'active' | 'archived'   ← AI output lands as draft
  source                 'manual' | 'ai_reviews'
  created_from jsonb     (AI: which reviews/themes fed it — provenance)

wf_training_assignments  one row per (module × staff member)
  id, location_id, org_id, module_id, staff_id,
  assigned_at, due_date,
  tasks_done jsonb       [{taskId, at}]  — per-task ticks, stamped server-side
  completed_at, verified_by
  status                 'assigned' | 'in_progress' | 'complete' | 'overdue'
```

Why not reuse ops checklists: they are **per-location** ("did the kitchen do opening checks"),
training is **per-person**. Why not `wf_documents`: those are *evidence* (a certificate), not
*activity*. A completed module can optionally write a `wf_documents` row as its certificate later.

### The five slices

**1. Schema + BO Training manager (~1–1.5 days)**
Migration above. New Workforce tab **"Training"**: module builder (name, tasks, due days,
new-starter flag), assign to staff (individually / by section / everyone), and a completion
matrix (staff × modules, traffic-lit: done / in progress / overdue). Assignment + verification
recorded in `wf_audit`.

**2. Staff-facing on the Time Clock (~1 day)**
Exactly where announcements already appear. `workforce-clock` gains:
- `status` response includes `training: [{module, tasks, due, done}]` for the PIN'd person
- new action `training_tick` — server-side, PIN-authenticated, stamps `tasks_done`, flips
  `completed_at` when the last task ticks, writes `wf_audit`.
PINs never reach the client, same trust model as punches. **Edge fn — deploys manually.**

**3. New-starter auto-apply (~0.5 day)**
On staff creation, auto-assign every active module with `auto_assign_new_starters`,
`due_date = start_date + due_days`. One hook in the create path, plus a backfill button on the
Training tab ("apply to existing staff").

**4. Manager alerts (~0.5–1 day)**
- **Completions:** `logActivity` → the POS bell, + shown in the matrix.
- **Overdue:** nightly `training-overdue` edge fn (pg_cron via `call_edge_fn`, copy the
  20260806e migration shape) inserts `ops_alerts type='training_overdue'` — deduped against an
  existing unacked alert. Widen the `ops_alerts.type` CHECK. Add the event type to
  `OpsNotifications.EVENT_TYPES` so venues can turn on SMS/email + escalation ladder.
  That one insert then appears in BO → Operations, `?mode=ops`, and the Manager app's
  "Need you now" **with no new UI**.

**5. AI training from reviews (~1 day)**
Button on the Training tab: **"Generate training from reviews"**. Copies the rota AI pattern:
- Feed: up to 1000 `review_feedback` rows for the venue (rating, comment, private detail) — the
  full corpus fits in one prompt at current volume.
- New `training` mode in `api/ai.js` (no tools, strict JSON contract): returns
  `{themes: [...], module: {name, description, tasks[]}}`.
- Lands as a **draft** module for the manager to edit/approve — never auto-assigned.
- Writes the extracted themes to `review_themes` (its first-ever writer), which also lights up
  the Review dashboard.

### Honest caveats

- **Review volume is near zero** (one pilot venue, mostly test rows). The AI slice works, but
  demos need seeded reviews — `review-sync` already has a `simulated_reviews` parameter for
  exactly this.
- `ops-escalate` stops chasing after 3 escalation steps; the nightly sweep re-raises weekly
  while still overdue so training can't go permanently silent.
- Two edge functions change (`workforce-clock`, new `training-overdue`) — **manual deploys**,
  per the standing rule.

### Order

Slices 1 → 2 give the demoable core (build a module, assign it, staff tick it off at the clock).
3 is the template ask. 4 the alerting ask. 5 the AI ask. Each lands independently.
