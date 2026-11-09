const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const io={opens:0,ranges:0,raw:0,locks:0,flushes:0};
const tables={};let uid=0;const props={FIREBASE_AUTH_CONFIG:JSON.stringify({apiKey:'k',projectId:'p',appId:'a',messagingSenderId:'m'})};
let fetchCount=0;const accounts=new Map(),authCache=new Map(),memberEmail=new Map(),session={active:'owner@example.com',effective:'owner@example.com'};
const tokenFor=email=>{const token=('token-'+email+'-').padEnd(120,'x');accounts.set(token,email);return token};
let now='2026-09-19T03:00:00Z';
class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} }
const triggers=[];const triggerOptions={};
const triggerBuilder={timeBased(){return this},atHour(v){triggerOptions.hour=v;return this},everyDays(v){triggerOptions.days=v;return this},inTimezone(v){triggerOptions.zone=v;return this},create(){const uid='trigger-'+(triggers.length+1);triggers.push({getHandlerFunction:()=> 'dailyCleanup',getUniqueId:()=>uid});return triggers.at(-1)}};
class Sheet{constructor(){this.r=[]}appendRow(r){this.r.push(r.map(String))}getDataRange(){io.ranges++;return{getValues:()=>{io.raw++;return this.r.map(r=>r.slice())},getDisplayValues:()=>this.r.map(r=>r.map(String))}}getParent(){return ss}getLastRow(){return this.r.length}getMaxRows(){return 1000}setFrozenRows(){}getRange(row,col,n,m){const api={setValues:v=>{v.forEach((r,i)=>{this.r[row-1+i]??=[];r.forEach((x,j)=>this.r[row-1+i][col-1+j]=String(x))});return api},setFontWeight:()=>api,setBackground:()=>api,setNumberFormat:()=>api,setValue:v=>api.setValues([[v]]),clearContent:()=>{for(let i=0;i<n;i++){const r=this.r[row-1+i];if(r)for(let j=0;j<m;j++)r[col-1+j]=''}while(this.r.length>1&&this.r.at(-1).every(x=>x===''))this.r.pop();return api}};return api}deleteRow(n){this.r.splice(n-1,1)}}
const ss={getSpreadsheetTimeZone:()=> 'Asia/Tokyo',insertSheet:n=>tables[n]=new Sheet(),getSheetByName:n=>tables[n],getUrl:()=>'',getId:()=> 'test'};
const context=vm.createContext({Date:Clock,ScriptApp:{getProjectTriggers:()=>triggers,newTrigger:()=>triggerBuilder},console:{log(){}},SpreadsheetApp:{create:()=>ss,openById:()=>{io.opens++;return ss},flush(){io.flushes++;}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k],setProperty:(k,v)=>props[k]=v})},CacheService:{getScriptCache:()=>({get:k=>authCache.get(k)??null,put:(k,v)=>authCache.set(k,v)})},UrlFetchApp:{fetch:(url,options)=>{fetchCount++;const email=accounts.get(JSON.parse(options.payload).idToken);return{getResponseCode:()=>email?200:400,getContentText:()=>JSON.stringify(email?{users:[{email,emailVerified:true}]}:{error:{message:'INVALID_ID_TOKEN'}})}}},Session:{getActiveUser:()=>({getEmail:()=>session.active}),getEffectiveUser:()=>({getEmail:()=>session.effective})},Utilities:{formatDate:(d,tz)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d),getUuid:()=>String(++uid).padStart(36,'0'),DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,s)=>Array.from(crypto.createHash('sha256').update(s).digest()),base64EncodeWebSafe:v=>Buffer.from(v).toString('base64url')},LockService:{getScriptLock:()=>({tryLock:()=>{io.locks++;return true},waitLock(){io.locks++;},releaseLock(){}})}});
vm.runInContext(fs.readFileSync(__dirname+'/../Code.gs','utf8'),context);
const c=context;c.setup_();c.setup_(); // Idempotent, safe for repeated first loads.
assert.equal(props.SCHEMA_VERSION,'japanese-headers-v6');
const tok=id=>tokenFor(memberEmail.get(id)||'alice@example.com');
const G=(id)=>c.getData(tok(id),id);
const S=(id,...args)=>c.saveData(tok(id),id,...args);
// Invalid or unregistered logins are rejected before any maintenance write.
tables.Members.appendRow(['','Admin','','','admin@example.com','admin']); // typed directly into the sheet
assert.throws(()=>c.getMembers('short'),/ログイン/);
assert.throws(()=>c.getMembers('x'.repeat(120)),/ログインを確認できません/);
assert.throws(()=>c.getMembers(tokenFor('stranger@example.com')),/未登録/);
assert.equal(tables.Members.r[1][0],'',"unauthenticated calls must not assign IDs");
const adminTok=tokenFor('admin@example.com');
const admin=c.getMembers(adminTok)[0];assert.equal(admin.name,'Admin');assert.ok(admin.id);
assert.equal(tables.Members.r[1][3],'yes'); // a new sheet row is activated with its first ID
memberEmail.set(admin.id,'admin@example.com');
const reg=(name,email)=>{const m=c.registerMember(adminTok,name,email);memberEmail.set(m.id,email);return m};
const alice=reg('Alice','alice@example.com'),bob=reg('Bob','bob@example.com');
const key=alice.id,other=bob.id;
assert.equal(c.getMembers(tok(key))[0].id,key);
assert.equal(Object.keys(c.getMembers(tok(key))[0]).sort().join(','),'id,name');
assert.throws(()=>c.registerMember(tok(key),'Eve','eve@example.com'),/管理者/);
assert.throws(()=>c.registerMember(adminTok,' alice ','x1@example.com'));
assert.throws(()=>c.registerMember(adminTok,'Ａｌｉｃｅ','x2@example.com'));
assert.throws(()=>c.registerMember(adminTok,'Someone','ALICE@example.com'));
assert.throws(()=>c.registerMember(adminTok,'   ','x3@example.com'));
assert.throws(()=>c.registerMember(adminTok,'a'.repeat(41),'x4@example.com'));
assert.equal(G(other).me.name,'Bob');
assert.throws(()=>c.getData(tok(key),other),/登録されたメンバー/); // a token cannot act as another member
let d=S(key,'live',{title:'ライブ',date:'2026-10-01',venue:'会場'});const liveId=d.lives[0].id;
S(key,'attendance',{liveId,status:'参戦'});
d=S(key,'addTickets',{liveId,numbers:['A12','A35','A86'],status:'余り'});assert.equal(d.tickets.length,3);
assert.throws(()=>S(other,'addTickets',{liveId,numbers:['a12'],status:'余り'}));assert.equal(G(key).tickets.length,3);
const t=d.tickets[0];assert.throws(()=>S(other,'ticket',{...t,status:'捌けた'}));
d=S(key,'ticket',{...t,status:'捌けた',recipient:'友人',memo:'譲渡連絡済み',ticketUrl:'https://example.com/my-ticket?code=abc'});assert.equal(d.tickets[0].status,'捌けた');assert.equal(d.tickets[0].recipient,'友人');assert.equal(d.tickets[0].memo,'譲渡連絡済み');assert.equal(d.tickets[0].ticketUrl,'https://example.com/my-ticket?code=abc');assert.throws(()=>S(key,'ticket',{...t,status:'余り'}));
{const mine=G(key).tickets.find(x=>x.id===t.id),seen=G(other).tickets.find(x=>x.id===t.id);
assert.equal(mine.ticketUrl,'https://example.com/my-ticket?code=abc');assert.equal(mine.memo,'譲渡連絡済み');
assert.equal(seen.ticketUrl,'');assert.equal(seen.memo,'');assert.equal(seen.recipient,'');assert.equal(seen.number,mine.number);assert.equal(seen.status,'捌けた');}
console.log('PASS: personal ticket URL, memo and recipient are returned only to the owner');
S(key,'addTickets',{liveId,numbers:['',''],status:'未発券'});assert.equal(G(key).tickets.length,5);
assert.throws(()=>S(key,'addTickets',{liveId,numbers:[''],status:'余り'}));
const pending=G(key).tickets.find(t=>t.status==='未発券');S(key,'ticket',{...pending,number:'A99',status:'自分用'});
const sharedEdit=S(other,'live',{...d.lives[0],title:'変更',memo:'別メンバーのメモ'}).lives[0];
assert.equal(sharedEdit.title,'変更');assert.equal(sharedEdit.memo,'別メンバーのメモ');
assert.throws(()=>S(key,'live',{...d.lives[0],title:'古い変更'}),/他の更新/);
assert.throws(()=>c.saveData(tok(key),other,'live',{...sharedEdit,title:'無効'}),/登録されたメンバー/);
S(key,'deleteTicket',{...d.tickets[0]});assert.equal(G(key).tickets.length,4);
// Upgrade an old sheet, preserving data and adding only the two new columns.
tables.Lives.r=tables.Lives.r.map(r=>r.slice(0,8));
const legacy=JSON.stringify(tables.Lives.r[1]);c.migrateLives_();c.migrateLives_();
assert.equal(JSON.stringify(tables.Lives.r[1]),legacy);
assert.equal(tables.Lives.r[0][8],'抽選締切');
let live=G(key).lives[0];assert.equal(live.requiredThrows,'');
live=S(key,'live',{...live,lotteryDeadline:'2026-09-25',requiredThrows:'30'}).lives[0];
assert.equal(live.lotteryDeadline,'2026-09-25');assert.equal(live.requiredThrows,'30');
for(const bad of ['-1','1.5','NaN','Infinity']) assert.throws(()=>S(key,'live',{...live,requiredThrows:bad}));
assert.throws(()=>S(key,'live',{...live,lotteryDeadline:'2026-02-30'}));
live=S(key,'live',{...live,requiredThrows:'0'}).lives[0];assert.equal(live.requiredThrows,'0');
live=S(key,'live',{...live,lotteryDeadline:'',requiredThrows:''}).lives[0];
assert.equal(live.lotteryDeadline,'');assert.equal(live.requiredThrows,'');
console.log('PASS: deadline and throw target save, validation, clearing, zero, legacy migration');
assert.equal(tables.Lives.r[0][10],'チケット購入URL');
live=S(key,'live',{...live,purchaseUrl:'https://example.com/tickets?id=12&event=3'}).lives[0];
assert.equal(live.purchaseUrl,'https://example.com/tickets?id=12&event=3');
for(const purchaseUrl of ['javascript:alert(1)','https://','data:text/html,test']) assert.throws(()=>S(key,'live',{...live,purchaseUrl}));
for(const ticketUrl of ['javascript:alert(1)','https://','data:text/html,test']) assert.throws(()=>S(key,'ticket',{...d.tickets[0],ticketUrl}));
live=S(key,'live',{...live,purchaseUrl:''}).lives[0];assert.equal(live.purchaseUrl,'');
console.log('PASS: purchase URL persistence, validation, clearing, migration');
live=S(key,'live',{...live,groups:['グループA','グループB','グループA']}).lives[0];
assert.equal(live.groups.join(','),'グループA,グループB');
assert.equal(G(other).groups.join(','),'グループA,グループB');
assert.throws(()=>S(key,'live',{...live,groups:Array(21).fill('グループ')}));
assert.throws(()=>S(key,'live',{...live,groups:['']}));
assert.throws(()=>S(key,'live',{...live,groups:['bad,name']}));
live=S(key,'live',{...live,groups:['グループB']}).lives[0];
assert.equal(live.groups.join(','),'グループB');
live=S(key,'live',{...live,groups:[]}).lives[0];assert.equal(live.groups.length,0);
console.log('PASS: reusable group tags, deduplication, validation, deselection and clearing');
tables.Members.r.find(r=>r[0]===key)[3]='no';assert.throws(()=>G(key));
// A blank status on an existing member means stopped; maintenance must not reactivate it.
const dave=reg('Dave','dave@example.com');tables.Members.r.find(r=>r[0]===dave.id)[3]='';
assert.throws(()=>G(dave.id),/未登録/);c.ensureReady_();
assert.equal(tables.Members.r.find(r=>r[0]===dave.id)[3],'');assert.throws(()=>G(dave.id),/未登録/);
console.log('PASS: login via Google token only, admin-only registration, blank status stays stopped');
console.log('PASS: name registration and selection, selected-member ownership, attendance, batch creation, duplicate rejection, transfer status, stale edits, unissued tickets, deletion, revocation');

