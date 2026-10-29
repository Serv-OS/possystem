-- Rollback of 20261108a_PLATFORM_gift_till.sql (PLATFORM project).
-- Puts the four CHECKs back as they were. It refuses to run while any row uses the new words
-- (a blank card, a pos sourced card, a 0 initial amount, a load row): those rows would break the
-- old constraints. Void or delete them first, on purpose, never silently.

begin;

do $$
begin
  if exists (select 1 from public.gift_cards where status = 'blank' or source = 'pos' or initial_amount_minor = 0) then
    raise exception 'gift_cards still holds blank / pos / zero amount rows; clear them before rolling back';
  end if;
  if exists (select 1 from public.gift_card_transactions where type = 'load') then
    raise exception 'gift_card_transactions still holds load rows; clear them before rolling back';
  end if;
end $$;

alter table public.gift_cards
  drop constraint if exists gift_cards_initial_amount_minor_check;
alter table public.gift_cards
  add constraint gift_cards_initial_amount_minor_check check (initial_amount_minor > 0);

alter table public.gift_cards
  drop constraint if exists gift_cards_status_check;
alter table public.gift_cards
  add constraint gift_cards_status_check
  check (status = any (array['active'::text, 'redeemed'::text, 'voided'::text, 'expired'::text]));

alter table public.gift_cards
  drop constraint if exists gift_cards_source_check;
alter table public.gift_cards
  add constraint gift_cards_source_check
  check (source = any (array['manual'::text, 'online'::text, 'bulk'::text, 'import'::text]));

alter table public.gift_card_transactions
  drop constraint if exists gift_card_transactions_type_check;
alter table public.gift_card_transactions
  add constraint gift_card_transactions_type_check
  check (type = any (array['issue'::text, 'redeem'::text, 'refund'::text, 'void'::text]));

comment on column public.gift_cards.status is null;
comment on column public.gift_cards.source is null;
comment on column public.gift_card_transactions.type is null;

commit;
