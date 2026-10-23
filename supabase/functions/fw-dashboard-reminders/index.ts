import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleOptions, json, requireActiveAppSession } from '../_shared/security.ts';
import { appBase, DEVICE, maskEmail, object, only, publicReminder, UUID, validText, validateReminder, validateSubscription } from '../_shared/dashboard-reminders-core.ts';
import { config, hash, randomCode, randomToken, sendEmail, verificationEmail } from '../_shared/dashboard-reminders-runtime.ts';

function reply(req:Request,body:unknown,status=200){const r=json(req,body,status);r.headers.set('Cache-Control','no-store');return r;}
function html(body:string,status=200){return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dynasty HQ reminders</title><body>'+body+'</body></html>',{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'"}});}
async function rate(admin:any,user:string,action:string,limit:number,seconds:number){const {data,error}=await admin.rpc('consume_auth_rate_limit',{p_scope:'dashboard-reminders:'+action,p_identifier:user,p_limit:limit,p_window_seconds:seconds,p_lockout_seconds:0});return !error&&data?.allowed===true;}
function mutationStatus(code:string){return code==='invalid_session'?401:['revision_conflict','operation_conflict','device_conflict'].includes(code)?409:code==='invalid_code'?400:400;}

Deno.serve(async(req:Request)=>{
 const opt=handleOptions(req);if(opt)return opt;
 if(!['GET','POST'].includes(req.method))return reply(req,{ok:false,error:'Method not allowed.'},405);
 try{
  const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
  const url=new URL(req.url);
  if(url.searchParams.get('action')==='unsubscribe'){
   const token=url.searchParams.get('token')||'';
   if(!/^[0-9a-f]{64}$/.test(token))return html('<h1>Invalid reminder link</h1>',400);
   if(req.method==='GET')return html('<h1>Stop email reminders?</h1><p>This stops all Dynasty HQ reminder emails for this address. You can reconnect them in Dynasty HQ.</p><form method="post"><button type="submit">Stop email reminders</button></form>');
   const {data,error}=await admin.rpc('dhq_reminder_email_unsubscribe',{p_hash:await hash(token)});
   if(req.headers.get('Accept')?.includes('application/json')){
    if(error)return reply(req,{ok:false,error:'Unable to update reminders. Please try again.'},503);
    return reply(req,{ok:data===true,unsubscribed:data===true},data===true?200:410);
   }
   if(error)return html('<h1>Unable to update reminders</h1><p>Please try again.</p>',503);
   return html(data?'<h1>Email reminders stopped</h1><p>Your account and saved views are unchanged.</p>':'<h1>This link is no longer active</h1><p>Manage reminders in Dynasty HQ.</p>');
  }
  const session=await requireActiveAppSession(admin,req);
  if(!session || (session.payload.sub && session.payload.app_metadata?.user_id && session.payload.sub!==session.payload.app_metadata.user_id))return reply(req,{ok:false,error:'Sign in again.',code:'invalid_session'},401);
  const leagueId=url.searchParams.get('leagueId')||'';
  if(!validText(leagueId,200))return reply(req,{ok:false,error:'Choose a league.'},400);
  const envelope={version:1,accountId:session.userId,leagueId};
  if(!await rate(admin,session.userId,req.method.toLowerCase(),req.method==='GET'?120:60,60))return reply(req,{...envelope,ok:false,error:'Too many requests. Try again shortly.'},429);
  const {data:user,error:userError}=await admin.from('app_users').select('id,email,session_version').eq('id',session.userId).maybeSingle();
  if(userError||!user||user.session_version!==session.sessionVersion)return reply(req,{...envelope,ok:false,error:'Sign in again.'},401);
  const settings=await config(admin);
  if(req.method==='GET'){
   const key=url.searchParams.get('deviceKey');if(key&&!DEVICE.test(key))return reply(req,{...envelope,ok:false,error:'Invalid device.'},400);
   const [channelResult,reminderResult,healthResult,deviceResult]=await Promise.all([
    admin.from('dhq_reminder_channels').select('email,email_verified_at,email_opted_in,code_expires_at,code_attempts').eq('user_id',session.userId).maybeSingle(),
    admin.from('dhq_dashboard_reminders').select('*').eq('user_id',session.userId).eq('league_id',leagueId).order('updated_at'),
    admin.from('dhq_reminder_worker_health').select('*').eq('id',true).maybeSingle(),
    key?admin.from('dhq_push_subscriptions').select('device_key,enabled').eq('user_id',session.userId).eq('device_key',key).maybeSingle():Promise.resolve({data:null,error:null})
   ]);
   if([channelResult,reminderResult,healthResult,deviceResult].some(r=>r.error))return reply(req,{...envelope,ok:false,error:'Reminder service is unavailable.'},503);
   const c=channelResult.data, h=healthResult.data;
   const healthy=h?.last_finished_at && Date.now()-Date.parse(h.last_finished_at)<5*60*1000;
   const verified=!!(c?.email===user.email&&c?.email_verified_at);
   return reply(req,{...envelope,channels:{
    email:{available:!!(settings.emailKey&&healthy&&h.email_ready),recipientVerified:verified,optedIn:verified&&c?.email_opted_in===true,maskedEmail:maskEmail(user.email),verificationPending:!!(c?.email===user.email&&c?.code_expires_at&&Date.parse(c?.code_expires_at)>Date.now()&&c?.code_attempts<5)},
    push:{available:!!(settings.pushPublic&&settings.pushPrivate&&settings.pushSubject&&healthy&&h.push_ready),subscriptionReady:deviceResult.data?.enabled===true,deviceKey:deviceResult.data?.enabled?key:null,vapidPublicKey:settings.pushPublic||null}
   },reminders:(reminderResult.data||[]).map(publicReminder)});
  }
  const raw=await req.text();if(new TextEncoder().encode(raw).length>12000)return reply(req,{...envelope,ok:false,error:'Request is too large.'},413);
  let body:any;try{body=JSON.parse(raw);}catch{return reply(req,{...envelope,ok:false,error:'Invalid request.'},400);}
  if(!object(body)||typeof body.action!=='string')return reply(req,{...envelope,ok:false,error:'Invalid request.'},400);
  const action=body.action;let data:any={leagueId};let sendCode:string|undefined;let codeEmail:string|undefined;
  try{
   if(action==='email-start'){
    only(body,['action']);
    if(!settings.emailKey)return reply(req,{...envelope,ok:false,error:'Email delivery is not configured.'},503);
    if(!await rate(admin,session.userId,'email-start',3,3600))return reply(req,{...envelope,ok:false,error:'Please wait before requesting another code.'},429);
    const code=randomCode(),challengeId=crypto.randomUUID();
    data={...data,challengeId,codeHash:await hash(session.userId+':'+user.email+':'+challengeId+':'+code)};sendCode=code;codeEmail=user.email;
   }else if(action==='email-confirm'){
    only(body,['action','code']);if(typeof body.code!=='string'||!/^\d{6}$/.test(body.code))throw new Error('Enter the six-digit email code.');
    if(!await rate(admin,session.userId,'email-confirm',10,900))return reply(req,{...envelope,ok:false,error:'Too many code attempts. Request a new code later.'},429);
    const {data:c,error}=await admin.from('dhq_reminder_channels').select('challenge_id,email').eq('user_id',session.userId).maybeSingle();
    if(error||!c?.challenge_id||c.email!==user.email)return reply(req,{...envelope,ok:false,error:'This code expired. Request another code.'},400);
    const token=randomToken();data={...data,challengeId:c.challenge_id,codeHash:await hash(session.userId+':'+user.email+':'+c.challenge_id+':'+body.code),unsubscribeToken:token,unsubscribeHash:await hash(token)};
   }else if(action==='email-disable')only(body,['action']);
   else if(action==='push-subscribe'){
    only(body,['action','subscription','deviceKey','appUrl']);
    if(!settings.pushPublic||!settings.pushPrivate)return reply(req,{...envelope,ok:false,error:'Push delivery is not configured.'},503);
    const subscription=validateSubscription(body.subscription),base=appBase(body.appUrl);
    const deviceKey=await hash(subscription.endpoint);if(body.deviceKey!==deviceKey)throw new Error('Push subscription does not match this device.');
    data={...data,subscription,deviceKey,appBase:base};
   }else if(action==='push-unsubscribe'){
    only(body,['action','deviceKey']);if(typeof body.deviceKey!=='string'||!DEVICE.test(body.deviceKey))throw new Error('Invalid device.');data={...data,deviceKey:body.deviceKey};
   }else if(action==='enable'||action==='pause'){
    only(body,['action','operationId','expectedRevision','reminder','deviceKey']);
    if(typeof body.operationId!=='string'||!UUID.test(body.operationId)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||body.expectedRevision>2000000000)throw new Error('Invalid reminder revision.');
    const reminder=validateReminder(body.reminder);
    if(action==='enable'){
     const {data:h,error}=await admin.from('dhq_reminder_worker_health').select('*').eq('id',true).maybeSingle();
     if(error||!h?.last_finished_at||Date.now()-Date.parse(h.last_finished_at)>300000||!(reminder.channel==='email'?settings.emailKey&&h.email_ready:settings.pushPublic&&settings.pushPrivate&&h.push_ready))return reply(req,{...envelope,ok:false,error:'Delivery is unavailable. Try again after the service reconnects.'},503);
     if(reminder.channel==='push'&&(typeof body.deviceKey!=='string'||!DEVICE.test(body.deviceKey)))throw new Error('Connect push on this device first.');
    }
    data={...data,action,operationId:body.operationId,expectedRevision:body.expectedRevision,reminder,...(body.deviceKey?{deviceKey:body.deviceKey}:{})};
   }else throw new Error('Unsupported reminder action.');
  }catch(error){return reply(req,{...envelope,ok:false,error:error instanceof Error?error.message:'Invalid request.'},400);}
  const {data:result,error}=await admin.rpc('dhq_reminder_mutate',{p_user:session.userId,p_session:session.sessionVersion,p_action:action,p_data:data});
  if(error||!result)return reply(req,{...envelope,ok:false,error:'Reminder change could not be confirmed.'},503);
  if(!result.ok)return reply(req,{...envelope,ok:false,code:result.code,error:result.code==='invalid_code'?'That code is incorrect or expired.':result.code==='device_conflict'?'This browser is connected to another account. Disconnect its notifications first.':result.code==='revision_conflict'?'This reminder changed. Refresh its status.':'Reminder change could not be applied.'},mutationStatus(result.code));
  if(sendCode){
   if(result.email!==codeEmail)return reply(req,{...envelope,ok:false,error:'Your email changed. Request a new code.'},409);
   const sent=await sendEmail(settings,verificationEmail(codeEmail!,sendCode),'dhq-reminder-verify/'+data.challengeId);
   if(!sent.ok)return reply(req,{...envelope,ok:false,error:'The verification email could not be sent. Try again later.'},503);
  }
  return reply(req,{...envelope,ok:true,action,...(data.deviceKey?{deviceKey:data.deviceKey}:{}),...(result.reminder?{reminder:publicReminder(result.reminder)}:{})});
 }catch{return reply(req,{ok:false,error:'Reminder service is unavailable. Please try again.'},503);}
});