// Spreadsheet bulk entry and header migration preserve IDs and related records.
const oldTickets=JSON.stringify(tables.Tickets.r);
const existingId=tables.Lives.r[1][0];
tables.Lives.appendRow(['','まとめ登録','2026-11-01','会場','','',other,'','','5']);
tables.Lives.appendRow([]);
tables.Members.appendRow(['','新しいメンバー']);
props.SCHEMA_VERSION='name-selection-v2';
context._testTables=tables;
vm.runInContext("Object.keys(TABLES).forEach(n=>{_testTables[n].r[0]=Array.from(TABLES[n]);});",context);
c.ensureReady_();
assert.equal(tables.Lives.r[0][1],'イベント名');assert.equal(tables.Tickets.r[0][8],'本人用チケットURL');
assert.equal(tables.Members.r[0][1],'名前');
assert.equal(tables.Lives.r[1][0],existingId);
assert.equal(JSON.stringify(tables.Tickets.r),oldTickets);
const imported=G(other).lives.find(l=>l.title==='まとめ登録');
assert.ok(imported.id);assert.equal(imported.version,'1');
{const row=tables.Members.r.find(r=>r[1]==='新しいメンバー');assert.ok(row[0]);assert.equal(row[3],'yes');}
assert.equal(props.SCHEMA_VERSION,'japanese-headers-v6'); // migration completes once and is not repeated
assert.equal(tables.Lives.r[3][0],undefined);
c.ensureReady_();assert.equal(G(other).lives.find(l=>l.title==='まとめ登録').id,imported.id);
S(other,'live',{...imported,title:'まとめ登録を編集'});
tables.Lives.appendRow([existingId,'重複','2026-11-02']);
assert.throws(()=>c.ensureReady_(),/IDが重複/);
console.log('PASS: Japanese migration preserves data, bulk IDs persist, blank rows skipped, duplicates rejected, imported event editable');

