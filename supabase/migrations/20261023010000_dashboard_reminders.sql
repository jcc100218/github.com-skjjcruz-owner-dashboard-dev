begin;
-- Private, account-owned reminders. Browser roles cannot read delivery targets,
-- verification digests, push keys, receipts, or worker queues directly.
create table public.dhq_reminder_channels (
 user_id uuid primary key references public.app_users(id) on delete cascade,
 email text, email_verified_at timestamptz, email_opted_in boolean not null default false,
 challenge_id uuid, code_hash text, code_expires_at timestamptz, code_attempts integer not null default 0,
 unsubscribe_token text, unsubscribe_hash text unique,
 updated_at timestamptz not null default now()
);
create table public.dhq_push_subscriptions (
 device_key text primary key check(device_key ~ '^[0-9a-f]{64}$'),
 user_id uuid not null references public.app_users(id) on delete cascade,
 subscription jsonb not null, app_base text not null,
 enabled boolean not null default true, updated_at timestamptz not null default now()
);
create index on public.dhq_push_subscriptions(user_id);
create table public.dhq_dashboard_reminders (
 user_id uuid not null references public.app_users(id) on delete cascade,
 league_id text not null check(length(league_id) between 1 and 200 and league_id !~ '[[:cntrl:]]'),
 id text not null check(id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
 view_id text not null check(view_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
 title text not null check(length(title) between 1 and 120 and title !~ '[[:cntrl:]]'),
 channel text not null check(channel in ('email','push')),
 schedule jsonb not null,
 device_key text,
 state text not null check(state in ('enabled','paused')),
 revision integer not null check(revision > 0),
 next_run_at timestamptz,
 updated_at timestamptz not null default now(),
 primary key(user_id,league_id,id),
 check((state='enabled' and next_run_at is not null) or (state='paused' and next_run_at is null))
);
create index on public.dhq_dashboard_reminders(next_run_at) where state='enabled';
create table public.dhq_reminder_operations (
 user_id uuid not null references public.app_users(id) on delete cascade,
 operation_id uuid not null, request jsonb not null, response jsonb not null,
 created_at timestamptz not null default now(), primary key(user_id,operation_id)
);
create table public.dhq_reminder_deliveries (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null, league_id text not null, reminder_id text not null,
 reminder_revision integer not null, occurrence timestamptz not null,
 snapshot jsonb not null,
 state text not null default 'pending' check(state in ('pending','sending','accepted','failed','canceled')),
 attempts integer not null default 0, lease_id uuid, lease_until timestamptz,
 retry_at timestamptz not null default now(), provider_id text, error_code text,
 created_at timestamptz not null default now(), finished_at timestamptz,
 foreign key(user_id,league_id,reminder_id) references public.dhq_dashboard_reminders(user_id,league_id,id) on delete cascade,
 unique(user_id,league_id,reminder_id,reminder_revision,occurrence)
);
create index on public.dhq_reminder_deliveries(retry_at) where state in ('pending','sending');
create table public.dhq_reminder_worker_health (
 id boolean primary key default true check(id), last_started_at timestamptz, last_finished_at timestamptz,
 email_ready boolean not null default false,push_ready boolean not null default false,
 email_config_hash text,email_blocked boolean not null default false
);
insert into public.dhq_reminder_worker_health(id) values(true);

do $$ declare t text; begin
 foreach t in array array['dhq_reminder_channels','dhq_push_subscriptions','dhq_dashboard_reminders','dhq_reminder_operations','dhq_reminder_deliveries','dhq_reminder_worker_health'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

create function public.dhq_reminder_next(p_schedule jsonb,p_after timestamptz default now()) returns timestamptz
language plpgsql stable set search_path=public,pg_temp as $$
declare z text:=p_schedule->>'timeZone'; tm time; d date; nominal timestamptz; candidate timestamptz; i integer; begin
 if jsonb_typeof(p_schedule)<>'object' or p_schedule->>'frequency' not in ('daily','weekly') or (p_schedule->>'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or not exists(select 1 from pg_timezone_names where name=z) then raise exception 'invalid_schedule'; end if;
 if p_schedule->>'frequency'='weekly' and (coalesce(p_schedule->>'day','') !~ '^[0-6]$') then raise exception 'invalid_schedule'; end if;
 tm:=(p_schedule->>'time')::time;
 for i in 0..8 loop
  d:=(p_after at time zone z)::date+i;
  if p_schedule->>'frequency'='weekly' and extract(dow from d)::integer<>(p_schedule->>'day')::integer then continue; end if;
  nominal:=(d+tm) at time zone z;
  -- Earliest occurrence on overlap; first valid minute after a spring gap.
  -- A skipped calendar date yields no candidate and moves to the next day.
  select min(t) into candidate from generate_series(nominal-interval '3 hours',nominal+interval '3 hours',interval '1 minute') t
   where (t at time zone z)::date=d and (t at time zone z)::time>=tm;
  if candidate>p_after then return candidate; end if;
 end loop;
 raise exception 'schedule_unavailable';
end $$;

create function public.dhq_reminder_mutate(p_user uuid,p_session integer,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.app_users%rowtype; c public.dhq_reminder_channels%rowtype; r public.dhq_dashboard_reminders%rowtype;
 op public.dhq_reminder_operations%rowtype; sub public.dhq_push_subscriptions%rowtype;
 v jsonb; out jsonb; lid text:=p_data->>'leagueId'; rid text; rev integer; run timestamptz; changed integer; begin
 select * into u from public.app_users where id=p_user for update;
 if not found or u.session_version<>p_session then return jsonb_build_object('ok',false,'code','invalid_session'); end if;
 insert into public.dhq_reminder_channels(user_id) values(p_user) on conflict do nothing;
 select * into c from public.dhq_reminder_channels where user_id=p_user for update;
 if p_action='email-start' then
  update public.dhq_reminder_channels set email=u.email,challenge_id=(p_data->>'challengeId')::uuid,code_hash=p_data->>'codeHash',code_expires_at=now()+interval '15 minutes',code_attempts=0,
   email_opted_in=case when email=u.email then email_opted_in else false end,email_verified_at=case when email=u.email then email_verified_at else null end,updated_at=now() where user_id=p_user;
  return jsonb_build_object('ok',true,'email',u.email);
 elsif p_action='email-confirm' then
  if c.email is distinct from u.email or c.challenge_id is distinct from (p_data->>'challengeId')::uuid or c.code_expires_at<=now() or c.code_expires_at is null or c.code_attempts>=5 or c.code_hash is null then return jsonb_build_object('ok',false,'code','invalid_code'); end if;
  if c.code_hash is distinct from p_data->>'codeHash' then
   update public.dhq_reminder_channels set code_attempts=code_attempts+1 where user_id=p_user;
   return jsonb_build_object('ok',false,'code','invalid_code');
  end if;
  update public.dhq_reminder_channels set email_verified_at=now(),email_opted_in=true,challenge_id=null,code_hash=null,code_expires_at=null,code_attempts=0,
   unsubscribe_token=p_data->>'unsubscribeToken',unsubscribe_hash=p_data->>'unsubscribeHash',updated_at=now() where user_id=p_user;
 elsif p_action='email-disable' then
  update public.dhq_reminder_channels set email_opted_in=false,challenge_id=null,code_hash=null,code_expires_at=null,updated_at=now() where user_id=p_user;
  update public.dhq_dashboard_reminders set state='paused',next_run_at=null,revision=revision+1,updated_at=now() where user_id=p_user and channel='email' and state='enabled';
 elsif p_action='push-subscribe' then
  select * into sub from public.dhq_push_subscriptions where device_key=p_data->>'deviceKey' for update;
  if found and sub.user_id<>p_user then return jsonb_build_object('ok',false,'code','device_conflict'); end if;
  if (not found or not sub.enabled) and (select count(*) from public.dhq_push_subscriptions where user_id=p_user and enabled)>=10 then return jsonb_build_object('ok',false,'code','device_limit'); end if;
  insert into public.dhq_push_subscriptions(device_key,user_id,subscription,app_base) values(p_data->>'deviceKey',p_user,p_data->'subscription',p_data->>'appBase')
   on conflict(device_key) do update set subscription=excluded.subscription,app_base=excluded.app_base,enabled=true,updated_at=now() where dhq_push_subscriptions.user_id=p_user;
  get diagnostics changed=row_count;
  if changed=0 then return jsonb_build_object('ok',false,'code','device_conflict');end if;
 elsif p_action='push-unsubscribe' then
  update public.dhq_push_subscriptions set enabled=false,updated_at=now() where device_key=p_data->>'deviceKey' and user_id=p_user;
  update public.dhq_dashboard_reminders set state='paused',next_run_at=null,revision=revision+1,updated_at=now() where user_id=p_user and channel='push' and device_key=p_data->>'deviceKey' and state='enabled';
 elsif p_action in ('enable','pause') then
  if lid is null or length(lid) not between 1 and 200 or lid ~ '[[:cntrl:]]' then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select * into op from public.dhq_reminder_operations where user_id=p_user and operation_id=(p_data->>'operationId')::uuid;
  if found then
   if op.request<>p_data then return jsonb_build_object('ok',false,'code','operation_conflict'); end if;
   return op.response;
  end if;
  v:=p_data->'reminder';rid:=v->>'id';rev:=(p_data->>'expectedRevision')::integer;
  select * into r from public.dhq_dashboard_reminders where user_id=p_user and league_id=lid and id=rid for update;
  if coalesce(r.revision,0)<>rev then return jsonb_build_object('ok',false,'code','revision_conflict'); end if;
  if p_action='pause' and r.id is null then return jsonb_build_object('ok',false,'code','not_found'); end if;
  if p_action='enable' then
   if r.id is null and (select count(*) from public.dhq_dashboard_reminders where user_id=p_user and league_id=lid)>=24 then return jsonb_build_object('ok',false,'code','reminder_limit'); end if;
   if v->>'channel'='email' and (not c.email_opted_in or c.email_verified_at is null or c.email is distinct from u.email) then return jsonb_build_object('ok',false,'code','email_not_verified'); end if;
   if v->>'channel'='push' and not exists(select 1 from public.dhq_push_subscriptions where device_key=p_data->>'deviceKey' and user_id=p_user and enabled) then return jsonb_build_object('ok',false,'code','push_not_connected'); end if;
   run:=public.dhq_reminder_next(v->'schedule');
   insert into public.dhq_dashboard_reminders(user_id,league_id,id,view_id,title,channel,schedule,device_key,state,revision,next_run_at)
   values(p_user,lid,rid,v->>'viewId',v->>'title',v->>'channel',v->'schedule',case when v->>'channel'='push' then p_data->>'deviceKey' end,'enabled',rev+1,run)
   on conflict(user_id,league_id,id) do update set view_id=excluded.view_id,title=excluded.title,channel=excluded.channel,schedule=excluded.schedule,device_key=excluded.device_key,state='enabled',revision=excluded.revision,next_run_at=excluded.next_run_at,updated_at=now()
   returning * into r;
  else
   update public.dhq_dashboard_reminders set state='paused',next_run_at=null,revision=revision+1,updated_at=now() where user_id=p_user and league_id=lid and id=rid returning * into r;
  end if;
  out:=jsonb_build_object('ok',true,'reminder',to_jsonb(r));
  insert into public.dhq_reminder_operations(user_id,operation_id,request,response) values(p_user,(p_data->>'operationId')::uuid,p_data,out);
  return out;
 else return jsonb_build_object('ok',false,'code','invalid_request'); end if;
 return jsonb_build_object('ok',true);
end $$;

create function public.dhq_reminder_email_unsubscribe(p_hash text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare uid uuid;begin
 select user_id into uid from public.dhq_reminder_channels where unsubscribe_hash=p_hash;
 if uid is null then return false; end if;
 -- Same lock order as account mutations and the worker; unsubscribe is idempotent.
 perform 1 from public.app_users where id=uid for update;
 update public.dhq_reminder_channels set email_opted_in=false,challenge_id=null,code_hash=null,code_expires_at=null,updated_at=now() where user_id=uid and unsubscribe_hash=p_hash;
 -- The capability may have rotated while waiting for the account lock.
 if not found then return false; end if;
 update public.dhq_dashboard_reminders set state='paused',next_run_at=null,revision=revision+1,updated_at=now() where user_id=uid and channel='email' and state='enabled';
 return true;
end $$;

create function public.dhq_reminder_claim(p_limit integer default 20) returns setof public.dhq_reminder_deliveries
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.dhq_dashboard_reminders%rowtype; c public.dhq_reminder_channels%rowtype; s public.dhq_push_subscriptions%rowtype; email text; snap jsonb;begin
 delete from public.dhq_reminder_operations where created_at<now()-interval '30 days';
 delete from public.dhq_reminder_deliveries where state in ('accepted','failed','canceled') and finished_at<now()-interval '30 days';
 update public.dhq_reminder_channels set challenge_id=null,code_hash=null,code_expires_at=null,code_attempts=0 where code_expires_at<now();
 update public.dhq_reminder_worker_health set last_started_at=now() where id;
 for r in select * from public.dhq_dashboard_reminders where state='enabled' and next_run_at<=now() order by next_run_at limit least(greatest(p_limit,1),50) for update skip locked loop
  select u.email into email from public.app_users u where u.id=r.user_id;
  select * into c from public.dhq_reminder_channels where user_id=r.user_id;
  select * into s from public.dhq_push_subscriptions where user_id=r.user_id and device_key=r.device_key and enabled;
  if (r.channel='email' and (not coalesce(c.email_opted_in,false) or c.email_verified_at is null or c.email is distinct from email)) or (r.channel='push' and s.device_key is null) then
   update public.dhq_dashboard_reminders set state='paused',next_run_at=null,revision=revision+1,updated_at=now() where user_id=r.user_id and league_id=r.league_id and id=r.id;
   continue;
  end if;
  snap:=jsonb_build_object('title',r.title,'channel',r.channel,'leagueId',r.league_id,'email',case when r.channel='email' then email end,'unsubscribeToken',case when r.channel='email' then c.unsubscribe_token end,
    'deviceKey',r.device_key,'subscription',case when r.channel='push' then s.subscription end,'appBase',case when r.channel='push' then s.app_base end);
  -- Do not replay old reminders after a long outage. A current due occurrence
  -- can retry for at most six hours, below Resend's 24-hour idempotency horizon.
  if r.next_run_at>now()-interval '6 hours' then
   insert into public.dhq_reminder_deliveries(user_id,league_id,reminder_id,reminder_revision,occurrence,snapshot)
    values(r.user_id,r.league_id,r.id,r.revision,r.next_run_at,snap) on conflict do nothing;
  end if;
  update public.dhq_dashboard_reminders set next_run_at=public.dhq_reminder_next(r.schedule,now()),updated_at=now() where user_id=r.user_id and league_id=r.league_id and id=r.id;
 end loop;
 update public.dhq_reminder_deliveries set state='failed',finished_at=now(),error_code='retry_expired',lease_id=null,lease_until=null where state in ('pending','sending') and (created_at<now()-interval '6 hours' or attempts>=5) and (lease_until is null or lease_until<now());
 return query with jobs as (
  select id from public.dhq_reminder_deliveries where state in ('pending','sending') and retry_at<=now() and (lease_until is null or lease_until<now()) and attempts<5 and created_at>=now()-interval '6 hours'
   order by retry_at limit least(greatest(p_limit,1),50) for update skip locked
 ) update public.dhq_reminder_deliveries d set state='sending',lease_id=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1 from jobs where d.id=jobs.id returning d.*;
end $$;

create function public.dhq_reminder_delivery_current(p_id uuid,p_lease uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.dhq_reminder_deliveries d join public.dhq_dashboard_reminders r on r.user_id=d.user_id and r.league_id=d.league_id and r.id=d.reminder_id
 join public.app_users u on u.id=d.user_id
 left join public.dhq_reminder_channels c on c.user_id=d.user_id
 left join public.dhq_push_subscriptions s on s.device_key=r.device_key and s.user_id=d.user_id
 where d.id=p_id and d.lease_id=p_lease and d.state='sending' and d.lease_until>now() and r.state='enabled' and r.revision=d.reminder_revision
 and ((r.channel='email' and c.email_opted_in and c.email_verified_at is not null and c.email=u.email and c.email=d.snapshot->>'email' and c.unsubscribe_token=d.snapshot->>'unsubscribeToken')
 or (r.channel='push' and s.enabled and s.subscription=d.snapshot->'subscription' and s.app_base=d.snapshot->>'appBase')));
$$;
create function public.dhq_reminder_finish(p_id uuid,p_lease uuid,p_state text,p_provider text default null,p_error text default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.dhq_reminder_deliveries%rowtype;begin
 if p_state not in ('accepted','failed','canceled','retry','gone') then return false;end if;
 select * into d from public.dhq_reminder_deliveries where id=p_id and lease_id=p_lease and state='sending' for update;
 if not found then return false;end if;
 update public.dhq_reminder_deliveries set state=case when p_state='retry' then 'pending' when p_state='gone' then 'failed' else p_state end,provider_id=left(p_provider,200),error_code=left(p_error,100),lease_id=null,lease_until=null,
  retry_at=case when p_state='retry' then now()+make_interval(secs=>least(3600,60*power(2,d.attempts)::integer)) else retry_at end,finished_at=case when p_state='retry' then null else now() end where id=p_id;
 if p_state='gone' then
  update public.dhq_push_subscriptions set enabled=false,updated_at=now() where device_key=d.snapshot->>'deviceKey' and user_id=d.user_id;
  update public.dhq_dashboard_reminders set state='paused',next_run_at=null,revision=revision+1,updated_at=now() where device_key=d.snapshot->>'deviceKey' and user_id=d.user_id and channel='push' and state='enabled';
 end if;
 return true;
end $$;

do $$ declare f record;begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in ('dhq_reminder_next','dhq_reminder_mutate','dhq_reminder_email_unsubscribe','dhq_reminder_claim','dhq_reminder_delivery_current','dhq_reminder_finish') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
