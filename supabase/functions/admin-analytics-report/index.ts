/**
 * admin-analytics-report — aggregated product analytics for launch ops
 *
 * GET /functions/v1/admin-analytics-report?days=7
 *
 * Requires an app JWT whose user_id has role admin/owner in app_user_roles.
 * Raw analytics_events stays browser insert-only; this endpoint returns rollups.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  auditEvent,
  handleOptions,
  hasAdminRole,
  json,
  resolveAppUserId,
} from '../_shared/security.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// The API returns at most 1,000 rows per request no matter what .limit()
// asks for. A week of owner testing (1,500+ events) filled that first page
// and pushed every real guest off the Guest Tracker (owner report
// 2026-09-25: 0 guests while four had visited). Page through in 1,000-row
// steps up to the cap so every detail view sees the whole window.
const PAGE_ROWS = 1000;
async function fetchAllRows(build: () => any, cap = 20000): Promise<{ data: any[]; error: any }> {
  const out: any[] = [];
  for (let from = 0; from < cap; from += PAGE_ROWS) {
    const { data, error } = await build().range(from, Math.min(from + PAGE_ROWS, cap) - 1);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < PAGE_ROWS) break;
  }
  return { data: out, error: null };
}

function clampDays(value: string | null): number {
  const parsed = Number.parseInt(value || '7', 10);
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(90, Math.max(1, parsed));
}

// Production fence (owner ask 2026-09-06): Mission Control reports only the
// real website (dhqfootball.com) and the native app (surface ios_app). The
// C2 sandbox, local dev machines, GitHub Pages previews, and the trade lab
// write to the same analytics table but carry different host/surface stamps
// — those rows are counted separately, never mixed into production numbers.
// Server-logged AI events (session 'edge_app:…') are neither: they are the
// AI service's own ledger, not a visitor.
type FenceRow = { metadata?: unknown; session_id?: string | null };
function isProdRow(r: FenceRow): boolean {
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  return meta.host === 'dhqfootball.com' || meta.surface === 'ios_app';
}
function isServerRow(r: FenceRow): boolean {
  return typeof r.session_id === 'string' && r.session_id.startsWith('edge_app:');
}

// The owner testing the product as a guest is not a guest (owner ask
// 2026-09-20: "remove me from the guest stats"). Handles here never appear
// as guests in the Guest Tracker, Known Users, or the visitor list. Since
// 2026-09-27 the owners' signed-in sessions leave production too (the test
// fence below).
const OWNER_HANDLES = new Set(['skjjcruz']);
function isOwnerHandle(handle: unknown): boolean {
  return typeof handle === 'string' && OWNER_HANDLES.has(handle.toLowerCase());
}

// Test-traffic fence (owner ask 2026-09-27: "filter out test traffic").
// Robots (the client stamps metadata.internal when the browser is automated)
// and the owners (owner/admin accounts, their Sleeper handles, devices marked
// as owner devices) leave every production view. The session list comes from
// analytics_test_sessions — the same one the SQL rollup and doors use — so a
// tile and its detail table can never disagree.
async function loadTestSessions(admin: any, since: string): Promise<Set<string>> {
  const { data, error } = await fetchAllRows(() => admin.rpc('analytics_test_sessions', { p_since: since }));
  if (error) console.error('admin-analytics-report test-sessions rpc error:', error);
  return new Set((data ?? []).map((r: { session_id: string }) => String(r.session_id)));
}

// ESPN / MFL guests (owner ask 2026-10-12: "we're not tracking the ESPN
// visitor as a guest"). They have no Sleeper handle, so their sessions are
// named in SQL (analytics_guest_sessions): session -> 'espn:<league>:<team>'
// key and an 'ESPN · <team name>' label. Sessions with an account or a
// Sleeper handle are never in that list, so nobody is counted twice. Additive:
// if the function is missing (migration not applied yet) every view behaves
// exactly as before.
type PlatformGuest = { key: string; label: string };
async function loadPlatformGuests(admin: any, since: string): Promise<Map<string, PlatformGuest>> {
  const { data, error } = await fetchAllRows(() => admin.rpc('analytics_guest_sessions', { p_since: since }));
  if (error) console.error('admin-analytics-report platform-guests rpc error:', error);
  const out = new Map<string, PlatformGuest>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    if (r.session_id && r.guest_key) out.set(String(r.session_id), { key: String(r.guest_key), label: String(r.guest_label || r.guest_key) });
  }
  return out;
}
// Their events carry no name, so the name-filtered queries below never return
// them: fetch those sessions' rows by session id (100 ids per request).
async function fetchSessionRows(admin: any, select: string, since: string, sessionIds: string[]): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < sessionIds.length; i += 100) {
    const chunk = sessionIds.slice(i, i + 100);
    const { data, error } = await fetchAllRows(() => admin
      .from('analytics_events')
      .select(select)
      .gte('event_ts', since)
      .in('session_id', chunk)
      .order('event_ts', { ascending: false }));
    if (error) console.error('admin-analytics-report platform-guest rows error:', error);
    out.push(...data);
  }
  return out;
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const session = await resolveAppUserId(admin, req);
  const userId = session?.userId || null;
  if (!await hasAdminRole(admin, userId)) {
    await auditEvent(admin, req, 'admin_analytics_report', 'blocked', { userId }, { reason: 'missing_admin_role' });
    return json(req, { error: 'Unauthorized' }, 401);
  }

  try {
    const url = new URL(req.url);
    const days = clampDays(url.searchParams.get('days'));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const testSessions = await loadTestSessions(admin, since);
    const isTestRow = (r: FenceRow) => typeof r.session_id === 'string' && testSessions.has(r.session_id);
    // Production and not test traffic: what every view below counts.
    const isLive = (r: FenceRow) => isProdRow(r) && !isTestRow(r);

    // ── detail=users: who is behind the "known users" tile ──
    // Same window as the rollup; aggregated here (not in SQL) because the
    // volume is small and this avoids another security-definer function.
    // A person is keyed by ACCOUNT id when their events carry one (email or
    // Google members), else by the account an identical username links to
    // elsewhere in the window, else by lowercased username — mirrors the
    // person_key in admin_analytics_report (owner ask 2026-08-03: members
    // signed in without a Sleeper username were invisible here).
    if (url.searchParams.get('detail') === 'users') {
      const { data: allRows, error } = await fetchAllRows(() => admin
        .from('analytics_events')
        .select('username, user_id, session_id, event_ts, module, widget, metadata')
        .gte('event_ts', since)
        // Guests (owner ask 2026-09-17): no login, but their events carry the
        // Sleeper handle they connected with in metadata.sleeper. They list
        // here as "<handle> (guest)".
        .or('username.not.is.null,user_id.not.is.null,metadata->>sleeper.not.is.null')
        .order('event_ts', { ascending: false }));
      if (error) {
        console.error('admin-analytics-report users query error:', error);
        return json(req, { error: error.message }, 500);
      }
      // ESPN / MFL guests list here as "ESPN · <team> (guest)".
      const platformGuests = await loadPlatformGuests(admin, since);
      const guestRows = platformGuests.size
        ? await fetchSessionRows(admin, 'username, user_id, session_id, event_ts, module, widget, metadata', since, [...platformGuests.keys()])
        : [];
      type UserRow = { username: string | null; user_id: string | null; session_id?: string | null; metadata?: unknown };
      const guestHandle = (r: UserRow): string | null => {
        if (r.username || r.user_id) return null;
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        return typeof meta.sleeper === 'string' && meta.sleeper ? meta.sleeper : null;
      };
      const platformGuestOf = (r: UserRow): PlatformGuest | null =>
        (!r.username && !r.user_id && !guestHandle(r) && r.session_id && platformGuests.get(r.session_id)) || null;
      const rows = [...(allRows ?? []), ...guestRows]
        .filter((r) => isLive(r) && !isOwnerHandle(guestHandle(r)))
        .filter((r) => r.username || r.user_id || guestHandle(r) || platformGuestOf(r));
      // username -> account bridge from events that carry both.
      const links = new Map<string, string>();
      for (const r of rows ?? []) {
        if (r.username && r.user_id) {
          const uname = String(r.username).toLowerCase();
          if (!links.has(uname)) links.set(uname, String(r.user_id));
        }
      }
      const personKey = (r: UserRow) => {
        if (r.user_id) return String(r.user_id);
        const g = guestHandle(r);
        if (g) return 'guest:' + g.toLowerCase();
        const pg = platformGuestOf(r);
        if (pg) return 'guest:' + pg.key;
        const uname = String(r.username).toLowerCase();
        return links.get(uname) ?? uname;
      };
      // Group per person; display the most recent username casing when one
      // exists ("Skjjcruz" and "skjjcruz" are the same person). "Most used"
      // falls back to widget so it reflects real activity (owner ask 2026-07-30).
      const byUser = new Map<string, { display: string | null; accountId: string | null; events: number; sessions: Set<string>; lastSeen: string; modules: Map<string, number> }>();
      for (const r of rows ?? []) {
        const key = personKey(r);
        const g = guestHandle(r);
        const pg = g ? null : platformGuestOf(r);
        const u = byUser.get(key) ??
          { display: g ? g + ' (guest)' : pg ? pg.label + ' (guest)' : r.username,accountId: r.user_id ? String(r.user_id) : null, events: 0, sessions: new Set(), lastSeen: r.event_ts, modules: new Map() };
        u.events++;
        if (r.session_id) u.sessions.add(r.session_id);
        if (r.user_id && !u.accountId) u.accountId = String(r.user_id);
        if (r.event_ts > u.lastSeen) u.lastSeen = r.event_ts;
        if (r.username && (!u.display || r.event_ts >= u.lastSeen)) u.display = r.username;
        const m = r.module || r.widget;
        if (m) u.modules.set(m, (u.modules.get(m) ?? 0) + 1);
        byUser.set(key, u);
      }
      // Friendly names for username-less accounts: the email's mailbox part.
      const needEmail = [...byUser.values()].filter((u) => !u.display && u.accountId).map((u) => u.accountId as string);
      if (needEmail.length) {
        const { data: accounts } = await admin
          .from('app_users')
          .select('id, email')
          .in('id', needEmail.slice(0, 200));
        const emailById = new Map((accounts ?? []).map((a) => [String(a.id), String(a.email || '')]));
        for (const u of byUser.values()) {
          if (!u.display && u.accountId) {
            const email = emailById.get(u.accountId) || '';
            u.display = email ? email.split('@')[0] + ' (account)' : 'account ' + u.accountId.slice(0, 8);
          }
        }
      }
      const users = [...byUser.values()]
        .map((u) => ({
          username: u.display || 'unknown',
          events: u.events,
          sessions: u.sessions.size,
          lastSeen: u.lastSeen,
          topModule: [...u.modules.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—',
        }))
        .sort((a, b) => b.events - a.events);
      await auditEvent(admin, req, 'admin_analytics_report', 'success', { userId }, { days, detail: 'users' });
      return json(req, { users, days, since });
    }

    // ── detail=guests: the Guest Tracker — every Sleeper handle seen with no
    // account behind it (owner ask 2026-09-18: "a Guest Tracker just like the
    // User Tracker"). A guest row is an event with no account id that carries
    // the handle: metadata.sleeper (shared client, guest: true), the connect
    // page's metadata.sleeperUsername, or a bare username from before the
    // guest stamp shipped. Bare-username handles that any account links to
    // are members with an old stamp, not guests, and are dropped; handles
    // with an explicit guest stamp that later signed up stay listed with the
    // account they became — that is the conversion the owner wants to see.
    if (url.searchParams.get('detail') === 'guests') {
      const { data: allRows, error } = await fetchAllRows(() => admin
        .from('analytics_events')
        .select('username, user_id, session_id, event_ts, event_name, platform, module, widget, metadata')
        .gte('event_ts', since)
        .or('username.not.is.null,user_id.not.is.null,metadata->>sleeper.not.is.null,metadata->>sleeperUsername.not.is.null')
        .order('event_ts', { ascending: false }));
      if (error) {
        console.error('admin-analytics-report guests query error:', error);
        return json(req, { error: error.message }, 500);
      }
      // ESPN / MFL guests: keyed 'espn:<league>:<team>', shown as 'ESPN · <team>'.
      const platformGuests = await loadPlatformGuests(admin, since);
      const guestRows = platformGuests.size
        ? await fetchSessionRows(admin, 'username, user_id, session_id, event_ts, event_name, platform, module, widget, metadata', since, [...platformGuests.keys()])
        : [];
      const rows = [...(allRows ?? []), ...guestRows].filter((r) => isLive(r) && !isServerRow(r));
      // Handles any account owns: events that carry both a username and an
      // account id, plus app_users' linked Sleeper name.
      const linked = new Map<string, string>(); // handle -> account id
      for (const r of rows) {
        if (r.username && r.user_id) linked.set(String(r.username).toLowerCase(), String(r.user_id));
      }
      const accountByHandle = new Map<string, { id: string; email: string }>();
      try {
        const { data: accounts } = await admin
          .from('app_users')
          .select('id, email, platform_usernames')
          .limit(2000);
        for (const a of (accounts ?? []) as Array<Record<string, any>>) {
          const h = String(a.platform_usernames?.sleeper || '').toLowerCase();
          if (h) accountByHandle.set(h, { id: String(a.id), email: String(a.email || '') });
          // An ESPN / MFL guest who signed up: the account's saved league +
          // team matches the guest key exactly.
          for (const [plat, teamField] of [['espn', 'teamId'], ['mfl', 'franchiseId']] as const) {
            const entries = a.platform_usernames?.[plat];
            for (const e of (Array.isArray(entries) ? entries : []) as Array<Record<string, unknown>>) {
              if (!e?.leagueId) continue;
              const k = `${plat}:${e.leagueId}` + (e[teamField] != null && e[teamField] !== '' ? `:${e[teamField]}` : '');
              if (!accountByHandle.has(k)) accountByHandle.set(k, { id: String(a.id), email: String(a.email || '') });
            }
          }
        }
        if (linked.size) {
          const ids = [...new Set(linked.values())].slice(0, 500);
          const { data: linkedAccounts } = await admin.from('app_users').select('id, email').in('id', ids);
          const emailById = new Map((linkedAccounts ?? []).map((a) => [String(a.id), String(a.email || '')]));
          for (const [h, id] of linked) if (!accountByHandle.has(h)) accountByHandle.set(h, { id, email: emailById.get(id) || '' });
        }
      } catch (accErr) {
        console.error('admin-analytics-report guests account scan error:', accErr);
      }
      type Guest = {
        display: string; explicit: boolean; firstSeen: string; lastSeen: string; events: number;
        sessions: Set<string>; modules: Map<string, number>; surfaces: Map<string, number>; connects: number; aiCalls: number; lastEvent: string;
      };
      const byHandle = new Map<string, Guest>();
      for (const r of rows) {
        if (r.user_id) continue;
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const stamped = (typeof meta.sleeper === 'string' && meta.sleeper) || (typeof meta.sleeperUsername === 'string' && meta.sleeperUsername) || null;
        const pg = !stamped && !r.username && r.session_id ? platformGuests.get(r.session_id) : undefined;
        const handle = stamped || (r.username ? String(r.username) : null) || (pg ? pg.label : null);
        if (!handle || isOwnerHandle(handle)) continue;
        const key = pg ? pg.key : handle.toLowerCase();
        const explicit = !!stamped || !!pg || meta.guest === true;
        const g = byHandle.get(key) ??
          { display: handle, explicit: false, firstSeen: r.event_ts, lastSeen: r.event_ts, events: 0, sessions: new Set(), modules: new Map(), surfaces: new Map(), connects: 0, aiCalls: 0, lastEvent: '' };
        g.explicit = g.explicit || explicit;
        g.events++;
        if (r.session_id) g.sessions.add(r.session_id);
        if (r.event_ts < g.firstSeen) g.firstSeen = r.event_ts;
        if (r.event_ts > g.lastSeen) { g.lastSeen = r.event_ts; g.display = handle; g.lastEvent = String(r.event_name || ''); }
        if (!g.lastEvent) g.lastEvent = String(r.event_name || '');
        const m = r.module || r.widget;
        if (m) g.modules.set(String(m), (g.modules.get(String(m)) ?? 0) + 1);
        const surface = meta.surface === 'ios_app' ? 'app' : 'web';
        g.surfaces.set(surface, (g.surfaces.get(surface) ?? 0) + 1);
        if (/connected/i.test(String(r.event_name || ''))) g.connects++;
        if (String(r.module || '') === 'ai' || /^ai_/.test(String(r.event_name || ''))) g.aiCalls++;
        byHandle.set(key, g);
      }
      const dayMs = 24 * 60 * 60 * 1000;
      const weekAgo = new Date(Date.now() - 7 * dayMs).toISOString();
      const guests = [...byHandle.entries()]
        .filter(([key, g]) => g.explicit || !accountByHandle.has(key))
        .map(([key, g]) => {
          const account = accountByHandle.get(key) || null;
          const surfaces = [...g.surfaces.entries()].sort((a, b) => b[1] - a[1]);
          return {
            username: g.display,
            firstSeen: g.firstSeen,
            lastSeen: g.lastSeen,
            sessions: g.sessions.size,
            events: g.events,
            device: surfaces.length === 1 ? surfaces[0][0] : surfaces.length ? 'both' : '—',
            topModules: [...g.modules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => m),
            connects: g.connects,
            aiCalls: g.aiCalls,
            activeDays: Math.max(1, Math.round((new Date(g.lastSeen).getTime() - new Date(g.firstSeen).getTime()) / dayMs) + 1),
            account: account ? (account.email || 'account ' + account.id.slice(0, 8)) : null,
          };
        })
        .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
      const summary = {
        total: guests.length,
        activeWeek: guests.filter((g) => g.lastSeen >= weekAgo).length,
        becameMembers: guests.filter((g) => !!g.account).length,
        returning: guests.filter((g) => g.sessions > 1).length,
      };
      await auditEvent(admin, req, 'admin_analytics_report', 'success', { userId }, { days, detail: 'guests' });
      return json(req, { guests, summary, days, since });
    }

    // ── detail=accounts: every account and what happened after signup ──
    // Someone who signs up and stalls at the connect wall produces no league
    // activity, so the people view never showed them. This lists everyone by
    // name regardless of activity.
    // "Connected" comes from admin_account_roster, which judges it by whether
    // the account ever reached a league-only screen. It used to read
    // app_users.platform_usernames — a column nothing wrote until the connect
    // form started reporting — which under-counted 32 real connects as 1.
    if (url.searchParams.get('detail') === 'accounts') {
      const { data: roster, error } = await admin
        .rpc('admin_account_roster', { p_limit: 200 });
      if (error) {
        console.error('admin-analytics-report accounts rpc error:', error);
        return json(req, { error: error.message }, 500);
      }
      const rows = (roster ?? []) as Array<Record<string, unknown>>;
      const accounts = rows.map((r) => ({
        email: String(r.email ?? ''),
        name: String(r.display_name ?? '') || String(r.email ?? '').split('@')[0],
        createdAt: r.created_at,
        connected: r.connected_platform === true,
        lastActivity: r.last_activity ?? null,
        events: Number(r.events ?? 0),
      }));
      await auditEvent(admin, req, 'admin_analytics_report', 'success', { userId }, { days, detail: 'accounts' });
      return json(req, {
        accounts,
        total: accounts.length,
        connected: accounts.filter((a) => a.connected).length,
        neverOpened: accounts.filter((a) => !a.events).length,
        days,
        since,
      });
    }

    // ── detail=doors: which door (native app vs browser) + guest sign-ins ──
    // surface comes from metadata stamped client-side: 'ios_app' when the UA
    // is a bare WKWebView (the shell), 'web' for real browsers. Events older
    // than the stamp's ship date carry no surface and count as 'unknown'.
    if (url.searchParams.get('detail') === 'doors') {
      // Surface counts are aggregated IN SQL (admin_doors_surfaces). Counting
      // them here from a row pull silently undercounted: the pull is capped
      // and ordered newest-first, and rig/test traffic — 8,600 of 8,900 events
      // in one window — occupies the newest rows, pushing real users out of
      // the sample entirely. The Native App tile read 2 events against a true
      // 162; Browser Website read 0 against 127 (owner report 2026-09-09).
      const { data: agg, error: aggErr } = await admin
        .rpc('admin_doors_surfaces', { p_since: since });
      if (aggErr) {
        console.error('admin-analytics-report doors rpc error:', aggErr);
        return json(req, { error: aggErr.message }, 500);
      }
      // The guest list still needs rows, but only connect-module ones — a
      // small, bounded slice that no amount of rig noise can crowd out.
      const { data: rows, error } = await admin
        .from('analytics_events')
        .select('session_id, username, event_ts, event_name, module, metadata')
        .gte('event_ts', since)
        .eq('module', 'connect')
        .order('event_ts', { ascending: false })
        .limit(500);
      if (error) {
        console.error('admin-analytics-report doors query error:', error);
        return json(req, { error: error.message }, 500);
      }
      // Counts (surfaces, signups, sandbox split) all come from SQL above.
      // This loop only builds the guest list off the connect-module slice.
      const guests: Array<{ when: string; event: string; username: string | null; guest: boolean; surface: string }> = [];
      // ESPN / MFL guests have no handle: name them by league / team.
      const platformGuests = await loadPlatformGuests(admin, since);
      for (const r of rows ?? []) {
        if (!isLive(r) || guests.length >= 200) continue;
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const doorName = (typeof meta.sleeperUsername === 'string' && meta.sleeperUsername) || (typeof meta.sleeper === 'string' && meta.sleeper) || r.username
          || (r.session_id ? platformGuests.get(r.session_id)?.label : null) || null;
        if (meta.guest === true && isOwnerHandle(doorName)) continue;
        guests.push({
          when: r.event_ts,
          event: String(r.event_name || ''),
          username: doorName,
          guest: meta.guest === true,
          surface: typeof meta.surface === 'string' && meta.surface ? meta.surface : 'unknown',
        });
      }
      const a = (agg ?? {}) as Record<string, unknown>;
      await auditEvent(admin, req, 'admin_analytics_report', 'success', { userId }, { days, detail: 'doors' });
      return json(req, {
        surfaces: a.surfaces ?? {},
        signups: a.signups ?? {},
        guests,
        devSandbox: a.devSandbox ?? { events: 0, sessions: 0 },
        serverEvents: a.serverEvents ?? 0,
        days,
        since,
      });
    }

    // ── detail=errors: client errors with their context ──
    // The rollup's clientErrors collapses to source+name ("wrLog: Error").
    // This branch reads the raw events and groups by the context/detail the
    // client started stamping on 2026-08-09 — older events show '—'.
    if (url.searchParams.get('detail') === 'errors') {
      const { data: rows, error } = await fetchAllRows(() => admin
        .from('analytics_events')
        .select('session_id, username, user_id, event_ts, metadata')
        .eq('event_name', 'client_error')
        .gte('event_ts', since)
        .order('event_ts', { ascending: false }));
      if (error) {
        console.error('admin-analytics-report errors query error:', error);
        return json(req, { error: error.message }, 500);
      }
      const groups = new Map<string, { source: string; errorName: string; context: string | null; detail: string | null; times: number; people: Set<string>; lastSeen: string }>();
      // Diagnostics the client files through the error channel that are not
      // failures: viewport.nudge is the phone layout self-correcting (owner ask
      // 2026-09-19: keep it out of the "what actually broke" table).
      const INFORMATIONAL_CONTEXTS = new Set(['viewport.nudge']);
      let devSandboxErrors = 0;
      let testErrors = 0;
      let informational = 0;
      for (const r of rows ?? []) {
        if (isTestRow(r)) { testErrors++; continue; }
        if (!isProdRow(r)) { devSandboxErrors++; continue; }
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const source = typeof meta.source === 'string' && meta.source ? meta.source : 'unknown';
        const errorName = typeof meta.errorName === 'string' && meta.errorName ? meta.errorName : 'Error';
        const context = typeof meta.context === 'string' && meta.context ? meta.context : null;
        if (context && INFORMATIONAL_CONTEXTS.has(context)) { informational++; continue; }
        const detail = typeof meta.errorDetail === 'string' && meta.errorDetail ? meta.errorDetail : null;
        const key = `${source}|${errorName}|${context ?? ''}`;
        const g = groups.get(key) ??
          { source, errorName, context, detail: null, times: 0, people: new Set<string>(), lastSeen: r.event_ts };
        g.times++;
        g.people.add(String(r.username || r.user_id || r.session_id || 'anon'));
        if (r.event_ts > g.lastSeen) g.lastSeen = r.event_ts;
        if (!g.detail && detail) g.detail = detail;
        groups.set(key, g);
      }
      const errors = [...groups.values()]
        .map((g) => ({
          source: g.source,
          errorName: g.errorName,
          context: g.context,
          detail: g.detail,
          times: g.times,
          people: g.people.size,
          lastSeen: g.lastSeen,
        }))
        .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
        .slice(0, 100);
      await auditEvent(admin, req, 'admin_analytics_report', 'success', { userId }, { days, detail: 'errors' });
      return json(req, { errors, devSandboxErrors, testErrors, informational, days, since });
    }

    // ── detail=signin: the front door's auth health, with reasons ──
    // The funnel alone can't distinguish "walked away" from "hit an error",
    // and an existing user signing in via Google from the signup form reads
    // as an abandoned signup even though they got in fine (owner ask
    // 2026-08-28). Group every auth event by method and failure reason.
    if (url.searchParams.get('detail') === 'signin') {
      const AUTH_EVENTS = [
        'signup_started', 'signup_succeeded', 'signup_failed',
        'signin_started', 'signin_succeeded', 'signin_failed',
        'oauth_started', 'oauth_succeeded', 'oauth_sync_failed',
        // The three previously-silent OAuth trapdoors (owner deep dive
        // 2026-09-02): provider bounced back with an error in the URL, the
        // return carried no session, or the callback itself threw.
        'oauth_returned_error', 'oauth_no_session', 'oauth_callback_error',
      ];
      const { data: rows, error } = await fetchAllRows(() => admin
        .from('analytics_events')
        .select('session_id, username, user_id, event_ts, event_name, metadata')
        .in('event_name', AUTH_EVENTS)
        .gte('event_ts', since)
        .order('event_ts', { ascending: false }));
      if (error) {
        console.error('admin-analytics-report signin query error:', error);
        return json(req, { error: error.message }, 500);
      }
      const groups = new Map<string, { event: string; method: string; reason: string | null; times: number; people: Set<string>; lastSeen: string }>();
      for (const r of rows ?? []) {
        if (!isLive(r)) continue;
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const method = typeof meta.method === 'string' && meta.method ? meta.method
          : (typeof meta.provider === 'string' && meta.provider ? meta.provider : 'email');
        const reason = typeof meta.reason === 'string' && meta.reason ? meta.reason
          : (meta.status != null ? `status ${meta.status}` : null);
        const key = `${r.event_name}|${method}|${reason ?? ''}`;
        const g = groups.get(key) ??
          { event: r.event_name, method, reason, times: 0, people: new Set<string>(), lastSeen: r.event_ts };
        g.times++;
        g.people.add(String(r.username || r.user_id || r.session_id || 'anon'));
        if (r.event_ts > g.lastSeen) g.lastSeen = r.event_ts;
        groups.set(key, g);
      }
      // Password-reset outcomes live in the server audit trail, not client
      // analytics — without them a silently-undelivered reset email is
      // invisible (owner bug report 2026-08-31). Fold them into the same table.
      const { data: resetRows } = await admin
        .from('security_events')
        .select('created_at, event_type, outcome, actor_email, ip_address, metadata')
        .in('event_type', ['password_reset_requested', 'password_reset_confirmed'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(5000);
      for (const r of resetRows ?? []) {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        let event: string;
        let reason: string | null;
        if (r.event_type === 'password_reset_requested') {
          if (r.outcome === 'success') {
            event = meta.emailSent === true ? 'reset_email_sent' : 'reset_email_failed';
            reason = meta.emailSent === true ? null : String(meta.emailReason || 'not sent');
          } else {
            event = 'reset_email_failed';
            reason = String((meta.reason as string) || r.outcome);
          }
        } else {
          event = r.outcome === 'success' ? 'password_reset_done' : 'password_reset_link_rejected';
          reason = r.outcome === 'success' ? null : String((meta.reason as string) || r.outcome);
        }
        const key = `${event}|email|${reason ?? ''}`;
        const g = groups.get(key) ??
          { event, method: 'email', reason, times: 0, people: new Set<string>(), lastSeen: r.created_at };
        g.times++;
        g.people.add(String(r.actor_email || r.ip_address || 'anon'));
        if (r.created_at > g.lastSeen) g.lastSeen = r.created_at;
        groups.set(key, g);
      }
      const signin = [...groups.values()]
        .map((g) => ({ event: g.event, method: g.method, reason: g.reason, times: g.times, people: g.people.size, lastSeen: g.lastSeen }))
        .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
        .slice(0, 100);
      await auditEvent(admin, req, 'admin_analytics_report', 'success', { userId }, { days, detail: 'signin' });
      return json(req, { signin, days, since });
    }

    // ── detail=sessions: anonymous visitors behind the sessions tile ──
    // No identity exists for these (never signed in, nothing personal is
    // collected) — this profiles each session instead: when, platform,
    // pages touched, dwell, and the external referrer when one was captured.
    if (url.searchParams.get('detail') === 'sessions') {
      const { data: rows, error } = await fetchAllRows(() => admin
        .from('analytics_events')
        .select('session_id, username, user_id, event_ts, platform, module, event_name, metadata')
        .gte('event_ts', since)
        .order('event_ts', { ascending: false }));
      if (error) {
        console.error('admin-analytics-report sessions query error:', error);
        return json(req, { error: error.message }, 500);
      }
      // A session with EITHER identity is a signed-in member, not a visitor
      // (owner ask 2026-08-03 — Google members were listed as anonymous).
      const named = new Set<string>();
      for (const r of rows ?? []) if ((r.username || r.user_id) && r.session_id) named.add(r.session_id);
      const bySession = new Map<string, { first: string; last: string; events: number; platform: string | null; surface: string | null; pages: Map<string, number>; ref: string | null; sleeper: string | null }>();
      let devSandboxSessions = 0;
      const seenNoise = new Set<string>();
      const seenTest = new Set<string>();
      for (const r of rows ?? []) {
        if (!r.session_id || named.has(r.session_id)) continue;
        if (isServerRow(r)) continue;
        if (isTestRow(r)) { seenTest.add(r.session_id); continue; }
        if (!isProdRow(r)) {
          if (!seenNoise.has(r.session_id)) { seenNoise.add(r.session_id); devSandboxSessions++; }
          continue;
        }
        const s = bySession.get(r.session_id) ??
          { first: r.event_ts, last: r.event_ts, events: 0, platform: null, surface: null, pages: new Map(), ref: null, sleeper: null as string | null };
        s.events++;
        // Guest sessions carry the Sleeper handle they connected with (owner ask 2026-09-17).
        { const gm = (r.metadata ?? {}) as Record<string, unknown>; if (!s.sleeper && typeof gm.sleeper === 'string' && gm.sleeper && !isOwnerHandle(gm.sleeper)) s.sleeper = gm.sleeper; }
        if (r.event_ts < s.first) s.first = r.event_ts;
        if (r.event_ts > s.last) s.last = r.event_ts;
        if (!s.platform && r.platform) s.platform = r.platform;
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        if (!s.surface && typeof meta.surface === 'string' && meta.surface) s.surface = meta.surface;
        const page = r.module || (meta.route as string) || null;
        if (page) s.pages.set(String(page), (s.pages.get(String(page)) ?? 0) + 1);
        // Landing/connect trackers store the referrer as referrerHost; ref is
        // the older key some events still carry.
        const ref = meta.ref ?? meta.referrerHost;
        if (!s.ref && typeof ref === 'string' && ref) s.ref = ref;
        bySession.set(r.session_id, s);
      }
      // ESPN / MFL guests (2026-10-12): named by league / team, same column.
      const platformGuests = await loadPlatformGuests(admin, since);
      for (const [sid, s] of bySession) {
        if (!s.sleeper) s.sleeper = platformGuests.get(sid)?.label ?? null;
      }
      const sessions = [...bySession.values()]
        .map((s) => ({
          started: s.first,
          minutes: Math.max(0, Math.round((Date.parse(s.last) - Date.parse(s.first)) / 60000)),
          events: s.events,
          platform: s.platform || '—',
          surface: s.surface || 'unknown',
          pages: [...s.pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((p) => p[0]),
          ref: s.ref,
          sleeper: s.sleeper,
        }))
        .sort((a, b) => (a.started < b.started ? 1 : -1))
        .slice(0, 150);
      await auditEvent(admin, req, 'admin_analytics_report', 'success', { userId }, { days, detail: 'sessions' });
      return json(req, { sessions, anonymousTotal: bySession.size, devSandboxSessions, testSessions: seenTest.size, days, since });
    }

    const { data, error } = await admin.rpc('admin_analytics_report', { p_since: since });
    if (error) {
      console.error('admin-analytics-report query error:', error);
      return json(req, { error: error.message }, 500);
    }

    await auditEvent(admin, req, 'admin_analytics_report', 'success', { userId }, { days });
    return json(req, { report: data || {}, days, since });
  } catch (err) {
    console.error('admin-analytics-report error:', err);
    return json(req, { error: 'Internal server error' }, 500);
  }
});
