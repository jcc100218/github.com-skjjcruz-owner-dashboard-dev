import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { reviewUrl, safeEqual, validateSubscription } from '../_shared/dashboard-reminders-core.ts';
import { config, hash, reminderEmail, sendEmail } from '../_shared/dashboard-reminders-runtime.ts';

Deno.serve(async(req:Request)=>{
 if(req.method!=='POST')return new Response('Method not allowed',{status:405});
 const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 try{
  const settings=await config(admin);
  const supplied=req.headers.get('x-dashboard-reminder-secret')||'';
  if(!settings.workerSecret||!safeEqual(supplied,settings.workerSecret))return new Response('Unauthorized',{status:401});
  const emailHash=await hash(settings.emailKey+'|'+settings.from);
  const prior=await admin.from('dhq_reminder_worker_health').select('*').eq('id',true).maybeSingle();
  if(prior.error)return new Response('Worker health unavailable',{status:503});
  let emailBlocked=prior.data?.email_blocked===true&&prior.data?.email_config_hash===emailHash;
  let emailReady=!!settings.emailKey&&!emailBlocked;
  const pushReady=!!(settings.pushPublic&&settings.pushPrivate&&settings.pushSubject);
  const {data:jobs,error}=await admin.rpc('dhq_reminder_claim',{p_limit:20});
  if(error||!Array.isArray(jobs))return new Response('Queue unavailable',{status:503});
  const totals={accepted:0,retried:0,failed:0,canceled:0,unconfirmed:0};
  async function finish(job:any,state:string,id:string|null=null,error:string|null=null){
   const result=await admin.rpc('dhq_reminder_finish',{p_id:job.id,p_lease:job.lease_id,p_state:state,p_provider:id,p_error:error});
   if(result.error||result.data!==true){totals.unconfirmed++;return;}
   if(state==='accepted')totals.accepted++;else if(state==='retry')totals.retried++;else if(state==='canceled')totals.canceled++;else totals.failed++;
  }
  async function deliver(job:any){
   const current=await admin.rpc('dhq_reminder_delivery_current',{p_id:job.id,p_lease:job.lease_id});
   if(current.error){await finish(job,'retry',null,'recheck_unavailable');return;}
   if(current.data!==true){await finish(job,'canceled',null,'schedule_changed');return;}
   const s=job.snapshot;
   try{
    if(s.channel==='email'){
     if(!emailReady){await finish(job,'retry',null,'email_unavailable');return;}
     const unsubscribe=Deno.env.get('SUPABASE_URL')+'/functions/v1/fw-dashboard-reminders?action=unsubscribe&token='+encodeURIComponent(s.unsubscribeToken);
     const response=await sendEmail(settings,reminderEmail(s.email,s.title,s.leagueId,unsubscribe),'dhq-dashboard-reminder/'+job.id);
     if(response.ok)await finish(job,'accepted',response.id);
     else {if([401,403].includes(response.status)){emailReady=false;emailBlocked=true;}await finish(job,response.status===429||response.status>=500||[401,403,409].includes(response.status)?'retry':'failed',null,'email_'+response.status);}
    }else{
     if(!pushReady){await finish(job,'retry',null,'push_unavailable');return;}
     const subscription=validateSubscription(s.subscription);
     const payload=JSON.stringify({version:1,accountId:job.user_id,title:s.title,body:'Time to review your saved Dynasty HQ view.',url:reviewUrl(s.appBase,s.leagueId),tag:'dhq-'+job.id});
     const details=webpush.generateRequestDetails(subscription,payload,{TTL:3600,urgency:'normal',topic:job.id.replace(/-/g,'').slice(0,32),vapidDetails:{subject:settings.pushSubject,publicKey:settings.pushPublic,privateKey:settings.pushPrivate}});
     const response=await fetch(details.endpoint,{method:'POST',headers:details.headers,body:details.body,redirect:'error',signal:AbortSignal.timeout(15000)});
     if(response.ok)await finish(job,'accepted');
     else if([404,410].includes(response.status))await finish(job,'gone',null,'push_'+response.status);
     // Push authorization errors can identify a single subscription/VAPID mismatch.
     // Never let an untrusted subscription disable delivery for other accounts.
     else await finish(job,response.status===429||response.status>=500||[401,403].includes(response.status)?'retry':'failed',null,'push_'+response.status);
    }
   }catch{await finish(job,'retry',null,'transport_unknown');}
  }
  // Four bounded network requests at a time stay within the two-minute lease.
  for(let offset=0;offset<jobs.length;offset+=4)await Promise.all(jobs.slice(offset,offset+4).map(deliver));
  const health=await admin.from('dhq_reminder_worker_health').update({last_finished_at:new Date().toISOString(),email_ready:emailReady,push_ready:pushReady,email_config_hash:emailHash,email_blocked:emailBlocked}).eq('id',true);
  if(health.error)return new Response('Worker health unavailable',{status:503});
  return Response.json({ok:totals.unconfirmed===0,claimed:jobs.length,...totals},{status:totals.unconfirmed?503:200,headers:{'Cache-Control':'no-store'}});
 }catch{return new Response('Reminder worker unavailable',{status:503});}
});
