'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');const {stripTypeScriptTypes}=require('node:module');const {webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..');let groups=0;const pass=name=>{groups++;console.log('PASS '+name);};
const uuid='11111111-1111-4111-8111-111111111111',account='22222222-2222-4222-8222-222222222222';
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:Buffer.alloc(65).toString('base64url'),auth:Buffer.alloc(16).toString('base64url')}};
const job=channel=>({id:uuid,user_id:account,lease_id:'lease',snapshot:{channel,title:'My <view>',leagueId:'1234567890123456789',email:'recipient@example.invalid',unsubscribeToken:'a'.repeat(64),subscription,appBase:'https://c2-football.github.io/WarRoom-sandbox/'}});
function harness(options={}){
 const calls=[],net=[],generated=[];let health;
 const admin={rpc:async(name,args)=>{calls.push({name,args});if(name==='get_app_secret')return{data:''};if(name==='dhq_reminder_claim')return{data:options.jobs||[]};if(name==='dhq_reminder_delivery_current')return{data:options.current!==false,error:options.recheckError?new Error('offline'):null};if(name==='dhq_reminder_finish')return{data:options.finish!==false};throw Error(name);},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:options.prior||null,error:null})})}),update:value=>({eq:async()=>{health=value;return {error:null};}})})};
 const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fake',DASHBOARD_REMINDER_WORKER_SECRET:'test-worker',RESEND_API_KEY:'fake-resend',DASHBOARD_REMINDER_VAPID_PUBLIC_KEY:'fake-public',DASHBOARD_REMINDER_VAPID_PRIVATE_KEY:'fake-private',DASHBOARD_REMINDER_VAPID_SUBJECT:'https://dhqfootball.com',...(options.env||{})};
 const context=vm.createContext({Request,Response,URL,crypto:webcrypto,TextEncoder,Uint8Array,AbortSignal,atob,btoa,console,Deno:{env:{get:key=>env[key]},serve:handler=>{context.handler=handler;}},createClient:()=>admin,webpush:{generateRequestDetails:(sub,payload,settings)=>{generated.push({sub,payload:JSON.parse(payload),settings});return{endpoint:sub.endpoint,headers:{Authorization:'encrypted-fake'},body:new Uint8Array([1,2,3])};}},fetch:async(url,settings)=>{net.push({url,settings});if(options.throw)throw Error('unknown');const status=(typeof options.status==='function'?options.status(url):options.status)||200;return new Response(url.includes('resend')?JSON.stringify({id:'provider-id'}):'',{status,headers:{'Content-Type':'application/json'}});}});
 for(const file of ['supabase/functions/_shared/dashboard-reminders-core.ts','supabase/functions/_shared/dashboard-reminders-runtime.ts','supabase/functions/fw-dashboard-reminder-worker/index.ts']){let s=stripTypeScriptTypes(fs.readFileSync(path.join(root,file),'utf8')).replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');vm.runInContext(s,context,{filename:file});}
 return{calls,net,generated,get health(){return health;},run:(secret='test-worker')=>context.handler(new Request('https://project.supabase.co/functions/v1/fw-dashboard-reminder-worker',{method:'POST',headers:{'x-dashboard-reminder-secret':secret},body:'{}'}))};
}
async function main(){
 let h=harness({jobs:[job('email')]});assert.equal((await h.run('wrong')).status,401);assert(!h.calls.some(c=>c.name==='dhq_reminder_claim'));assert.equal(h.net.length,0);pass('worker requires private scheduler secret before claiming or sending');
 h=harness({jobs:[job('email')]});let result=await h.run();assert.equal(result.status,200);assert.equal(h.net.length,1);const send=h.net[0];assert.equal(send.settings.headers['Idempotency-Key'],'dhq-dashboard-reminder/'+uuid);assert.equal(send.settings.redirect,'error');assert(JSON.parse(send.settings.body).html.includes('&lt;view&gt;'));assert.equal(h.calls.at(-1).args.p_state,'accepted');assert.equal(h.health.email_ready,true);pass('email transport uses immutable occurrence key, escaped view and provider acknowledgement');
 h=harness({jobs:[job('push')]});await h.run();const generated=h.generated[0];assert.equal(generated.payload.accountId,account);assert.equal(generated.payload.tag,'dhq-'+uuid);assert.equal(generated.payload.url,'https://c2-football.github.io/WarRoom-sandbox/index.html#league=1234567890123456789&tab=dashboard');assert.equal(generated.settings.TTL,3600);assert.equal(generated.settings.topic.length,32);assert.equal(h.net[0].settings.redirect,'error');assert.equal(h.calls.at(-1).args.p_state,'accepted');pass('encrypted push invocation carries account, scope-safe link, stable tag/topic and bounded TTL');
 for(const current of [false]){h=harness({jobs:[job('email')],current});await h.run();assert.equal(h.net.length,0);assert.equal(h.calls.at(-1).args.p_state,'canceled');}
 h=harness({jobs:[job('email')],recheckError:true});await h.run();assert.equal(h.net.length,0);assert.equal(h.calls.at(-1).args.p_state,'retry');pass('paused, changed and unavailable authorization checks never send');
 h=harness({jobs:[job('push')],status:410});await h.run();assert.equal(h.calls.at(-1).args.p_state,'gone');
 h=harness({jobs:[job('email')],status:429});await h.run();assert.equal(h.calls.at(-1).args.p_state,'retry');
 h=harness({jobs:[job('email')],status:403});await h.run();assert.equal(h.health.email_ready,false);
 const blocked=h.health;h=harness({prior:blocked,jobs:[]});await h.run();assert.equal(h.health.email_ready,false,'an empty tick cannot recover rejected provider credentials');
 h=harness({prior:blocked,jobs:[],env:{RESEND_API_KEY:'changed-key'}});await h.run();assert.equal(h.health.email_ready,true,'changed credentials release the block');
 h=harness({jobs:[job('push')],throw:true});await h.run();assert.equal(h.calls.at(-1).args.p_state,'retry');assert.equal(h.calls.at(-1).args.p_error,'transport_unknown');
 h=harness({jobs:[job('email')],finish:false});assert.equal((await h.run()).status,503);
 pass('expired endpoints, throttling, bad provider credentials and ambiguous outcomes retain correct states');
 const mixed=Array.from({length:5},(_,i)=>({...job('push'),id:uuid.slice(0,-1)+i,snapshot:{...job('push').snapshot,subscription:{...subscription,endpoint:subscription.endpoint+'/'+i}}}));
 h=harness({jobs:mixed,status:url=>url.endsWith('/0')?403:200});await h.run();
 assert.equal(h.net.length,5,'a rejected subscription must not block the later batch');
 assert.equal(h.calls.filter(c=>c.name==='dhq_reminder_finish'&&c.args.p_state==='accepted').length,4);
 assert.equal(h.calls.filter(c=>c.name==='dhq_reminder_finish'&&c.args.p_error==='push_403').length,1);
 assert.equal(h.health.push_ready,true);const perDeviceHealth=h.health;
 h=harness({prior:perDeviceHealth,jobs:[job('push')]});await h.run();assert.equal(h.net.length,1);assert.equal(h.calls.at(-1).args.p_state,'accepted');
 pass('one subscription authorization failure cannot block healthy devices in this or later ticks');
 console.log(groups+' worker groups passed; actual handler with mocked encryption/provider only.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
