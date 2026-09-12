-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Production centres by order type. NO schema change is required.
-- The setting lives inside the existing jsonb column print_routing.routing:
--   routing -> <centreId> -> orderTypes  =  array of 'dine-in' | 'takeaway' | 'collection' | 'delivery'
-- An absent key or an empty array means the centre takes ALL order types, which is what
-- every existing centre keeps. The app works before and after this file is run, and
-- running it twice is safe. Its only effect is the column comment below.
-- No alter table, no backfill, no RLS change. Existing rows are already correct by omission.

comment on column public.print_routing.routing is
  'Per centre routing keyed by centre id: { assignedCategories: text[], excludedItems: text[], orderTypes: text[] }. orderTypes absent or empty means all order types (dine-in, takeaway, collection, delivery).';
