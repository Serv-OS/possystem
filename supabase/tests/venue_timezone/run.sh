#!/bin/zsh
# venue_timezone/run.sh: proves 20261116a on a throwaway local Postgres (5.12.48).
#   zsh supabase/tests/venue_timezone/run.sh
# Builds the two tables the venue clock touches, loads the OLD venue_clock_sync (the rollback file),
# a Mozz like venue (Ops New York, clock Denver), runs 20261116a, then checks:
#   1. the flagged venue is put right and its warning cleared,
#   2. a later sync with a new Platform zone moves the Ops row with it,
#   3. a venue already in step is left alone, a bad zone changes nothing.
set -e
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
HERE="${0:A:h}"; MIG="${HERE:h:h}/migrations"
DIR="$(mktemp -d)"; PORT=55432
trap 'pg_ctl -D "$DIR" -m immediate stop >/dev/null 2>&1; rm -rf "$DIR"' EXIT
initdb -D "$DIR" -U postgres >/dev/null
pg_ctl -D "$DIR" -o "-p $PORT -k $DIR" -l "$DIR/log" start >/dev/null
sleep 1
P() { psql -h "$DIR" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
P -c "create table public.locations (id uuid primary key, timezone text);
      create table public.venue_clock (location_id uuid primary key references public.locations(id), platform_location_id uuid,
        timezone text not null, day_start time, synced_at timestamptz, mismatch text);"
P -f "$MIG/20261116a_OPS_venue_timezone_one_source_ROLLBACK.sql" >/dev/null
P -c "insert into locations values ('11111111-1111-1111-1111-111111111111','America/New_York'),
                                   ('22222222-2222-2222-2222-222222222222','Europe/London');
      select venue_clock_sync('[{\"ops_location_id\":\"11111111-1111-1111-1111-111111111111\",\"timezone\":\"America/Denver\"},
                                {\"ops_location_id\":\"22222222-2222-2222-2222-222222222222\",\"timezone\":\"Europe/London\"}]'::jsonb);" >/dev/null
before=$(P -c "select timezone||'|'||coalesce((select mismatch from venue_clock where location_id=l.id),'') from locations l where id='11111111-1111-1111-1111-111111111111'")
[ "$before" = "America/New_York|Ops says America/New_York, the platform says America/Denver." ] || { echo "FAIL setup: $before"; exit 1; }
out=$(P -f "$MIG/20261116a_OPS_venue_timezone_one_source.sql" | tail -1)
[ "$out" = "0" ] || { echo "FAIL check line: $out"; exit 1; }
a=$(P -c "select l.timezone||'|'||coalesce(c.mismatch,'none') from locations l join venue_clock c on c.location_id=l.id where l.id='11111111-1111-1111-1111-111111111111'")
[ "$a" = "America/Denver|none" ] || { echo "FAIL 1: $a"; exit 1; }
r=$(P -c "select venue_clock_sync('[{\"ops_location_id\":\"11111111-1111-1111-1111-111111111111\",\"timezone\":\"America/Los_Angeles\"}]'::jsonb)->'mismatches'->0->>'fixed'")
b=$(P -c "select l.timezone||'|'||coalesce(c.mismatch,'none') from locations l join venue_clock c on c.location_id=l.id where l.id='11111111-1111-1111-1111-111111111111'")
[ "$b" = "America/Los_Angeles|none" ] && [ "$r" = "true" ] || { echo "FAIL 2: $b $r"; exit 1; }
P -c "select venue_clock_sync('[{\"ops_location_id\":\"22222222-2222-2222-2222-222222222222\",\"timezone\":\"Not/AZone\"},
                                {\"ops_location_id\":\"22222222-2222-2222-2222-222222222222\",\"timezone\":\"Europe/London\"}]'::jsonb)" >/dev/null
c=$(P -c "select timezone from locations where id='22222222-2222-2222-2222-222222222222'")
[ "$c" = "Europe/London" ] || { echo "FAIL 3: $c"; exit 1; }
echo "venue_timezone: 3 checks pass"
