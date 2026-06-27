-- 20260701_staff_nfc_card.sql — NFC staff cards (Ops DB). Additive + reversible.
-- A staff member taps an NFC card/fob to sign in. We store only the card's UID (a non-secret
-- identifier, like a username) on staff_members — no payment/bank data. The UID is global, so the
-- same card works on ANY till once it's synced (staff_members already sync to every till like PINs).

alter table staff_members
  add column if not exists nfc_card_id text;

-- One card → at most one staff per location (lookup + prevents accidental duplicates).
create unique index if not exists staff_members_nfc_card_uidx
  on staff_members (location_id, nfc_card_id)
  where nfc_card_id is not null;

comment on column staff_members.nfc_card_id is
  'NFC card/fob UID (uppercase hex, no separators) for tap-to-sign-in. Non-secret. v5.5.686';

-- Rollback:
-- drop index if exists staff_members_nfc_card_uidx;
-- alter table staff_members drop column if exists nfc_card_id;
