-- 20260612j: review card background image + button style.
alter table review_settings add column if not exists hero_image_url text;
alter table review_settings add column if not exists card_button_style text not null default 'dark' check (card_button_style in ('dark','accent'));
