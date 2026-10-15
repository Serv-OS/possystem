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

/**
 * pagedRows that keeps nothing: each page goes to `onRows` as it arrives, so a month of checks
 * is added up page by page and never held (2 Oct 2026, the Owner app's This month filter: a
 * busy venue closes about 260 checks a day, and the items column is heavy).
 * `gate`, when given, runs each request (see `limiter`), so the caller caps how many are in
 * flight. A failed page throws, as in pagedRows. Resolves with how many rows went past.
 * @param {string} what
 * @param {() => any} build  a new PostgREST query each call, ordered on a unique key
 * @param {(rows: any[]) => void} onRows
 * @param {{ page?: number, gate?: ((ask: () => any) => Promise<any>) | null }} [opts]
 * @returns {Promise<number>}
 */
export async function pagedEach(what, build, onRows, { page = PAGE, gate = null } = {}) {
  let seen = 0;
  for (let from = 0; ; from += page) {
    const ask = () => build().range(from, from + page - 1);
    const { data, error } = await (gate ? gate(ask) : ask());
    if (error) throw new Error(`Could not read ${what}: ${error.message}`);
    if (data?.length) { onRows(data); seen += data.length; }
    if (!data || data.length < page) break;
  }
  return seen;
}

/**
 * At most `max` calls running at once; the rest wait their turn, first come first served.
 * The tills read through the same PostgREST: a snapshot that fired a month of page reads all
 * at once would queue in front of them.
 * @param {number} max
 * @returns {<T>(fn: () => T | PromiseLike<T>) => Promise<T>}
 */
export function limiter(max) {
  const cap = Math.max(1, Math.floor(Number(max)) || 1);
  let active = 0;
  const waiting = [];
  const next = () => {
    while (active < cap && waiting.length) { active += 1; waiting.shift()(); }
  };
  return (fn) => new Promise((resolve, reject) => {
    waiting.push(() => {
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; next(); });
    });
    next();
  });
}
