const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const io={opens:0,ranges:0,raw:0,locks:0,flushes:0};
const tables={};let uid=0;const props={};
let now='2026-09-19T03:00:00Z';
class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} }
const triggers=[];const triggerOptions={};
const triggerBuilder={timeBased(){return this},atHour(v){triggerOptions.hour=v;return this},everyDays(v){triggerOptions.days=v;return this},inTimezone(v){triggerOptions.zone=v;return this},create(){triggers.push({getHandlerFunction:()=> 'dailyCleanup'});return triggers.at(-1)}};
class Sheet{constructor(){this.r=[]}appendRow(r){this.r.push(r.map(String))}getDataRange(){io.ranges++;return{getValues:()=>{io.raw++;return this.r.map(r=>r.slice())},getDisplayValues:()=>this.r.map(r=>r.map(String))}}getParent(){return ss}getLastRow(){return this.r.length}getMaxRows(){return 1000}setFrozenRows(){}getRange(row,col,n,m){const api={setValues:v=>{v.forEach((r,i)=>{this.r[row-1+i]??=[];r.forEach((x,j)=>this.r[row-1+i][col-1+j]=String(x))});return api},setFontWeight:()=>api,setBackground:()=>api,setNumberFormat:()=>api};return api}deleteRow(n){this.r.splice(n-1,1)}}
const ss={getSpreadsheetTimeZone:()=> 'Asia/Tokyo',insertSheet:n=>tables[n]=new Sheet(),getSheetByName:n=>tables[n],getUrl:()=>'',getId:()=> 'test'};
const context=vm.createContext({Date:Clock,ScriptApp:{getProjectTriggers:()=>triggers,newTrigger:()=>triggerBuilder},console:{log(){}},SpreadsheetApp:{create:()=>ss,openById:()=>{io.opens++;return ss},flush(){io.flushes++;}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k],setProperty:(k,v)=>props[k]=v})},Utilities:{formatDate:(d,tz)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d),getUuid:()=>String(++uid).padStart(36,'0'),DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,s)=>Array.from(crypto.createHash('sha256').update(s).digest())},LockService:{getScriptLock:()=>({tryLock:()=>{io.locks++;return true},waitLock(){io.locks++;},releaseLock(){}})}});
vm.runInContext(fs.readFileSync(__dirname+'/../Code.gs','utf8'),context);
const c=context;c.setup_();c.setup_(); // Idempotent, safe for repeated first loads.
assert.equal(c.getMembers().length,0);
const alice=c.registerMember('Alice'),bob=c.registerMember('Bob');
const key=alice.id,other=bob.id;
assert.equal(c.getMembers().length,2);
assert.equal(Object.keys(c.getMembers()[0]).sort().join(','),'id,name');
assert.throws(()=>c.registerMember(' alice '));
assert.throws(()=>c.registerMember('Ａｌｉｃｅ'));
assert.throws(()=>c.registerMember('   '));
assert.throws(()=>c.registerMember('a'.repeat(41)));
assert.equal(c.getData(other).me.name,'Bob'); // Name selection is deliberately not authentication.
assert.throws(()=>c.getData('invalid'));
let d=c.saveData(key,'live',{title:'ライブ',date:'2026-10-01',venue:'会場'});const liveId=d.lives[0].id;
c.saveData(key,'attendance',{liveId,status:'参戦'});
d=c.saveData(key,'addTickets',{liveId,numbers:['A12','A35','A86'],status:'余り'});assert.equal(d.tickets.length,3);
assert.throws(()=>c.saveData(other,'addTickets',{liveId,numbers:['a12'],status:'余り'}));assert.equal(c.getData(key).tickets.length,3);
const t=d.tickets[0];assert.throws(()=>c.saveData(other,'ticket',{...t,status:'捌けた'}));
d=c.saveData(key,'ticket',{...t,status:'捌けた',recipient:'友人'});assert.equal(d.tickets[0].status,'捌けた');assert.throws(()=>c.saveData(key,'ticket',{...t,status:'余り'}));
c.saveData(key,'addTickets',{liveId,numbers:['',''],status:'未発券'});assert.equal(c.getData(key).tickets.length,5);
assert.throws(()=>c.saveData(key,'addTickets',{liveId,numbers:[''],status:'余り'}));
const pending=c.getData(key).tickets.find(t=>t.status==='未発券');c.saveData(key,'ticket',{...pending,number:'A99',status:'自分用'});
assert.throws(()=>c.saveData(other,'live',{...d.lives[0],title:'変更'}));
c.saveData(key,'deleteTicket',{...d.tickets[0]});assert.equal(c.getData(key).tickets.length,4);
// Upgrade an old sheet, preserving data and adding only the two new columns.
tables.Lives.r=tables.Lives.r.map(r=>r.slice(0,8));
const legacy=JSON.stringify(tables.Lives.r[1]);c.migrateLives_();c.migrateLives_();
assert.equal(JSON.stringify(tables.Lives.r[1]),legacy);
assert.equal(tables.Lives.r[0][8],'抽選締切');
let live=c.getData(key).lives[0];assert.equal(live.requiredThrows,'');
live=c.saveData(key,'live',{...live,lotteryDeadline:'2026-09-25',requiredThrows:'30'}).lives[0];
assert.equal(live.lotteryDeadline,'2026-09-25');assert.equal(live.requiredThrows,'30');
for(const bad of ['-1','1.5','NaN','Infinity']) assert.throws(()=>c.saveData(key,'live',{...live,requiredThrows:bad}));
assert.throws(()=>c.saveData(key,'live',{...live,lotteryDeadline:'2026-02-30'}));
live=c.saveData(key,'live',{...live,requiredThrows:'0'}).lives[0];assert.equal(live.requiredThrows,'0');
live=c.saveData(key,'live',{...live,lotteryDeadline:'',requiredThrows:''}).lives[0];
assert.equal(live.lotteryDeadline,'');assert.equal(live.requiredThrows,'');
console.log('PASS: deadline and throw target save, validation, clearing, zero, legacy migration');
assert.equal(tables.Lives.r[0][10],'チケット購入URL');
live=c.saveData(key,'live',{...live,purchaseUrl:'https://example.com/tickets?id=12&event=3'}).lives[0];
assert.equal(live.purchaseUrl,'https://example.com/tickets?id=12&event=3');
for(const purchaseUrl of ['javascript:alert(1)','https://','data:text/html,test']) assert.throws(()=>c.saveData(key,'live',{...live,purchaseUrl}));
live=c.saveData(key,'live',{...live,purchaseUrl:''}).lives[0];assert.equal(live.purchaseUrl,'');
console.log('PASS: purchase URL persistence, validation, clearing, migration');
live=c.saveData(key,'live',{...live,groups:['グループA','グループB','グループA']}).lives[0];
assert.equal(live.groups.join(','),'グループA,グループB');
assert.equal(c.getData(other).groups.join(','),'グループA,グループB');
assert.throws(()=>c.saveData(key,'live',{...live,groups:Array(21).fill('グループ')}));
assert.throws(()=>c.saveData(key,'live',{...live,groups:['']}));
assert.throws(()=>c.saveData(key,'live',{...live,groups:['bad,name']}));
live=c.saveData(key,'live',{...live,groups:['グループB']}).lives[0];
assert.equal(live.groups.join(','),'グループB');
live=c.saveData(key,'live',{...live,groups:[]}).lives[0];assert.equal(live.groups.length,0);
console.log('PASS: reusable group tags, deduplication, validation, deselection and clearing');
tables.Members.r[1][3]='no';assert.throws(()=>c.getData(key));
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
assert.equal(tables.Lives.r[0][1],'イベント名');
assert.equal(tables.Members.r[0][1],'名前');
assert.equal(tables.Lives.r[1][0],existingId);
assert.equal(JSON.stringify(tables.Tickets.r),oldTickets);
const imported=c.getData(other).lives.find(l=>l.title==='まとめ登録');
assert.ok(imported.id);assert.equal(imported.version,'1');
assert.ok(c.getMembers().find(m=>m.name==='新しいメンバー').id);
assert.equal(tables.Lives.r[3][0],undefined);
c.ensureReady_();assert.equal(c.getData(other).lives.find(l=>l.title==='まとめ登録').id,imported.id);
c.saveData(other,'live',{...imported,title:'まとめ登録を編集'});
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
const nativeRow=tables.Lives.r.length;
tables.Lives.appendRow(['','日付セル','']);tables.Lives.r[nativeRow][2]=new Date('2026-09-20T15:00:00Z');
c.ensureReady_();
assert.equal(tables.Lives.r.find(r=>r[1]==='日付セル')[2],'2026-09-21');
assert.ok(!tables.Lives.r.some(r=>['昨日','一昨日'].includes(r[1])));
assert.equal(tables.Lives.r.find(r=>r[1]==='今日')[2],'2026-09-19');
assert.ok(tables.Lives.r.find(r=>r[1]==='明日')[0]);
assert.equal(tables.Lives.r.find(r=>r[1]==='明日')[8],'2026-08-24');
assert.ok(tables.Lives.r.some(r=>r[1]==='不正')); // invalid dates never authorize deletion
assert.ok(!c.getData(other).lives.some(l=>l.title==='不正'));
now='2026-09-19T14:59:59Z';c.dailyCleanup();assert.ok(tables.Lives.r.some(r=>r[1]==='今日'));
now='2026-09-19T15:00:00Z';c.dailyCleanup();assert.ok(!tables.Lives.r.some(r=>r[1]==='今日'));assert.ok(tables.Lives.r.some(r=>r[1]==='明日'));
assert.equal(JSON.stringify(tables.Members.r),recordsBefore.members);
assert.equal(JSON.stringify(tables.Tickets.r),recordsBefore.tickets);
assert.equal(JSON.stringify(tables.Attendance.r),recordsBefore.attendance);
const tomorrowId=tables.Lives.r.find(r=>r[1]==='明日')[0];
c.dailyCleanup();assert.equal(tables.Lives.r.find(r=>r[1]==='明日')[0],tomorrowId);
assert.throws(()=>c.saveData(other,'live',{title:'終了済み',date:'9/19'}),/終了済み/);
now='2026-12-31T14:00:00Z';tables.Lives.appendRow(['','大晦日','12/31']);c.dailyCleanup();
assert.equal(tables.Lives.r.find(r=>r[1]==='大晦日')[2],'2026-12-31');
now='2026-12-31T15:00:00Z';c.dailyCleanup();assert.ok(!tables.Lives.r.some(r=>r[1]==='大晦日'));
assert.ok(tables.Lives.r.some(r=>r[1]==='未来'));
c.installDailyCleanup();c.installDailyCleanup();
assert.equal(triggers.length,1);assert.deepEqual(triggerOptions,{hour:0,days:1,zone:'Asia/Tokyo'});
console.log('PASS: short/full/native dates, invalid and leap dates, IDs, JST midnight and year rollover, expired rows only, trigger deduplication');

