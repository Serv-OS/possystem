// pagedRows.js: every row of a PostgREST read, 1000 a page.
//
// PostgREST answers at most max_rows rows a request (1000 on the Ops project, checked 27 Sep
// 2026 through the Management API) whatever .limit() asks for, and says nothing about the rest:
// owner-snapshot's .limit(50000) and manager-snapshot's .limit(20000) came back with 1000 rows.
// `build` returns a FRESH query each call, ordered on a unique key (rows can repeat or go
// missing between pages otherwise). A failed page throws; it is never read as "no rows".
// trading-report keeps its own copy (v5.9.99).
//
// PURE: no imports; runs under node --test and in Deno.

export const PAGE = 1000;

/**
 * @param {string} what  what is being read, for the error message ("closed checks")
 * @param {() => any} build  a new PostgREST query each call, ordered on a unique key
 * @returns {Promise<any[]>}
 */
export async function pagedRows(what, build, page = PAGE) {
  const out = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw new Error(`Could not read ${what}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}
