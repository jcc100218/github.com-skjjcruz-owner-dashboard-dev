-- Activate only after migration, both functions, and worker secret are verified.
-- The worker secret must exist in Vault as DASHBOARD_REMINDER_WORKER_SECRET.
-- Re-running this file replaces this one job; no unrelated jobs are changed.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ declare previous bigint; begin
 select jobid into previous from cron.job where jobname='dhq-dashboard-reminders';
 if previous is not null then perform cron.unschedule(previous);end if;
 if not exists(select 1 from vault.decrypted_secrets where name='DASHBOARD_REMINDER_WORKER_SECRET' and length(decrypted_secret)>20) then raise exception 'Reminder worker secret missing';end if;
 perform cron.schedule('dhq-dashboard-reminders','* * * * *',$job$
  select net.http_post(
   url:='https://sxshiqyxhhifvtfqawbq.supabase.co/functions/v1/fw-dashboard-reminder-worker',
   headers:=jsonb_build_object('Content-Type','application/json','x-dashboard-reminder-secret',(select decrypted_secret from vault.decrypted_secrets where name='DASHBOARD_REMINDER_WORKER_SECRET' limit 1)),
   body:='{}'::jsonb,timeout_milliseconds:=90000
  );
 $job$);
end $$;
commit;
