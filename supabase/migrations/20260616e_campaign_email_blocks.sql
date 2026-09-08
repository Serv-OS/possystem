-- Marketing & Promotions — Slice 5: store the email as editable blocks alongside the compiled HTML.
-- Additive. The block builder (Back Office) edits email_blocks and compiles them to email_html on save;
-- the campaign engine keeps sending email_html unchanged, so nothing downstream needs to know about blocks.
alter table campaigns add column if not exists email_blocks jsonb;
