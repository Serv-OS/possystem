// supabase/functions/stock-deplete/index.ts
//
// RETIRED (drainer release, migration 20261023a, multi site stock map 8.1 step 6, contract 3.4).
//
// The database takes stock off every order channel itself (the stock outbox and its drainer,
// 20261018c, rebuilt in 20261023a): the till, the card reader, kiosk, online, QR, catering, pay at
// table, MPOS, HubRise and ezCater checks, their refunds and voids. Every venue is central since
// 20261019, so this function had nothing left to do: the database's central door already answered
// every movement it posted with skipped central.
//
// What it does now: any POST answers 200 { "retired": true } with the same CORS headers as before;
// OPTIONS answers the CORS preflight as before; any other method is refused (405) as before. No
// database client is made, no key or login is read, the request body is not read, nothing is
// read or written. Old kiosk builds still call it after a sale and never read the answer, so for
// them the call is done.
//
// Gone with it: its own copy of the unit table and the recipe rule, the unpaged reads of every
// stock and recipe table of a venue, the movement posts, and the caller rule (its shared file is
// deleted: only this function and its test used it).
// Proven in node by src/lib/stock/stockDepleteFn.test.js.
//
// Deploy (Peter): npx supabase functions deploy stock-deplete --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function handler(req: Request): Response {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  return json({ retired: true });
}

Deno.serve(handler);
