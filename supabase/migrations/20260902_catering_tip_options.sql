-- Catering tipping: editable percentage chips + custom amount.  OPS project.
--
-- catering_site_settings already had tips_enabled + tip_default_pct. The
-- checkout then hardcoded the chips as [0, default, 15, 20]. This adds the
-- list itself and a custom-amount switch, so the module owns its whole
-- tipping rule like online and QR now do.
--
-- catering_public_settings() does to_jsonb(row), so these reach the customer
-- checkout with no function change.

alter table public.catering_site_settings
  add column if not exists tip_percentages numeric[] default '{5,10,15,20}',
  add column if not exists tip_allow_custom boolean not null default true;

comment on column public.catering_site_settings.tip_percentages is 'Tip chips offered on the catering checkout, in order. tip_default_pct picks which is pre-selected; null/0 = No tip pre-selected.';
comment on column public.catering_site_settings.tip_allow_custom is 'Offer a free-text tip amount on the catering checkout.';
