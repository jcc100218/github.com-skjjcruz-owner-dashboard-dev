-- DHQ engine store (the vacant Supabase project). Idempotent: the builder
-- runs this on every pass. Row-level security is on with no policies, so
-- only the service role (the builder and, later, the server endpoint) can
-- read or write — nothing here is reachable with the public key.

create table if not exists public.connect_leagues (
  league_id        text primary key,
  platform         text not null default 'sleeper',
  sleeper_user_id  text,
  label            text,
  active           boolean not null default true,
  added_at         timestamptz not null default now()
);
alter table public.connect_leagues enable row level security;

create table if not exists public.league_intel (
  league_id        text primary key,
  season           text,
  name             text,
  platform         text not null default 'sleeper',
  built_at         timestamptz not null,
  engine_version   text,
  build_ms         integer,
  intel            jsonb not null,
  assessments      jsonb not null,
  dna              jsonb,
  snapshot         jsonb not null,
  error            text
);
alter table public.league_intel enable row level security;

create table if not exists public.engine_cache (
  key              text primary key,
  data             jsonb not null,
  updated_at       timestamptz not null default now()
);
alter table public.engine_cache enable row level security;

create table if not exists public.engine_runs (
  id               bigint generated always as identity primary key,
  started_at       timestamptz not null,
  finished_at      timestamptz,
  engine_version   text,
  leagues_ok       integer default 0,
  leagues_failed   integer default 0,
  notes            text
);
alter table public.engine_runs enable row level security;

-- Connect keys: what a member's AI presents to the serving endpoint. Only
-- the SHA-256 of the key is stored; the plaintext is shown once when minted.
create table if not exists public.connect_keys (
  key_hash         text primary key,
  sleeper_user_id  text not null,
  label            text,
  scopes           text not null default 'read',
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz,
  revoked          boolean not null default false
);
alter table public.connect_keys enable row level security;

-- The owner's leagues, so the first scheduled run has something to build.
-- Members' leagues are added here by the connect flow later.
insert into public.connect_leagues (league_id, sleeper_user_id, label) values
  ('1312100327931019264', '540392203863576576', 'The Psycho League: Year VI'),
  ('1356311207652360192', '540392203863576576', 'CTB The One - Year 15'),
  ('1369584118731386880', '540392203863576576', 'FG Invitational 8'),
  ('1389388885716385792', '540392203863576576', 'CTB Shootout League Year 6'),
  ('1402444299487985664', '540392203863576576', 'DHQ')
on conflict (league_id) do nothing;

-- ── Sign-in (OAuth 2.1 for the member's AI) ──────────────────────────────
-- Clients register themselves (dynamic client registration); a member signs
-- in with their DHQ login, picks leagues, and the client gets a code it
-- exchanges for tokens. Tokens live in connect_keys (hashed) like keys do.
create table if not exists public.oauth_clients (
  client_id        text primary key,
  client_name      text,
  redirect_uris    jsonb not null default '[]'::jsonb,
  client_uri       text,
  created_at       timestamptz not null default now()
);
alter table public.oauth_clients enable row level security;

create table if not exists public.oauth_pending (
  id               text primary key,
  client_id        text not null,
  redirect_uri     text not null,
  state            text,
  code_challenge   text not null,
  scope            text,
  resource         text,
  app_user_id      text,
  email            text,
  sleeper_user_id  text,
  sleeper_username text,
  leagues          jsonb not null default '[]'::jsonb,
  expires_at       timestamptz not null
);
alter table public.oauth_pending enable row level security;

create table if not exists public.oauth_codes (
  code             text primary key,
  client_id        text not null,
  redirect_uri     text not null,
  code_challenge   text not null,
  scope            text,
  app_user_id      text,
  email            text,
  sleeper_user_id  text not null,
  leagues          jsonb not null default '[]'::jsonb,
  used             boolean not null default false,
  expires_at       timestamptz not null
);
alter table public.oauth_codes enable row level security;

alter table public.connect_keys add column if not exists kind text not null default 'key';
alter table public.connect_keys add column if not exists client_id text;
alter table public.connect_keys add column if not exists app_user_id text;
alter table public.connect_keys add column if not exists email text;
alter table public.connect_keys add column if not exists expires_at timestamptz;
alter table public.connect_leagues add column if not exists added_by text;

-- Every tool call a member's AI makes: what, for which league, how long,
-- whether it worked. Read by us to learn how DHQ Connect is used; also the
-- source for the per-key rate limit (calls in the last minute).
create table if not exists public.connect_usage (
  id               bigint generated always as identity primary key,
  at               timestamptz not null default now(),
  key_hash         text not null,
  sleeper_user_id  text,
  client_id        text,
  tool             text not null,
  league_id        text,
  ms               integer,
  ok               boolean not null default true,
  error            text,
  via              text
);
create index if not exists connect_usage_key_at on public.connect_usage (key_hash, at desc);
create index if not exists connect_usage_at on public.connect_usage (at desc);
alter table public.connect_usage enable row level security;

-- ── Player news index (owner ask 2026-10-09) ─────────────────────────────
-- One row per story per player it touches (server/engine/news.js). Kept 30
-- days. Read by the public dhq-news function (service role) — RLS on, no
-- policies, so the public key still reaches nothing here directly.
create table if not exists public.player_news (
  id               text primary key,
  player_id        text not null,
  team             text,
  kind             text not null,
  link             text not null,
  why              text,
  headline         text,
  summary          text,
  url              text,
  source           text,
  published_at     timestamptz not null,
  updated_at       timestamptz not null default now()
);
alter table public.player_news enable row level security;
create index if not exists player_news_player on public.player_news (player_id, published_at desc);
create index if not exists player_news_team on public.player_news (team, published_at desc);
delete from public.player_news where published_at < now() - interval '30 days';

-- Connector debugging (2026-10-10): one row per request to dhq-auth / dhq-tools
-- (path, user agent, whether auth was sent; never a token).
create table if not exists public.connect_trace (id bigserial primary key, at timestamptz not null default now(), fn text, method text, path text, query text, ua text, origin text, has_auth boolean, status int);
alter table public.connect_trace enable row level security;
