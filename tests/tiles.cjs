const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const script=fs.readFileSync(__dirname+'/../docs/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const c=vm.createContext({sessionStorage:{removeItem(){}},localStorage:{getItem:()=>''}});vm.runInContext(script.slice(0,script.indexOf('function updateDay()')),c);
assert.equal(c.japanDay(new Date('2026-09-19T14:59:59Z')),'2026-09-19');
assert.equal(c.japanDay(new Date('2026-09-19T15:00:00Z')),'2026-09-20');
assert.equal(c.nextDay('2026-12-31'),'2027-01-01');
const event=(id,date,lotteryDeadline)=>({id,title:id,date,lotteryDeadline,venue:'会場',requiredThrows:'5',purchaseUrl:'https://example.com/tickets',sheetUrl:'https://docs.google.com/spreadsheets/d/example/edit'});
const events=[event('future','2026-10-03','2026-09-25'),event('tomorrow','2026-10-02','2026-09-20'),event('today-cutoff','2026-10-04','2026-09-19'),event('past','2026-09-01','2026-08-20'),event('today-show','2026-09-19','2026-09-19'),event('earlier','2026-10-01','2026-09-25')];
assert.equal(c.sortedEvents(events,'2026-09-19').map(e=>e.id).join(','),'today-show,today-cutoff,tomorrow,past,earlier,future');
const l=events[2],tickets=['余り','余り','取引中','自分用','捌けた','未発券'].map(status=>({liveId:l.id,status}));tickets.push({liveId:'another',status:'余り'});
for(const day of ['2026-09-18','2026-09-19']){const html=c.eventTile(l,tickets,day);assert.ok(html.includes('チケットURL'));assert.ok(html.includes('必要投げ数（1人あたり）'));assert.ok(!html.includes('全体あまり数'));assert.ok(!html.includes('関連スプシURL'))}
const after=c.eventTile(l,tickets,'2026-09-20');assert.ok(after.includes('全体あまり数</dt><dd>2枚'));assert.ok(after.includes('関連スプシURL'));assert.ok(!after.includes('チケットURL'));assert.ok(!after.includes('必要投げ数'));
assert.ok(c.eventTile({...l,lotteryDeadline:''},[],'2026-09-20').includes('抽選締切</dt><dd>未設定'));
assert.ok(!c.safeLink('javascript:alert(1)','チケットURL').includes('href='));
assert.ok(c.eventTile({...l,title:'<script>bad</script>'},[],'2026-09-19').includes('&lt;script&gt;'));
assert.ok(c.eventTile({...l,groups:['グループA','<script>']},[],'2026-09-19').includes('グループA'));
assert.ok(c.eventTile({...l,groups:['<script>']},[],'2026-09-19').includes('&lt;script&gt;'));
console.log('PASS: priority ordering, Japan midnight, year rollover, cutoff day/next day tile content, remaining count, unset cutoff, safe links and escaping');
