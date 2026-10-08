CREATE OR REPLACE FUNCTION public._fence_num(p text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select case when p ~ '^\s*-?[0-9]{1,12}(\.[0-9]{1,6})?\s*$' then trim(p)::numeric else 0 end;
$function$;

CREATE OR REPLACE FUNCTION public._fence_bool(p text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select lower(coalesce(trim(p), '')) in ('true', 't', '1', 'yes', 'y', 'on');
$function$;
