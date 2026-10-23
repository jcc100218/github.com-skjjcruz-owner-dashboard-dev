'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module'),{PGlite}=require('@electric-sql/pglite'),{webcrypto,createECDH,randomBytes}=require('node:crypto');
const root=path.resolve(__dirname,'..');let groups=0;const pass=name=>{groups++;console.log('PASS '+name);};
async function main(){
 const db=new PGlite();await db.exec("set timezone='UTC';create role anon;create role authenticated;create role service_role;create table app_users(id uuid primary key,email text not null,session_version integer not null);");await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261023010000_dashboard_reminders.sql'),'utf8'));
 const uid='11111111-1111-4111-8111-111111111111',league='1234567890123456789';await db.query('insert into app_users values($1,$2,1)',[uid,'test@example.invalid']);
 const sent=[];let allowed=true,session=true;const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-secret',RESEND_API_KEY:'test-resend',DASHBOARD_REMINDER_WORKER_SECRET:'test-worker',DASHBOARD_REMINDER_VAPID_PUBLIC_KEY:'public',DASHBOARD_REMINDER_VAPID_PRIVATE_KEY:'private',DASHBOARD_REMINDER_VAPID_SUBJECT:'https://dhqfootball.com'};
 const admin={
  rpc:async(name,args)=>{
   if(name==='consume_auth_rate_limit')return{data:{allowed,count:1}};
   if(name==='get_app_secret')return{data:''};
   const defs={dhq_reminder_mutate:['p_user','p_session','p_action','p_data'],dhq_reminder_email_unsubscribe:['p_hash'],dhq_reminder_claim:['p_limit'],dhq_reminder_delivery_current:['p_id','p_lease'],dhq_reminder_finish:['p_id','p_lease','p_state','p_provider','p_error']};
   try{const keys=defs[name];const rows=await db.query('select '+name+'('+keys.map((_,i)=>'$'+(i+1)).join(',')+') value',keys.map(k=>typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]));return{data:rows.rows[0]?.value};}catch(error){return{error};}
  },
  from:table=>{
   assert(['app_users','dhq_reminder_channels','dhq_dashboard_reminders','dhq_reminder_worker_health','dhq_push_subscriptions'].includes(table));
   let cols='*',where=[],params=[],order='',update=null;
   const q={select(value){cols=value;return q;},eq(key,value){params.push(value);where.push(key+'=$'+params.length);return q;},order(key){order=' order by '+key;return q;},update(value){update=value;return q;},async then(resolve,reject){try{let sql='select '+cols+' from '+table+(where.length?' where '+where.join(' and '):'')+order;if(update){const count=params.length;const names=Object.keys(update);sql='update '+table+' set '+names.map((key,i)=>key+'=$'+(count+i+1)).join(',')+(where.length?' where '+where.join(' and '):'')+' returning *';params.push(...Object.values(update));}const result=await db.query(sql,params);resolve({data:result.rows,error:null});}catch(error){if(reject)reject(error);else resolve({data:null,error});}},async maybeSingle(){return new Promise(resolve=>q.then(r=>resolve({...r,data:r.data?.[0]||null})));}};return q;
  }
 };
 const context=vm.createContext({Request,Response,URL,Headers,crypto:webcrypto,TextEncoder,Uint8Array,AbortSignal,atob,btoa,console,setTimeout,clearTimeout,Deno:{env:{get:key=>env[key]},serve:handler=>{context.handler=handler;}},createClient:()=>admin,handleOptions:req=>req.method==='OPTIONS'?new Response('ok'):null,json:(req,body,status=200)=>Response.json(body,{status}),requireActiveAppSession:async()=>session?{userId:uid,sessionVersion:1,payload:{sub:uid,app_metadata:{user_id:uid}}}:null,fetch:async(url,options)=>{sent.push({url,options,payload:JSON.parse(options.body)});return Response.json({id:'email-'+sent.length});}});
 function load(file){let source=stripTypeScriptTypes(fs.readFileSync(path.join(root,file),'utf8'));source=source.replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');vm.runInContext(source,context,{filename:file});}
 load('supabase/functions/_shared/dashboard-reminders-core.ts');load('supabase/functions/_shared/dashboard-reminders-runtime.ts');load('supabase/functions/fw-dashboard-reminders/index.ts');
 const call=async(body,method='POST',extra='')=>context.handler(new Request('https://project.supabase.co/functions/v1/fw-dashboard-reminders?leagueId='+league+extra,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));
 session=false;assert.equal((await call({action:'email-start'})).status,401);assert.equal(sent.length,0);session=true;
 let result=await call({action:'email-start',email:'attacker@example.invalid'});assert.equal(result.status,400);assert.equal(sent.length,0);
 allowed=false;assert.equal((await call({action:'email-start'})).status,429);allowed=true;
 result=await call({action:'email-start'});assert.equal(result.status,200);assert.deepEqual(sent[0].payload.to,['test@example.invalid']);assert(sent[0].options.headers['Idempotency-Key'].startsWith('dhq-reminder-verify/'));
 const code=sent[0].payload.text.match(/code is (\d{6})/)[1];
 assert.equal((await call({action:'email-confirm',code:'999999'===code?'888888':'999999'})).status,400);
 assert.equal((await call({action:'email-confirm',code})).status,200);
 let state=await(await call(null,'GET')).json();assert.equal(state.channels.email.optedIn,true);assert.equal(state.channels.email.available,false);assert.equal(state.channels.email.maskedEmail,'t•••@example.invalid');assert(!JSON.stringify(state).includes('code_hash'));
 pass('authenticated verification sends only to database email; exact action acknowledgement and no forged recipient');
 const reminder={id:'rem_one',viewId:'alex_v',title:'Review <img>',channel:'email',schedule:{frequency:'daily',day:null,time:'09:00',timeZone:'America/Chicago'}};
 const command={action:'enable',operationId:'22222222-2222-4222-8222-222222222222',expectedRevision:0,reminder};
 assert.equal((await call(command)).status,503);
 await db.exec('update dhq_reminder_worker_health set last_finished_at=now(),email_ready=true,push_ready=true');
 result=await call(command);assert.equal(result.status,200);const enabled=await result.json();assert.equal(enabled.reminder.state,'enabled');assert.equal(enabled.reminder.id,reminder.id);assert.equal(enabled.accountId,uid);assert.equal(enabled.leagueId,league);
 assert.deepEqual(await(await call(command)).json(),enabled);
 state=await(await call(null,'GET')).json();assert.equal(state.reminders.length,1);assert.equal(state.channels.email.available,true);assert(!JSON.stringify(state).includes('unsubscribe'));assert(!JSON.stringify(state).includes('test@example.invalid'));
 pass('worker health gates enabling, exact reminder schema, safe capabilities and repeated request recovery');
 const ecdh=createECDH('prime256v1');ecdh.generateKeys();const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 const device=await context.hash(subscription.endpoint);
 assert.equal((await call({action:'push-subscribe',deviceKey:device,subscription,appUrl:'https://evil.test/'})).status,400);
 const connected=await(await call({action:'push-subscribe',deviceKey:device,subscription,appUrl:'https://c2-football.github.io/WarRoom-sandbox/index.html'})).json();assert.equal(connected.deviceKey,device);assert.equal(connected.action,'push-subscribe');
 state=await(await call(null,'GET','&deviceKey='+device)).json();assert.equal(state.channels.push.subscriptionReady,true);assert(!JSON.stringify(state).includes(subscription.keys.auth));
 const disconnected=await(await call({action:'push-unsubscribe',deviceKey:device})).json();assert.equal(disconnected.deviceKey,device);assert.equal(disconnected.ok,true);
 pass('push subscription app scope, device binding, connect/disconnect acknowledgements and secret-free reads');
 const channel=(await db.query('select * from dhq_reminder_channels where user_id=$1',[uid])).rows[0];
 const unsub='https://project.supabase.co/functions/v1/fw-dashboard-reminders?action=unsubscribe&token='+channel.unsubscribe_token;
 const get=await context.handler(new Request(unsub));assert.equal(get.status,200);assert((await get.text()).includes('<form method="post">'));
 assert.equal((await db.query('select state from dhq_dashboard_reminders where user_id=$1',[uid])).rows[0].state,'enabled');
 const post=await context.handler(new Request(unsub,{method:'POST',body:'List-Unsubscribe=One-Click'}));assert.equal(post.status,200);assert.equal((await db.query('select state from dhq_dashboard_reminders where user_id=$1',[uid])).rows[0].state,'paused');
 const jsonPost=await context.handler(new Request(unsub,{method:'POST',headers:{Accept:'application/json'}}));assert.equal(jsonPost.status,200);assert.deepEqual(await jsonPost.json(),{ok:true,unsubscribed:true});
 const oldLink=await context.handler(new Request(unsub.replace(channel.unsubscribe_token,'f'.repeat(64)),{method:'POST',headers:{Accept:'application/json'}}));assert.equal(oldLink.status,410);assert.deepEqual(await oldLink.json(),{ok:false,unsubscribed:false});
 pass('email scanners do not unsubscribe on GET; browser and one-click POST revoke delivery with truthful acknowledgement');
 const email=context.reminderEmail('test@example.invalid','<img onerror="bad">',league,unsub);assert(email.html.includes('&lt;img'));assert(!email.html.includes('<img'));assert.equal(email.headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');assert(email.text.includes('https://c2-football.github.io/WarRoom/index.html#league='));assert(email.text.includes('https://c2-football.github.io/WarRoom/reminder-unsubscribe.html#token='+channel.unsubscribe_token));assert(email.html.includes('reminder-unsubscribe.html#token='));assert(!email.text.includes(unsub));assert.equal(email.headers['List-Unsubscribe'],'<'+unsub+'>');
 await context.sendEmail({emailKey:'test',from:'sender@example.invalid'},email,'occurrence-id');assert.equal(sent.at(-1).options.redirect,'error');assert.equal(sent.at(-1).options.headers['Idempotency-Key'],'occurrence-id');
 pass('provider payload escapes titles, supplies unsubscribe headers and stable idempotency');
 if(process.argv[2]){
  const clientFile=path.resolve(process.argv[2]);assert(fs.existsSync(clientFile),'Pass the current frontend dashboard-reminders.js file');
  const token='header.'+Buffer.from(JSON.stringify({sub:uid,exp:Math.floor(Date.now()/1000)+3600,app_metadata:{user_id:uid,session_version:1}})).toString('base64url')+'.signature';
  const wire=[];
  const browser=vm.createContext({console,URL,crypto:webcrypto,TextEncoder,Uint8Array,AbortController,atob,btoa,setTimeout,clearTimeout,document:{baseURI:'https://c2-football.github.io/WarRoom/index.html'},navigator:{},localStorage:{getItem:()=>null},App:{OD:{getSessionToken:()=>token},CONFIG:{supabaseUrl:'https://project.supabase.co',supabaseAnon:'public-anon'}},fetch:async(url,options)=>{
   assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.headers.apikey,'public-anon');
   if(options.body)wire.push(JSON.parse(options.body));return context.handler(new Request(url,options));
  }});
  vm.runInContext(fs.readFileSync(clientFile,'utf8'),browser,{filename:clientFile});
  const client=browser.WR.DashboardReminders,scope=uid+':'+league;
  const proof=async()=>{const service=await client.checkService({scope,leagueId:league});assert.equal(service.status,'ready',service.reason);return {scope,leagueId:league,service};};
  const channel=async(action,extra={})=>{const result=await client.channelAction({...await proof(),action,...extra});assert.equal(result.action,action);assert.equal(result.ok,true);return result;};
  await channel('email-start');const freshCode=sent.at(-1).payload.text.match(/code is (\d{6})/)[1];await channel('email-confirm',{code:freshCode});
  const clientDraft={...reminder,id:'client_contract'};
  assert.equal((await client.configure({...await proof(),draft:clientDraft,viewSaved:true})).state,'enabled');
  assert.equal((await client.configure({...await proof(),draft:clientDraft,action:'pause'})).state,'paused');
  await channel('push-subscribe',{deviceKey:device,subscription});await channel('push-unsubscribe',{deviceKey:device});await channel('email-disable');
  assert.deepEqual(wire.map(item=>item.action),['email-start','email-confirm','enable','pause','push-subscribe','push-unsubscribe','email-disable']);
  assert(wire.filter(item=>!['enable','pause'].includes(item.action)).every(item=>!('operationId' in item)));
  assert.equal((await client.checkService({scope,leagueId:league})).channels.email.optedIn,false);
  pass('actual frontend adapter interoperates with strict API and PostgreSQL for all seven mutation actions');
 }
 await db.close();console.log(groups+' endpoint groups passed; real handler + local PostgreSQL, mocked transport only.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