// Calendar boundaries, spreadsheet-native dates and scheduled deletion.
tables.Lives.r.pop(); // remove intentional duplicate from prior test
assert.equal(c.normalizeDate_('9/20',2026),'2026-09-20');
assert.equal(c.normalizeDate_('２０２７/１/２',2026),'2027-01-02');
assert.equal(c.normalizeDate_('2028/2/29',2026),'2028-02-29');
for(const v of ['2/30','2026-02-29','13/1','9/31','random','']) assert.equal(c.normalizeDate_(v,2026),'');
const recordsBefore={members:JSON.stringify(tables.Members.r),tickets:JSON.stringify(tables.Tickets.r),attendance:JSON.stringify(tables.Attendance.r)};
for(const [title,date] of [['昨日','9/18'],['一昨日','2026/9/17'],['今日','9/19'],['明日','9/20'],['不正','2/30'],['未来','2027/1/10']]) tables.Lives.appendRow(['',title,date,'','','',other,'','8/24']);
const archived=title=>tables.Lives.r.filter(r=>r[1]===title).every(r=>r[12]==='yes')&&tables.Lives.r.some(r=>r[1]===title);
const nativeRow=tables.Lives.r.length;
tables.Lives.appendRow(['','日付セル','']);tables.Lives.r[nativeRow][2]=new Date('2026-09-20T15:00:00Z');
c.ensureReady_();
assert.equal(tables.Lives.r.find(r=>r[1]==='日付セル')[2],'2026-09-21');
assert.ok(archived('昨日')&&archived('一昨日')); // past events are archived in place, never deleted
assert.ok(!G(other).lives.some(l=>['昨日','一昨日'].includes(l.title)&&!l.archived));
assert.equal(tables.Lives.r.find(r=>r[1]==='今日')[2],'2026-09-19');
assert.ok(tables.Lives.r.find(r=>r[1]==='明日')[0]);
assert.equal(tables.Lives.r.find(r=>r[1]==='明日')[8],'2026-08-24');
assert.ok(tables.Lives.r.some(r=>r[1]==='不正')); // invalid dates never authorize deletion
assert.ok(!G(other).lives.some(l=>l.title==='不正'));
now='2026-09-19T14:59:59Z';c.dailyCleanup_();assert.ok(!archived('今日'));
now='2026-09-19T15:00:00Z';c.dailyCleanup_();assert.ok(archived('今日'));assert.ok(!archived('明日'));
assert.equal(JSON.stringify(tables.Members.r),recordsBefore.members);
assert.equal(JSON.stringify(tables.Tickets.r),recordsBefore.tickets);
assert.equal(JSON.stringify(tables.Attendance.r),recordsBefore.attendance);
const tomorrowId=tables.Lives.r.find(r=>r[1]==='明日')[0];
c.dailyCleanup_();assert.equal(tables.Lives.r.find(r=>r[1]==='明日')[0],tomorrowId);
assert.throws(()=>S(other,'live',{title:'終了済み',date:'9/19'}),/終了済み/);
now='2026-12-31T14:00:00Z';tables.Lives.appendRow(['','大晦日','12/31']);c.dailyCleanup_();
assert.equal(tables.Lives.r.find(r=>r[1]==='大晦日')[2],'2026-12-31');
now='2026-12-31T15:00:00Z';c.dailyCleanup_();assert.ok(archived('大晦日'));
assert.ok(tables.Lives.r.some(r=>r[1]==='未来'));
session.active='';assert.throws(()=>c.installDailyCleanup(),/エディタ/);assert.equal(triggers.length,0);
session.active='owner@example.com';
c.installDailyCleanup();c.installDailyCleanup();
assert.equal(triggers.length,1);assert.deepEqual(triggerOptions,{hour:0,days:1,zone:'Asia/Tokyo'});
// The public trigger handler rejects google.script.run callers without this project's trigger event.
assert.throws(()=>c.dailyCleanup(),/トリガー/);assert.throws(()=>c.dailyCleanup({triggerUid:'guessed'}),/トリガー/);
c.dailyCleanup({triggerUid:triggers[0].getUniqueId()});
console.log('PASS: short/full/native dates, invalid and leap dates, IDs, JST midnight and year rollover, past events archived (not deleted), trigger deduplication');

