const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto');
const source=fs.readFileSync(__dirname+'/../Push.gs','utf8');
const code=fs.readFileSync(__dirname+'/../Code.gs','utf8');
let time=Date.parse('2026-09-24T11:59:00+09:00'),sent=[],fetchStatus=200,lives=[];
const props=new Map(),cache=new Map();
const p={getProperty:k=>props.get(k)||null,setProperty:(k,v)=>{props.set(k,v);return p},deleteProperty:k=>props.delete(k),getProperties:()=>Object.fromEntries(props)};
const D=class extends Date{constructor(...args){super(...(args.length?args:[time]))}static now(){return time}};
const c=vm.createContext({Date:D,console,PropertiesService:{getScriptProperties:()=>p},LockService:{getUserLock:()=>({waitLock(){},tryLock:()=>true,releaseLock(){}})},Utilities:{formatDate:(d,tz,format)=>format==='H'?new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}).format(d):d.toLocaleDateString('sv-SE',{timeZone:tz}),DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,v)=>crypto.createHash('sha256').update(v).digest(),base64EncodeWebSafe:v=>Buffer.from(v).toString('base64url')},CacheService:{getScriptCache:()=>({remove:k=>cache.delete(k)})},UrlFetchApp:{fetch:(url,options)=>{sent.push(JSON.parse(options.payload));return {getResponseCode:()=>fetchStatus,getContentText:()=>JSON.stringify(fetchStatus===404?{error:{details:[{errorCode:'UNREGISTERED'}]}}:{name:'sent'})}}},resetRequest_(){},selectedMember_:id=>{if(id!=='me')throw Error('invalid member')},rows_:()=>lives});
vm.runInContext(code.slice(code.indexOf('function normalizeDate_('),code.indexOf('function normalizeSheetDates_(')),c);
vm.runInContext(source,c);c.pushAccessToken_=()=> 'test-token';
assert.equal(c.getPushSettings().ready,false);
p.setProperty('PUSH_FIREBASE_CONFIG',JSON.stringify({apiKey:'public-key',projectId:'project',messagingSenderId:'123',appId:'app',private_key:'must-not-leak'}));
p.setProperty('PUSH_VAPID_PUBLIC_KEY','A'.repeat(87));p.setProperty('PUSH_SERVICE_ACCOUNT',JSON.stringify({project_id:'project',client_email:'service@example.com',private_key:'PRIVATE'}));p.setProperty('PUSH_ENABLED','yes');
assert.equal(c.getPushSettings().ready,true);assert(!JSON.stringify(c.getPushSettings()).includes('PRIVATE'));assert(!JSON.stringify(c.getPushSettings()).includes('private_key'));
const device={id:'00000000-0000-0000-0000-000000000001',secret:'a'.repeat(64),token:'fcm:token'};
c.savePushSubscription('me',device);assert.throws(()=>c.removePushSubscription(device.id,'b'.repeat(64)),/一致/);
lives=[{id:'one',title:'Test event',date:'2026-10-15',lotteryDeadline:'9/24',requiredThrows:'3'},{id:'past',title:'past',date:'2026-09-23',lotteryDeadline:'2026-09-24'}];
c.sendDeadlinePush_();assert.equal(sent.length,0);
time=Date.parse('2026-09-24T12:00:00+09:00');c.sendDeadlinePush_();assert.equal(sent.length,1);assert.match(sent[0].message.data.body,/Test event／投げ数 3枚/);assert(!sent[0].message.data.body.includes('past'));assert.equal(sent[0].message.webpush.headers.TTL,'43199');
c.sendDeadlinePush_();assert.equal(sent.length,1);c.savePushSubscription('me',device);c.sendDeadlinePush_();assert.equal(sent.length,1);
c.removePushSubscription(device.id,device.secret);assert.equal(JSON.parse(p.getProperty('PUSH_DEVICE_'+device.id)).enabled,false);
// New day, opt-in again, transient retry is delayed and successful sends deduplicate.
time=Date.parse('2026-09-25T12:00:00+09:00');lives[0].lotteryDeadline='2026-09-25';c.savePushSubscription('me',device);fetchStatus=503;c.sendDeadlinePush_();assert.equal(sent.length,2);c.sendDeadlinePush_();assert.equal(sent.length,2);time+=16*60000;fetchStatus=200;c.sendDeadlinePush_();assert.equal(sent.length,3);c.sendDeadlinePush_();assert.equal(sent.length,3);
// Year crossing, deleted/empty days, and expired subscriptions.
assert.equal(c.pushDueEvents_([{id:'jan',title:'Jan',date:'2027-01-05',lotteryDeadline:'12/31'}],'2026-12-31').length,1);
lives=[];time+=86400000;c.sendDeadlinePush_();assert.equal(sent.length,3);
lives=[{id:'x',title:'x',date:'2026-12-01',lotteryDeadline:'2026-09-26'}];fetchStatus=404;c.sendDeadlinePush_();assert.equal(JSON.parse(p.getProperty('PUSH_DEVICE_'+device.id)).enabled,false);
// Per-device group filtering: OR matching, never duplicate a multi-group event.
for(const key of [...props.keys()])if(key.startsWith('PUSH_DEVICE_'))props.delete(key);
sent=[];fetchStatus=200;time=Date.parse('2026-09-27T12:00:00+09:00');
lives=[
 {id:'both',title:'A and B live',date:'2026-10-01',lotteryDeadline:'2026-09-27',groups:'["A","B"]',requiredThrows:'3'},
 {id:'other',title:'C only',date:'2026-10-02',lotteryDeadline:'2026-09-27',groups:'["C"]',requiredThrows:'2'},
 {id:'untagged',title:'No tags',date:'2026-10-03',lotteryDeadline:'2026-09-27',groups:''}
];
assert.throws(()=>c.savePushSubscription('me',{...device,groups:[]}),/1つ以上/);
c.savePushSubscription('me',{...device,groups:['A','B','A']});
assert.equal(c.getPushSettings(device.id,device.secret,true).selectedGroups.join(','),'A,B');
assert.throws(()=>c.getPushSettings(device.id,'b'.repeat(64),true),/一致/);
c.savePushSubscription('me',device); // Old clients/token refresh omit groups; preserve server preference.
assert.equal(c.getPushSettings(device.id,device.secret,true).selectedGroups.join(','),'A,B');
c.sendDeadlinePush_();assert.equal(sent.length,1);assert.equal(sent[0].message.data.title,'本日抽選締切（1件）');
assert.equal(sent[0].message.data.body.split('A and B live').length-1,1);assert(!sent[0].message.data.body.includes('C only'));
c.sendDeadlinePush_();assert.equal(sent.length,1);
// Nonmatching devices must not occupy the batch and starve other subscribers.
for(let i=2;i<=12;i++)c.savePushSubscription('me',{id:'00000000-0000-0000-0000-'+String(i).padStart(12,'0'),secret:'a'.repeat(64),token:'token'+i,groups:['Absent']});
const all={id:'00000000-0000-0000-0000-000000000013',secret:'a'.repeat(64),token:'all'};
c.savePushSubscription('me',{...all,groups:null});c.sendDeadlinePush_();assert.equal(sent.length,2);assert.equal(sent[1].message.data.title,'本日抽選締切（3件）');
assert(!JSON.parse(p.getProperty('PUSH_DEVICE_00000000-0000-0000-0000-000000000002')).sentDay);
// Untagged/invalid group data never matches a selected group; all still includes it.
assert.equal(c.pushFilterEvents_(lives,['Missing']).length,0);assert.equal(c.pushFilterEvents_(lives,null).length,3);
console.log('PASS: per-device selections, same event with multiple selected groups once, all-groups mode, no-match skip, batch fairness, old-client preservation, credential checks');
console.log('PASS: noon JST, no early/empty/past sends, date normalization, receipts, transient retry, opt-out ownership, expired tokens, public config excludes credentials');
(async()=>{
 const handlers={},shown=[],opened=[];
 const sw={self:{addEventListener:(k,f)=>handlers[k]=f,registration:{scope:'https://example.test/ticket-management/docs/',showNotification:(t,o)=>{shown.push({t,o});return Promise.resolve()}},clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async url=>opened.push(url)},skipWaiting(){}},URL};
 vm.runInNewContext(fs.readFileSync(__dirname+'/../docs/push-worker.js','utf8'),sw);
 let task;handlers.push({data:{json:()=>({data:{title:'締切',body:'投げ数 3枚',tag:'day'}})},waitUntil:p=>task=p});await task;
 assert.equal(shown.length,1);assert.equal(shown[0].o.tag,'day');assert.equal(shown[0].o.renotify,false);
 handlers.notificationclick({notification:{close(){},data:{url:'https://evil.test'}},waitUntil:p=>task=p});await task;
 assert.equal(opened[0],'https://example.test/ticket-management/docs/');assert(!handlers.fetch);
 console.log('PASS: push display, same-day tag, fixed app click URL, no fetch interception/cache');
})().catch(e=>{console.error(e);process.exitCode=1});
