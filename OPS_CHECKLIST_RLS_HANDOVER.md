# OPEN BUG — Manager app: checklist writes rejected by RLS

**Symptom (reproducible, owner's tablet):** Manager app → Ops → Opening checklist renders all
tasks, then any tick / photo fails with the raw `new row violates row-level security policy`.
Still failing **after re-pairing the device**.

## ESTABLISHED FACTS — verified against the LIVE Ops DB, do not re-derive

1. **RLS policies are already device-aware and applied.** `pg_policies` on the live DB shows
   `ops_checklist_runs_rls`, `ops_task_completions_rls`, `ops_checklists_rls`,
   `ops_checklist_tasks_rls`, `ops_audit_sel` all using `ops_can_write(location_id)`.
   Migration `20260627_ops_device_read_rls.sql` IS applied. The schema is NOT the problem.

2. **`ops_can_write(loc)`** (`20260624b_operations_rpcs.sql:10`) =
   `loc in user_accessible_locations()`  OR
   `exists (select 1 from ops_devices d where d.device_uid = auth.uid() and d.location_id = loc and d.active)`

3. **Reads work because they DON'T use RLS.** The Manager app reads via the `manager-snapshot`
   edge function (service role). Only the direct client writes hit RLS. That is why the list
   renders and only writes fail — this misleads you into thinking it is a permissions grant issue.

4. **`OpsContent` passes the venue EXPLICITLY** to every call —
   `completeTask(run.id, task.id, {...}, loc)` (`OperationsSurface.jsx:589/598/620`), so
   `location_id` is NOT null. (I wrongly assumed it was; see DISPROVEN below.)

5. **ops_devices has 5 rows all named "Ops tablet"**, e.g.
   `25d54052 claimed=false active=true seen=17 Jul`, `a0ce2d48 claimed=true active=true seen=02 Jul`,
   `6f864526 claimed=true active=true seen=01 Jul`. The tablet registers a NEW row whenever its
   anonymous identity changes rather than re-claiming. (Real problem, but re-pairing did NOT fix
   the error, so it is not the whole story.)

## DISPROVEN — do not repeat these
- ❌ "location_id is null on the write" → no, `loc` is passed explicitly (fact 4).
  v5.5.917's ManagerSurface `publishManagerLocation()` was built on this wrong theory.
  **It is not the fix and should be reverted.** (The `!locationId` guards added to
  `completeTask`/`signOffRun` are harmless hygiene and can stay.)
- ❌ "the device is simply unpaired" → owner re-paired; error persists.

## THE NEXT DIAGNOSTIC (run as the TABLET, not in the SQL editor)
The SQL editor runs as `postgres` and will always pass. The question is what `auth.uid()` is
**inside the tablet's own session**. On the tablet (or a browser with its session), run:

```js
const { data: u } = await supabase.auth.getUser();
console.log('uid', u?.user?.id, 'anon?', u?.user?.is_anonymous);
const { data: d } = await supabase.from('ops_devices').select('id,location_id,active,device_uid');
console.log('devices visible to me', d);
const { data: can } = await supabase.rpc('ops_can_write', { p_location_id: '<the loc it passes>' });
console.log('ops_can_write ->', can);
```

`ops_can_write` returning **false** identifies which of the three conditions fails:
device_uid mismatch / location mismatch / `active=false`.

**Prime suspect not yet checked:** a LOCATION MISMATCH — the `loc` the Ops screens pass may not be
the same location the device row is claimed to. Compare the two values directly.

## THEN FIX (regardless of cause)
- The app must NOT render a working checklist on a device that cannot write — route to pairing.
- Stop orphaning `ops_devices` rows on identity change (5 rows for one tablet).
- Never surface a raw Postgres RLS string to staff.
