-- Atomic activation of a sending domain: deactivate the org's others + activate the chosen one in ONE
-- transaction, so a partial failure can never leave an org with zero active domains (silently reverting
-- branding). SECURITY DEFINER + org param; revoked from anon/authenticated (called by marketing-domains).
create or replace function marketing_set_active_domain(p_org uuid, p_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_active then
    update org_sending_domains set is_active = false, updated_at = now() where org_id = p_org and id <> p_id and is_active;
    update org_sending_domains set is_active = true,  updated_at = now() where id = p_id and org_id = p_org;
  else
    update org_sending_domains set is_active = false, updated_at = now() where id = p_id and org_id = p_org;
  end if;
end $$;
revoke all on function marketing_set_active_domain(uuid, uuid, boolean) from anon, authenticated;
