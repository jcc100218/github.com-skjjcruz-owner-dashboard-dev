// Pure validation and presentation; no account data or provider credentials here.
export const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEVICE = /^[0-9a-f]{64}$/;
export const APP_BASES = ['https://dhqfootball.com/', 'https://www.dhqfootball.com/', 'https://c2-football.github.io/WarRoom/', 'https://c2-football.github.io/WarRoom-sandbox/'];
export type Schedule = { frequency: 'daily' | 'weekly'; day: number | null; time: string; timeZone: string };
export type Reminder = { id: string; viewId: string; title: string; channel: 'email' | 'push'; schedule: Schedule };
export function object(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function only(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid request fields.');
}
export function validText(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
export function validateSchedule(value: unknown): Schedule {
  only(value, ['frequency', 'day', 'time', 'timeZone']);
  if (!['daily', 'weekly'].includes(value.frequency) || typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time) || !validText(value.timeZone,100)) throw new Error('Invalid reminder schedule.');
  try { new Intl.DateTimeFormat('en-US',{timeZone:value.timeZone}).format(); } catch { throw new Error('Invalid reminder time zone.'); }
  if (value.frequency === 'weekly' && (!Number.isInteger(value.day) || value.day < 0 || value.day > 6)) throw new Error('Choose a weekday.');
  return { frequency:value.frequency, day:value.frequency==='weekly'?value.day:null, time:value.time, timeZone:value.timeZone };
}
export function validateReminder(value: unknown): Reminder {
  only(value,['id','viewId','title','channel','schedule']);
  if (typeof value.id !== 'string' || !ID.test(value.id) || typeof value.viewId !== 'string' || !ID.test(value.viewId) || !validText(value.title,120) || !['email','push'].includes(value.channel)) throw new Error('Invalid reminder.');
  return {id:value.id,viewId:value.viewId,title:value.title.trim(),channel:value.channel,schedule:validateSchedule(value.schedule)};
}
export function appBase(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Open Dynasty HQ to connect notifications.');
  const url=new URL(value);
  if (url.search || url.hash || url.username || url.password) throw new Error('Invalid app address.');
  const base=url.href.endsWith('index.html')?url.href.slice(0,-10):url.href;
  if (!APP_BASES.includes(base)) throw new Error('Unsupported app address.');
  return base;
}
export function validateSubscription(value: unknown) {
  only(value,['endpoint','keys','expirationTime']); only(value.keys,['p256dh','auth']);
  if (typeof value.endpoint !== 'string' || value.endpoint.length>2000) throw new Error('Invalid push subscription.');
  const url=new URL(value.endpoint);
  const host=url.hostname.toLowerCase();
  const allowed=host==='fcm.googleapis.com' || host==='updates.push.services.mozilla.com' || host==='push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host==='web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  if (!allowed || url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') || url.hash) throw new Error('Unsupported push provider.');
  const decode=(s:unknown,length:number)=>{if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s))return false;try{return atob(s.replace(/-/g,'+').replace(/_/g,'/')).length===length;}catch{return false;}};
  if(!decode(value.keys.p256dh,65)||!decode(value.keys.auth,16))throw new Error('Invalid push encryption keys.');
  if(value.expirationTime!=null && (!Number.isFinite(value.expirationTime)||value.expirationTime<=Date.now()))throw new Error('Push subscription has expired.');
  return {endpoint:url.href,keys:{p256dh:value.keys.p256dh,auth:value.keys.auth},expirationTime:value.expirationTime??null};
}
export function publicReminder(row: any) {
  return {...validateReminder({id:row.id,viewId:row.view_id,title:row.title,channel:row.channel,schedule:row.schedule}),state:row.state,revision:row.revision,nextRunAt:row.state==='enabled'?row.next_run_at:null};
}
export function maskEmail(email: string): string { const [local,domain]=email.split('@');return local?.slice(0,1)+'•••@'+(domain||''); }
export function escapeHtml(value:string):string{return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
export function reviewUrl(base:string,leagueId:string):string{return appBase(base)+'index.html#league='+encodeURIComponent(leagueId)+'&tab=dashboard';}
export function safeEqual(a:string,b:string):boolean{const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);let d=x.length^y.length;for(let i=0;i<Math.max(x.length,y.length);i++)d|=(x[i]||0)^(y[i]||0);return d===0;}
