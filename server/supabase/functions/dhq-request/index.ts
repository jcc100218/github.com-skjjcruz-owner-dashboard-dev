// dhq-request — the app says "these Sleeper leagues are in use" so the engine
// server builds them (owner go-ahead 2026-10-17). Public, no sign-in: it only
// queues league ids, and a queued league grants nobody anything (who may see
// a league is decided by roster membership in dhq-tools).
//
//   POST /functions/v1/dhq-request   body: {"leagues":["1312100327931019264", …]}
//   → { queued: n, known: n, skipped: n }
//
// Guards: Sleeper ids only (digits), at most 30 per call, a new league must
// exist on Sleeper, at most 60 new leagues per caller per hour and 300
// waiting in the queue overall. A league seen again just has its 30 days
// renewed (once a day at most).
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, accept',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });

const PER_CALL = 30, NEW_PER_HOUR = 60, QUEUE_CAP = 300;
const DAY = 864e5;

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error('rest ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function sha(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function onSleeper(id: string) {
  try {
    const r = await fetch('https://api.sleeper.app/v1/league/' + id, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.league_id);
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: { leagues?: unknown } = {};
  try { body = await req.json(); } catch { return json({ error: 'JSON body required' }, 400); }
  const ids = [...new Set((Array.isArray(body.leagues) ? body.leagues : []).map(x => String(x).trim()).filter(x => /^\d{10,20}$/.test(x)))].slice(0, PER_CALL);
  if (!ids.length) return json({ error: 'leagues: Sleeper league ids required' }, 400);
  try {
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const ipHash = await sha('dhq-request:' + ip);
    const now = Date.now(), iso = new Date(now).toISOString();
    const rows = await rest('build_requests?select=league_id,status,seen_at,last_built_at&league_id=in.(' + ids.join(',') + ')') as Array<{ league_id: string; status: string; seen_at: string; last_built_at: string | null }>;
    const have = new Map(rows.map(r => [r.league_id, r]));

    // Known leagues: renew their 30 days, at most once a day; re-queue one
    // that failed more than a day ago.
    const renew: string[] = [], retry: string[] = [];
    for (const r of rows) {
      if (now - Date.parse(r.seen_at) < DAY) continue;
      if (r.status === 'failed') retry.push(r.league_id); else renew.push(r.league_id);
    }
    const exp = new Date(now + 30 * DAY).toISOString();
    if (renew.length) await rest('build_requests?league_id=in.(' + renew.join(',') + ')', { method: 'PATCH', body: JSON.stringify({ seen_at: iso, expires_at: exp }) });

    // New leagues: limits first, then check each exists on Sleeper.
    const fresh = ids.filter(id => !have.has(id)).concat(retry);
    let queued = 0;
    if (fresh.length) {
      const since = new Date(now - 3600e3).toISOString();
      const mine = await rest('build_requests?select=league_id&ip_hash=eq.' + ipHash + '&requested_at=gte.' + since + '&limit=' + (NEW_PER_HOUR + 1)) as unknown[];
      const waiting = await rest('build_requests?select=league_id&status=eq.pending&limit=' + (QUEUE_CAP + 1)) as unknown[];
      const room = Math.max(0, Math.min(NEW_PER_HOUR - mine.length, QUEUE_CAP - waiting.length));
      if (!room) return json({ queued: 0, known: rows.length, skipped: fresh.length, note: 'busy: try later' }, 429);
      const take = fresh.slice(0, room);
      const real = (await Promise.all(take.map(async id => (await onSleeper(id)) ? id : null))).filter(Boolean) as string[];
      if (real.length) {
        await rest('build_requests', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(real.map(id => ({ league_id: id, status: 'pending', requested_at: iso, seen_at: iso, expires_at: exp, last_error: null, ip_hash: ipHash }))),
        });
      }
      queued = real.length;
    }
    return json({ queued, known: rows.length - retry.length, skipped: ids.length - queued - (rows.length - retry.length) });
  } catch (e) {
    return json({ error: 'request not recorded', detail: String((e as Error).message || e) }, 503);
  }
});