const third=c.registerMember('Charlie');
let editable=c.saveData(other,'live',{title:'編集対象',date:'2027-02-01'}).lives.find(l=>l.title==='編集対象');
assert.throws(()=>c.saveData(third.id,'live',{...editable,title:'別人'}),/登録者/);
tables.Lives.r.find(r=>r[0]===editable.id)[6]='copied-invalid-owner';
editable=c.getData(other).lives.find(l=>l.id===editable.id);
const edited=c.saveData(other,'live',{...editable,title:'編集できた'}).lives.find(l=>l.id===editable.id);
assert.equal(edited.title,'編集できた');assert.equal(edited.owner,other);
assert.throws(()=>c.saveData(other,'live',{...editable,title:'古い画面'}),/他の更新/);
tables.Lives.appendRow(['','所有者空欄','2027-03-01']);
const unowned=c.getData(other).lives.find(l=>l.title==='所有者空欄');
assert.equal(c.saveData(other,'live',{...unowned,title:'空欄から編集'}).lives.find(l=>l.id===unowned.id).owner,other);
io.opens=0;io.ranges=0;c.getData(other);
assert.equal(io.opens,1);assert.equal(io.ranges,4);
// A new request must see direct spreadsheet edits, not an earlier cached snapshot.
tables.Lives.r.find(r=>r[0]===editable.id)[1]='スプシ変更';
assert.equal(c.getData(other).lives.find(l=>l.id===editable.id).title,'スプシ変更');
console.log('PASS: imported event edit/claim, valid owner guard, stale edit guard, one workbook open/four table reads, fresh reload');

