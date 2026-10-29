-- 20261108a_PLATFORM_gift_till.sql (29 Oct 2026, v5.11.118, Drop C: sell gift cards at the till).
-- PLATFORM project. Peter runs this by hand in the Supabase SQL editor.
--
-- WHY. A venue prints blank physical gift cards in Back Office (nothing on them, not spendable),
-- sells one at the till and loads the money on at the sale; a card with money on it can be topped
-- up at the till too. Three words the schema did not know: a card can be 'blank' (status), a card
-- can come from the till ('pos' source), and a ledger row can be a 'load'. A blank card holds
-- nothing, so initial_amount_minor must be allowed to be 0.
--
-- Every existing value stays. Only additions:
--   gift_cards.initial_amount_minor   > 0   ->  >= 0
--   gift_cards.status                 + 'blank'
--   gift_cards.source                 + 'pos'
--   gift_card_transactions.type       + 'load'
-- No grants or policies change: every writer is an edge function on the service role.

begin;

alter table public.gift_cards
  drop constraint if exists gift_cards_initial_amount_minor_check;
alter table public.gift_cards
  add constraint gift_cards_initial_amount_minor_check check (initial_amount_minor >= 0);

alter table public.gift_cards
  drop constraint if exists gift_cards_status_check;
alter table public.gift_cards
  add constraint gift_cards_status_check
  check (status = any (array['active'::text, 'redeemed'::text, 'voided'::text, 'expired'::text, 'blank'::text]));

alter table public.gift_cards
  drop constraint if exists gift_cards_source_check;
alter table public.gift_cards
  add constraint gift_cards_source_check
  check (source = any (array['manual'::text, 'online'::text, 'bulk'::text, 'import'::text, 'pos'::text]));

alter table public.gift_card_transactions
  drop constraint if exists gift_card_transactions_type_check;
alter table public.gift_card_transactions
  add constraint gift_card_transactions_type_check
  check (type = any (array['issue'::text, 'redeem'::text, 'refund'::text, 'void'::text, 'load'::text]));

comment on column public.gift_cards.status is
  'active | redeemed | voided | expired | blank. blank = a printed physical card with nothing on it yet; gift-load at the till makes it active.';
comment on column public.gift_cards.source is
  'manual | online | bulk | import | pos. pos = issued by a paired till at a sale (gift-issue channel pos).';
comment on column public.gift_card_transactions.type is
  'issue | redeem | refund | void | load. load = money put on a card at the till (gift-load): a blank card activated, or an active card topped up. order_id holds the closed check id.';

commit;

-- VERIFY (read only):
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid in ('public.gift_cards'::regclass, 'public.gift_card_transactions'::regclass)
--      and conname in ('gift_cards_initial_amount_minor_check', 'gift_cards_status_check',
--                      'gift_cards_source_check', 'gift_card_transactions_type_check')
--    order by conname;
--   -- expect: initial_amount_minor >= 0; status list ends 'blank'; source list ends 'pos'; type list ends 'load'.
--   select status, count(*) from public.gift_cards group by status order by status;