const third=reg('Charlie','charlie@example.com');
let editable=S(other,'live',{title:'編集対象',date:'2027-02-01'}).lives.find(l=>l.title==='編集対象');
assert.equal(S(third.id,'live',{...editable,title:'別人'}).lives.find(l=>l.id===editable.id).title,'別人');
tables.Lives.r.find(r=>r[0]===editable.id)[6]='copied-invalid-owner';
editable=G(other).lives.find(l=>l.id===editable.id);
const edited=S(other,'live',{...editable,title:'編集できた'}).lives.find(l=>l.id===editable.id);
assert.equal(edited.title,'編集できた');assert.equal(edited.owner,other);
assert.throws(()=>S(other,'live',{...editable,title:'古い画面'}),/他の更新/);
tables.Lives.appendRow(['','所有者空欄','2027-03-01']);
const unowned=G(other).lives.find(l=>l.title==='所有者空欄');
assert.equal(S(other,'live',{...unowned,title:'空欄から編集'}).lives.find(l=>l.id===unowned.id).owner,other);
io.opens=0;io.ranges=0;G(other);
assert.equal(io.opens,1);assert.equal(io.ranges,4);
// A new request must see direct spreadsheet edits, not an earlier cached snapshot.
tables.Lives.r.find(r=>r[0]===editable.id)[1]='スプシ変更';
assert.equal(G(other).lives.find(l=>l.id===editable.id).title,'スプシ変更');
console.log('PASS: imported event edit/claim, shared event editing, stale edit guard, one workbook open/four table reads, fresh reload');

