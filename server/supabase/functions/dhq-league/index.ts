// dhq-league — one league's server-built DHQ numbers for the app (transition
// step 3, owner go-ahead 2026-10-18; Lab first). Public, no sign-in: Sleeper
// league data is public by id and these values already show to every app
// user. Only built leagues exist here; nothing about any DHQ member.
//
//   GET /functions/v1/dhq-league?league=1312100327931019264
//   → { league_id, season, built_at, engine_version, intel, dhq_proj }
//   404 when the league hasn't been built (the app then computes on device).
//
// intel is the engine's full LeagueIntel minus sourceSnapshots (upstream
// URLs); dhq_proj is the week's projections. The row's error text, the
// snapshot (Sleeper data the app already has) and everything else stay out.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, accept',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function respond(req: Request, body: unknown, status: number, cache: string) {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': cache, Vary: 'Accept-Encoding', ...CORS };
  if (/\bgzip\b/.test(req.headers.get('accept-encoding') || '') && text.length > 2048) {
    const gz = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(gz, { status, headers: { ...headers, 'Content-Encoding': 'gzip' } });
  }
  return new Response(text, { status, headers });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return respond(req, { error: 'GET only' }, 405, 'no-store');
  const id = new URL(req.url).searchParams.get('league') || '';
  if (!/^\d{10,20}$/.test(id)) return respond(req, { error: 'league=<Sleeper league id> required' }, 400, 'no-store');
  try {
    const q = 'league_intel?select=league_id,season,built_at,engine_version,intel,dhq_proj:snapshot->dhq_proj&error=is.null&league_id=eq.' + id;
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + q, { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
    if (!r.ok) throw new Error('rest ' + r.status);
    const rows = await r.json() as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row || !row.intel) return respond(req, { error: 'not built', league_id: id }, 404, 'public, max-age=60');
    const intel = { ...(row.intel as Record<string, unknown>) };
    delete intel.sourceSnapshots;
    return respond(req, { league_id: id, season: row.season, built_at: row.built_at, engine_version: row.engine_version, intel, dhq_proj: row.dhq_proj || null }, 200, 'public, max-age=60');
  } catch (e) {
    return respond(req, { error: 'league unavailable', detail: String((e as Error).message || e) }, 503, 'no-store');
  }
});