// Exercise the exact frontend merge with real backend receipts for every mutation.
const frontScript=fs.readFileSync(__dirname+'/../docs/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const front=vm.createContext({sessionStorage:{removeItem(){}},localStorage:{getItem:()=>''}});
vm.runInContext(frontScript.slice(0,frontScript.indexOf('function showSetup()')),front);
let local=c.getData(other);
const compact={response:'patch-v1'};
function fast(action,payload){
  const result=c.saveData(other,action,payload,compact);
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
const full=c.getData(other);
for(const field of ['lives','tickets','attendance','groups'])assert.equal(JSON.stringify(local[field]),JSON.stringify(full[field]),field);
assert.equal(front.applySaveResult(local,full),full); // Old GAS compatibility.
// Saving must not run import/date/cleanup maintenance on unrelated event rows.
tables.Lives.appendRow(['','保存時には削除しない','2026-12-30']);
fast('live',{...local.lives.find(l=>l.id===id),title:'個別保存'});
assert.ok(tables.Lives.r.some(r=>r[1]==='保存時には削除しない'));
c.getData(other);assert.ok(!tables.Lives.r.some(r=>r[1]==='保存時には削除しない'));
console.log('PASS: compact save receipt/real UI merge for all actions, old GAS compatibility, no maintenance during saves, edit reads 2 tables/0 raw values/1 lock/1 flush');
// Mixed statuses are validated as a batch before the single sheet write.
const mixed=[{number:'Ｍ101',status:'自分用'},{number:'M102',status:'余り'},{number:'M103',status:'取引中'},{number:'M104',status:'捌けた'},{number:'ignored',status:'未発券'}];
let mixedResult=c.saveData(other,'addTickets',{liveId:id,entries:mixed},compact);
assert.equal(mixedResult.changes.Tickets.upsert.map(t=>t.status).join(','),'自分用,余り,取引中,捌けた,未発券');
assert.equal(mixedResult.changes.Tickets.upsert[0].number,'M101');
assert.equal(mixedResult.changes.Tickets.upsert[4].number,'');
for(const entries of [[],Array(51).fill({number:'',status:'未発券'}),[{number:'M201',status:'余り'},{number:'',status:'捌けた'}],[{number:'M201',status:'余り'},{number:'M101',status:'自分用'}],[{number:'X1',status:'余り'},{number:'ｘ１',status:'取引中'}],[{number:'M201',status:'不正'}],[null]]){
  const before=JSON.stringify(tables.Tickets.r);
  assert.throws(()=>c.saveData(other,'addTickets',{liveId:id,entries},compact));
  assert.equal(JSON.stringify(tables.Tickets.r),before);
}
const beforePending=tables.Tickets.r.length;
c.saveData(other,'addTickets',{liveId:id,entries:Array(50).fill({number:'',status:'未発券'})},compact);
assert.equal(tables.Tickets.r.length,beforePending+50);
console.log('PASS: per-ticket mixed status batch, normalization, 50 pending tickets, no partial write for invalid/duplicate batch');