// Exercise the exact frontend merge with real backend receipts for every mutation.
const frontScript=fs.readFileSync(__dirname+'/../docs/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const front=vm.createContext({performance:{now:()=>0},URLSearchParams,location:{pathname:"/",search:""},sessionStorage:{removeItem(){}},localStorage:{getItem:()=>''}});
vm.runInContext(frontScript.slice(0,frontScript.indexOf('function showSetup()')),front);
let local=G(other);
const compact={response:'patch-v1'};
function fast(action,payload){
  const result=S(other,action,payload,compact);
  assert.equal(result.kind,'patch-v1');assert.ok(!('lives' in result));
  local=front.applySaveResult(local,result);return result;
}
const beforeTime=local.updatedAt;
for(const key of Object.keys(io))io[key]=0;
let receipt=fast('live',{...local.lives.find(l=>l.id===editable.id),title:'高速保存',groups:['タグA']});
assert.deepEqual(io,{opens:1,ranges:2,raw:0,locks:1,flushes:1});
assert.equal(receipt.changes.Lives.upsert.length,1);
assert.equal(local.groups.includes('タグA'),true);assert.equal(local.updatedAt,beforeTime);
const id=editable.id;
fast('attendance',{liveId:id,status:'参戦'});
let participation=local.attendance.find(a=>a.liveId===id&&a.memberId===other);
fast('attendance',{...participation,status:'未定'});
fast('addTickets',{liveId:id,numbers:['Q1','Q2'],status:'余り'});
let ticket=local.tickets.find(t=>t.liveId===id&&t.number==='Q1');
fast('ticket',{...ticket,status:'捌けた',recipient:'友人'});
const stable=JSON.stringify(local);
assert.throws(()=>fast('ticket',{...ticket,status:'取引中'}),/他の更新/);
assert.equal(JSON.stringify(local),stable);
fast('deleteTicket',local.tickets.find(t=>t.liveId===id&&t.number==='Q2'));
fast('live',{title:'新規差分',date:'2027-04-01',groups:['タグB']});
const removable=fast('live',{title:'削除対象',date:'2027-05-01'}).changes.Lives.upsert[0];
fast('attendance',{liveId:removable.id,status:'参戦'});
fast('addTickets',{liveId:removable.id,numbers:['DEL1','DEL2'],status:'余り'});
const removableLive=local.lives.find(l=>l.id===removable.id);
const preview=front.applySaveResult(local,front.optimisticPatch(local,{id:'pending-delete',action:'deleteLive',payload:{id:removable.id,title:removableLive.title}}));
assert.ok(!preview.lives.some(l=>l.id===removable.id));
assert.ok(preview.attendance.some(a=>a.liveId===removable.id));
assert.equal(preview.tickets.filter(t=>t.liveId===removable.id).length,2);
const deletion=fast('deleteLive',{id:removable.id,version:removableLive.version,title:removableLive.title});
assert.deepEqual([...deletion.changes.Lives.remove],[removable.id]);
assert.equal(deletion.changes.Attendance,undefined);
assert.equal(deletion.changes.Tickets,undefined);
assert.ok(!local.lives.some(l=>l.id===removable.id));
assert.ok(local.attendance.some(a=>a.liveId===removable.id));
assert.equal(local.tickets.filter(t=>t.liveId===removable.id).length,2);
assert.throws(()=>S(other,'deleteLive',{id:removable.id,title:'削除対象',version:removableLive.version},compact),/見つかりません/);
const full=G(other);
for(const field of ['lives','tickets','attendance','groups'])assert.equal(JSON.stringify(local[field]),JSON.stringify(full[field]),field);
assert.equal(front.applySaveResult(local,full),full); // Old GAS compatibility.
// Saving must not run import/date/cleanup maintenance on unrelated event rows.
tables.Lives.appendRow(['','保存時には削除しない','2026-12-30']);
fast('live',{...local.lives.find(l=>l.id===id),title:'個別保存'});
assert.ok(tables.Lives.r.find(r=>r[1]==='保存時には削除しない')[12]!=='yes');
G(other);assert.ok(tables.Lives.r.find(r=>r[1]==='保存時には削除しない')[12]==='yes');
console.log('PASS: compact save receipt/real UI merge for all actions, old GAS compatibility, no maintenance during saves, edit reads 2 tables/0 raw values/1 lock/1 flush');
// Mixed statuses are validated as a batch before the single sheet write.
const mixed=[{number:'Ｍ101',status:'自分用',ticketUrl:'https://example.com/M101'},{number:'M102',status:'余り'},{number:'M103',status:'取引中'},{number:'M104',status:'捌けた'},{number:'ignored',status:'未発券'}];
let mixedResult=S(other,'addTickets',{liveId:id,entries:mixed},compact);
assert.equal(mixedResult.changes.Tickets.upsert.map(t=>t.status).join(','),'自分用,余り,取引中,捌けた,未発券');
assert.equal(mixedResult.changes.Tickets.upsert[0].number,'M101');assert.equal(mixedResult.changes.Tickets.upsert[0].ticketUrl,'https://example.com/M101');
assert.equal(mixedResult.changes.Tickets.upsert[4].number,'');
for(const entries of [[],Array(51).fill({number:'',status:'未発券'}),[{number:'M201',status:'余り'},{number:'',status:'捌けた'}],[{number:'M201',status:'余り'},{number:'M101',status:'自分用'}],[{number:'X1',status:'余り'},{number:'ｘ１',status:'取引中'}],[{number:'M201',status:'不正'}],[null]]){
  const before=JSON.stringify(tables.Tickets.r);
  assert.throws(()=>S(other,'addTickets',{liveId:id,entries},compact));
  assert.equal(JSON.stringify(tables.Tickets.r),before);
}
const beforePending=tables.Tickets.r.length;
S(other,'addTickets',{liveId:id,entries:Array(50).fill({number:'',status:'未発券'})},compact);
assert.equal(tables.Tickets.r.length,beforePending+50);
console.log('PASS: per-ticket mixed status batch, normalization, 50 pending tickets, no partial write for invalid/duplicate batch');
// Durable receipts: retries replay successes; ambiguous interrupted writes never repeat.
const req=()=>({response:'patch-v1',requestId:crypto.randomUUID()});
const rid=req();const body={liveId:id,entries:[{number:'R900',status:'余り'}]};
const receipt1=S(other,'addTickets',body,rid),count1=tables.Tickets.r.length;
assert.equal(JSON.stringify(S(other,'addTickets',body,rid)),JSON.stringify(receipt1));
assert.equal(tables.Tickets.r.length,count1);
assert.throws(()=>S(other,'addTickets',{...body,entries:[{number:'R901',status:'余り'}]},rid),/一致しません/);
const target=receipt1.changes.Tickets.upsert[0],editRequest=req();
const editPayload={...target,status:'捌けた'};
const editReceipt=S(other,'ticket',editPayload,editRequest);
assert.equal(JSON.stringify(S(other,'ticket',editPayload,editRequest)),JSON.stringify(editReceipt));
const deleteRequest=req(),deletePayload=editReceipt.changes.Tickets.upsert[0];
S(other,'deleteTicket',deletePayload,deleteRequest);const countDeleted=tables.Tickets.r.length;
S(other,'deleteTicket',deletePayload,deleteRequest);assert.equal(tables.Tickets.r.length,countDeleted);
const uncertain=req();let flushes=0;const flush=context.SpreadsheetApp.flush;
context.SpreadsheetApp.flush=()=>{if(++flushes===2)throw Error('simulated lost write acknowledgement')};
assert.throws(()=>S(other,'addTickets',{liveId:id,entries:[{number:'R999',status:'余り'}]},uncertain));
context.SpreadsheetApp.flush=flush;
const uncertainCount=tables.Tickets.r.length;
assert.throws(()=>S(other,'addTickets',{liveId:id,entries:[{number:'R999',status:'余り'}]},uncertain),/SAVE_UNCERTAIN/);
assert.equal(tables.Tickets.r.length,uncertainCount);
console.log('PASS: durable add/edit/delete retry receipts, payload mismatch rejection, interrupted write does not duplicate');
// Application status requires the current version once a record exists.
{const own=G(other).attendance.find(a=>a.liveId===id&&a.memberId===other);
assert.throws(()=>S(other,'application',{liveId:id,applied:'申込済み'}),/申込状況が更新/);
S(other,'application',{liveId:id,applied:'申込済み',version:own.version});}
// Ticket edits normalize full-width numbers the same way as batch registration.
{const mine=G(other).tickets.find(t=>t.liveId===id&&t.number==='M101');
assert.throws(()=>S(other,'ticket',{...mine,number:'Ｍ１０２'}),/同じ整理番号/);
const renamed=S(other,'ticket',{...mine,number:'Ｍ１０９'},compact).changes.Tickets.upsert[0];assert.equal(renamed.number,'M109');}
console.log('PASS: application version check, full-width ticket number normalization on edit');
// Old completed receipts are removed; pending (uncertain) receipts are always kept.
{const sheet=tables.SaveRequests,before=sheet.r.length;
sheet.appendRow(['old-done','m','ticket','{}','done','{}','2026-01-01T00:00:00.000Z']);
sheet.appendRow(['old-pending','m','ticket','{}','pending','','2026-01-01T00:00:00.000Z']);
assert.equal(c.cleanupSaveRequests_(),1);
assert.ok(!sheet.r.some(r=>r[0]==='old-done'));assert.ok(sheet.r.some(r=>r[0]==='old-pending'));
assert.equal(sheet.r.length,before+1);
assert.throws(()=>S(other,'addTickets',{liveId:id,entries:[{number:'R999',status:'余り'}]},uncertain),/SAVE_UNCERTAIN/);}
console.log('PASS: save receipt cleanup keeps recent and uncertain receipts');
