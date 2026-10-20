/* safeupdate_guard.c: a small stand in for pg-safeupdate, which Ops preloads for the API login
   (authenticator: session_preload_libraries = safeupdate). Written for the harness, not downloaded:
   an UPDATE or DELETE with no WHERE clause, in any statement parsed in the session (plpgsql bodies
   included), is refused, as on Ops. run.mjs builds it with the cluster's own pg_config and preloads
   it for authenticator only (the runner and the SQL editor log in as postgres, as on Ops). */
#include "postgres.h"
#include "fmgr.h"
#include "parser/analyze.h"
#include "nodes/parsenodes.h"
PG_MODULE_MAGIC;
static post_parse_analyze_hook_type prev_hook = NULL;
static void guard(ParseState *pstate, Query *query, JumbleState *jstate)
{
	if (prev_hook) prev_hook(pstate, query, jstate);
	if (query->commandType == CMD_DELETE && query->jointree && query->jointree->quals == NULL)
		ereport(ERROR, (errcode(ERRCODE_CARDINALITY_VIOLATION), errmsg("DELETE requires a WHERE clause")));
	if (query->commandType == CMD_UPDATE && query->jointree && query->jointree->quals == NULL)
		ereport(ERROR, (errcode(ERRCODE_CARDINALITY_VIOLATION), errmsg("UPDATE requires a WHERE clause")));
}
void _PG_init(void) { prev_hook = post_parse_analyze_hook; post_parse_analyze_hook = guard; }
