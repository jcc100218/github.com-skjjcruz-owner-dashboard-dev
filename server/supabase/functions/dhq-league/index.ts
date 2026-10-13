// dhq-league — the app tells the engine which leagues members open (engine
// project). Engine move, step 2 (owner go-ahead 2026-10-13): the server
// builds every Sleeper league a member opened in the last two weeks, not just
// the leagues connected to a member's AI. The engine build reads
// league_requests; its quick pass (every 15 minutes) builds a new league soon
// after it is first seen here.
//
//   POST /functions/v1/dhq-league  { "league_id": "1312…", "platform": "sleeper" }
//   GET  /functions/v1/dhq-league?league=1312…
//   → { league_id, status: built | building | failed | unsupported, built_at, engine_version }
//
// No member data and no league numbers come back here (those are served in
// a later step); a Sleeper league id is public. A league id Sleeper does not
// know is refused, so the build list only ever holds real leagues.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, accept',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });

const H = () => ({ apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' });
async function select(path: string) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: H() });
  if (!r.ok) throw new Error('select ' + r.status);
  return r.json();
}
async function upsert(table: string, row: Record<string, unknown>) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + table, { method: 'POST', headers: { ...H(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([row]) });
  if (!r.ok) throw new Error('upsert ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

// A seen league is re-stamped at most every six hours: enough to keep it on
// the two-week build list without a database write on every page view.
const RESTAMP_MS = 6 * 3600 * 1000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'GET or POST' }, 405);
  let leagueId = '', platform = 'sleeper';
  try {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      leagueId = String(b.league_id || ''); platform = String(b.platform || 'sleeper').toLowerCase();
    } else {
      const u = new URL(req.url);
      leagueId = u.searchParams.get('league') || ''; platform = (u.searchParams.get('platform') || 'sleeper').toLowerCase();
    }
  } catch { /* bad body */ }
  leagueId = leagueId.trim();
  // The server engine builds Sleeper leagues; ESPN and MFL stay in the browser for now.
  if (platform !== 'sleeper') return json({ league_id: leagueId, status: 'unsupported', note: 'The server builds Sleeper leagues only for now.' });
  if (!/^\d{8,24}$/.test(leagueId)) return json({ error: 'league_id must be a Sleeper league id' }, 400);
  try {
    const now = Date.now();
    const [seen, built] = await Promise.all([
      select('league_requests?select=last_seen&league_id=eq.' + leagueId),
      select('league_intel?select=built_at,engine_version,error&league_id=eq.' + leagueId),
    ]) as [Array<{ last_seen: string }>, Array<{ built_at: string; engine_version: string; error: string | null }>];
    if (!seen.length) {
      // First time: only a league Sleeper knows goes on the build list.
      const r = await fetch('https://api.sleeper.app/v1/league/' + leagueId);
      const lg = r.ok ? await r.json().catch(() => null) : null;
      if (!lg || !lg.league_id) return json({ league_id: leagueId, status: 'unknown', note: 'Sleeper has no league with this id.' }, 404);
      await upsert('league_requests', { league_id: leagueId, platform: 'sleeper', last_seen: new Date(now).toISOString() });
    } else if (now - Date.parse(seen[0].last_seen) > RESTAMP_MS) {
      await upsert('league_requests', { league_id: leagueId, platform: 'sleeper', last_seen: new Date(now).toISOString() });
    }
    const b = built[0];
    const status = !b ? 'building' : b.error ? 'failed' : 'built';
    return json({ league_id: leagueId, status, built_at: b ? b.built_at : null, engine_version: b ? b.engine_version : null });
  } catch (e) {
    return json({ error: 'unavailable', detail: String((e as Error).message || e) }, 503);
  }
});
