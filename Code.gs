const TABLES = {
  Lives: ['id','title','date','venue','sheetUrl','memo','owner','version','lotteryDeadline','requiredThrows','purchaseUrl','groups'],
  Members: ['id','name','tokenHash','active'],
  Attendance: ['id','liveId','memberId','status','version'],
  Tickets: ['id','liveId','memberId','number','status','recipient','memo','version'],
};
// Column positions and internal keys remain stable; only sheet labels are translated.
const HEADERS_JA = {
  Lives: ['イベントID（自動）','イベント名','開催日','会場','関連スプシURL','メモ','登録者ID','更新番号（自動）','抽選締切','必要投げ数（1人あたり）','チケット購入URL','出演グループ'],
  Members: ['メンバーID（自動）','名前','旧認証情報（使用しません）','利用状態（yes / no）'],
  Attendance: ['参戦予定ID','イベントID','メンバーID','参戦状況','更新番号'],
  Tickets: ['チケットID','イベントID','メンバーID','整理番号','チケット状況','譲り先','メモ','更新番号'],
};
function doGet(e) {
  ensureReady_();
  const channel=e?.parameter?.channel||'';
  if(channel && !/^[a-f0-9-]{36}$/.test(channel)) throw new Error('接続パラメータが無効です');
  const template=HtmlService.createTemplateFromFile('Bridge');
  template.channel=channel;
  template.parentOrigin='https://m0ch4771.github.io';
  return template.evaluate().setTitle('Ticket Management データ接続').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
// Initial setup runs automatically when the web app is first opened.
function setup_() {
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const p=PropertiesService.getScriptProperties();
    if(p.getProperty('SHEET_ID')) return;
    const ss=SpreadsheetApp.create('Ticket Management 管理');
    Object.keys(TABLES).forEach(name=>{
      const s=ss.insertSheet(name);
      s.getRange(1,1,s.getMaxRows(),TABLES[name].length).setNumberFormat('@');
      s.appendRow(HEADERS_JA[name]); s.setFrozenRows(1);
      s.getRange(1,1,1,TABLES[name].length).setFontWeight('bold').setBackground('#dde8ff');
    });
    p.setProperty('SHEET_ID',ss.getId());
    p.setProperty('SCHEMA_VERSION','japanese-headers-v3');
    console.log('管理スプレッドシート: '+ss.getUrl());
  } finally { lock.releaseLock(); }
}
function ensureReady_() {
  const p=PropertiesService.getScriptProperties();
  if(!p.getProperty('SHEET_ID')) setup_();
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    if(p.getProperty('SCHEMA_VERSION')!=='japanese-headers-v3') {
      // Validate every table before changing any header. Preserve all existing rows.
      Object.keys(TABLES).forEach(name=>{
        const headers=sheet_(name).getDataRange().getDisplayValues()[0]||[];
        TABLES[name].forEach((key,i)=>{
          if(headers[i]!==key && headers[i]!==HEADERS_JA[name][i] && !(name==='Lives' && i>=8 && !headers[i]))
            throw new Error(name+'の列の順番を確認してください');
        });
      });
      Object.keys(TABLES).forEach(name=>sheet_(name).getRange(1,1,1,TABLES[name].length).setValues([HEADERS_JA[name]]).setFontWeight('bold').setBackground('#dde8ff'));
      p.setProperty('SCHEMA_VERSION','japanese-headers-v3');
    }
    normalizeSheetDates_();
    fillSheetIds_();
    deletePastEvents_();
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}
// Dates without a year use the current Japan calendar year, then persist it.
// Never infer a future year just because the month/day is already in the past.
function japanToday_() { return Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd'); }
function normalizeDate_(value,year,timezone) {
  if(Object.prototype.toString.call(value)==='[object Date]') {
    return Number.isFinite(value.getTime())?Utilities.formatDate(value,timezone||'Asia/Tokyo','yyyy-MM-dd'):'';
  }
  const s=String(value??'').normalize('NFKC').trim();
  const full=s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  const short=s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if(!full&&!short) return '';
  const y=full?Number(full[1]):Number(year),m=Number(full?full[2]:short[1]),d=Number(full?full[3]:short[2]);
  if(!Number.isInteger(y)||y<1000||y>9999||m<1||m>12||d<1||d>31) return '';
  const date=new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?date.toISOString().slice(0,10):'';
}
function normalizeSheetDates_() {
  const s=sheet_('Lives'),range=s.getDataRange(),raw=range.getValues();
  const timezone=s.getParent().getSpreadsheetTimeZone(),year=Number(japanToday_().slice(0,4));
  for(let i=1;i<raw.length;i++) {
    const row=raw[i];
    if(!String(row[1]||'').trim()) continue;
    const eventDate=normalizeDate_(row[2],year,timezone);
    // For January events, a yearless December deadline belongs to the preceding year.
    const deadlineYear=eventDate?Number(eventDate.slice(0,4)):year;
    let deadline=normalizeDate_(row[8],deadlineYear,timezone);
    if(/^\d{1,2}\/\d{1,2}$/.test(String(row[8]||'').normalize('NFKC').trim()) && eventDate && deadline>eventDate)
      deadline=normalizeDate_(row[8],deadlineYear-1,timezone);
    [[2,eventDate],[8,deadline]].forEach(([col,date])=>{
      if(date && row[col]!==date) s.getRange(i+1,col+1,1,1).setNumberFormat('@').setValues([[date]]);
    });
  }
}
function deletePastEvents_() {
  const s=sheet_('Lives'),rows=s.getDataRange().getDisplayValues(),today=japanToday_();
  // Delete bottom-up so blank rows, adjacent events and references cannot shift targets.
  // Only event rows are deleted. Member, attendance and ticket records are retained.
  for(let i=rows.length-1;i>=1;i--) {
    const row=rows[i],date=normalizeDate_(row[2],Number(today.slice(0,4)));
    if(String(row[1]||'').trim() && date && date<today) s.deleteRow(i+1);
  }
}
// Run once in the Apps Script editor to authorize and enable unattended cleanup.
function installDailyCleanup() {
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='dailyCleanup'))
      ScriptApp.newTrigger('dailyCleanup').timeBased().atHour(0).everyDays(1).inTimezone('Asia/Tokyo').create();
  } finally { lock.releaseLock(); }
  dailyCleanup();
}
function dailyCleanup() { ensureReady_(); }
// Direct sheet entry: assign primary IDs only to complete event/name rows.
// Foreign keys (event/member/owner references) are never guessed or overwritten.
function fillSheetIds_() {
  ['Members','Lives'].forEach(name=>{
    const s=sheet_(name), rows=s.getDataRange().getDisplayValues().slice(1);
    const seen=new Set();
    rows.forEach(r=>{if(r[0]) {if(seen.has(r[0])) throw new Error(name+'のIDが重複しています。コピーして追加した行のIDを空欄にしてください'); seen.add(r[0]);}});
    rows.forEach((r,i)=>{
      if(!r[1]?.trim() || (name==='Lives' && !normalizeDate_(r[2],Number(japanToday_().slice(0,4))))) return;
      if(!r[0]) {
        let id; do {id=Utilities.getUuid();} while(seen.has(id)); seen.add(id);
        s.getRange(i+2,1,1,1).setValues([[id]]);
      }
      const col=name==='Members'?4:8;
      if(!r[col-1]) s.getRange(i+2,col,1,1).setValues([[name==='Members'?'yes':'1']]);
    });
  });
}
function getMembers() {
  ensureReady_();
  return rows_('Members').filter(m=>m.active==='yes').map(m=>({id:m.id,name:m.name})).sort((a,b)=>a.name.localeCompare(b.name,'ja'));
}
function normalizedName_(name) { return String(name).normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase(); }
function registerMember(name) {
  ensureReady_();
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const displayName=text_(name,40,true).normalize('NFKC').replace(/\s+/g,' ');
    if(rows_('Members').some(m=>normalizedName_(m.name)===normalizedName_(displayName))) throw new Error('その名前は登録済みです。一覧から選ぶか、区別できる名前にしてください');
    const member={id:Utilities.getUuid(),name:displayName,tokenHash:'',active:'yes'};
    write_('Members',member,null); SpreadsheetApp.flush();
    return {id:member.id,name:member.name};
  } finally { lock.releaseLock(); }
}
function sheet_(name) { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')).getSheetByName(name); }
function rows_(name) { return sheet_(name).getDataRange().getDisplayValues().slice(1).map(r => Object.fromEntries(TABLES[name].map((k,i)=>[k,r[i]??'']))); }
// A selected name is a convenience label, not authentication.
// Anyone with the app URL can select any active member.
function selectedMember_(memberId) {
  if(typeof memberId!=='string') throw new Error('名前を選び直してください');
  const me=rows_('Members').find(m=>m.active==='yes'&&m.id===memberId);
  if(!me) throw new Error('名前を選び直してください');
  return me;
}
function readGroups_(value) {
  if(Array.isArray(value)) return value;
  try { const parsed=JSON.parse(value||'[]'); return Array.isArray(parsed)?parsed.filter(x=>typeof x==='string'):[]; } catch(e) { return []; }
}
function validateGroups_(value) {
  if(!Array.isArray(value)||value.length>20) throw new Error('出演グループは20組まで選択できます');
  const names=value.map(v=>text_(v,40,true).normalize('NFKC').replace(/\s+/g,' '));
  if(names.some(n=>/[,、\n\r]/.test(n))) throw new Error('グループ名にカンマ・改行は使えません');
  return [...new Map(names.map(n=>[n.toLowerCase(),n])).values()];
}
function snapshot_(me) {
  const lives=rows_('Lives').filter(l=>l.id&&l.title&&normalizeDate_(l.date,Number(japanToday_().slice(0,4)))).map(l=>({...l,groups:readGroups_(l.groups)}));
  const groups=[...new Set(lives.flatMap(l=>l.groups))].sort((a,b)=>a.localeCompare(b,'ja'));
  return {me:{id:me.id,name:me.name},members:rows_('Members').filter(x=>x.active==='yes').map(x=>({id:x.id,name:x.name})),lives,groups,attendance:rows_('Attendance'),tickets:rows_('Tickets'),updatedAt:new Date().toISOString()};
}
function getData(memberId) { ensureReady_(); return snapshot_(selectedMember_(memberId)); }
function text_(value,max,required) { const s=String(value==null?'':value).trim(); if ((required&&!s)||s.length>max) throw new Error('入力内容・文字数を確認してください'); return s; }
function deadline_(value) {
  const s=text_(value,10,false);
  if(s && (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0,10)!==s)) throw new Error('抽選締切日を確認してください');
  return s;
}
function purchaseUrl_(value) {
  const s=text_(value,2000,false);
  if(s && !/^https?:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?(?:[/?#][^\s<>]*)?$/.test(s)) throw new Error('チケット購入ページURLはhttpまたはhttpsのURLで入力してください');
  return s;
}
function throws_(value) {
  const s=text_(value,16,false);
  if(s==='') return '';
  if(!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) throw new Error('必要投げ数は0以上の整数で入力してください');
  return String(Number(s));
}
// Existing installations only: run once from the editor before deploying this version.
function migrateLives_() {
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const s=sheet_('Lives'); const headers=s.getDataRange().getDisplayValues()[0];
    TABLES.Lives.slice(0,8).forEach((h,i)=>{if(headers[i]!==h && headers[i]!==HEADERS_JA.Lives[i]) throw new Error('Livesの列構成を確認してください');});
    TABLES.Lives.slice(8).forEach((h,i)=>{if(headers[i+8] && headers[i+8]!==h && headers[i+8]!==HEADERS_JA.Lives[i+8]) throw new Error('追加先の列に既存データがあります');});
    s.getRange(1,9,s.getMaxRows(),TABLES.Lives.length-8).setNumberFormat('@');
    s.getRange(1,9,1,TABLES.Lives.length-8).setValues([HEADERS_JA.Lives.slice(8)]).setFontWeight('bold').setBackground('#dde8ff');
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}
function enum_(value,values) { if (!values.includes(value)) throw new Error('選択値が無効です'); return value; }
function safe_(v) { const s=String(v); return /^[=+\-@]/.test(s)?"'"+s:s; }
function write_(table,row,old) {
  const s=sheet_(table); const vals=TABLES[table].map(k=>safe_(row[k]??''));
  if (!old) s.appendRow(vals);
  else { const index=rows_(table).findIndex(x=>x.id===old.id); if(index<0) throw new Error('データが見つかりません'); s.getRange(index+2,1,1,vals.length).setValues([vals]); }
}
function saveData(memberId,action,payload) {
  ensureReady_();
  const lock=LockService.getScriptLock(); if(!lock.tryLock(10000)) throw new Error('更新が混み合っています。少し待って再度保存してください');
  try {
    const me=selectedMember_(memberId); const p=payload||{};
    if (action==='live') {
      const old=p.id?rows_('Lives').find(x=>x.id===p.id):null;
      if(p.id&&!old) throw new Error('ライブが見つかりません');
      if(old && old.owner!==me.id) throw new Error('ライブの編集は登録者のみ可能です');
      if(old && String(p.version)!==old.version) throw new Error('他の更新がありました。再読込してください');
      const date=normalizeDate_(p.date,Number(japanToday_().slice(0,4))); if(!date) throw new Error('日付を確認してください');
      if(date<japanToday_()) throw new Error('終了済みのイベントは登録できません');
      const url=text_(p.sheetUrl,600,false); if(url&&!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+(?:[/?#].*)?$/.test(url)) throw new Error('スプレッドシートURLを確認してください');
      write_('Lives',{id:old?old.id:Utilities.getUuid(),title:text_(p.title,120,true),date,groups:JSON.stringify(validateGroups_(p.groups===undefined?readGroups_(old?.groups):p.groups)),purchaseUrl:purchaseUrl_(p.purchaseUrl===undefined?old?.purchaseUrl:p.purchaseUrl),lotteryDeadline:deadline_(p.lotteryDeadline===undefined?old?.lotteryDeadline:p.lotteryDeadline),requiredThrows:throws_(p.requiredThrows===undefined?old?.requiredThrows:p.requiredThrows),venue:text_(p.venue,120,false),sheetUrl:url,memo:text_(p.memo,500,false),owner:me.id,version:old?Number(old.version)+1:1},old);
    } else {
      if(!rows_('Lives').some(x=>x.id===p.liveId)) throw new Error('ライブが見つかりません');
      if(action==='attendance') {
        const old=rows_('Attendance').find(x=>x.liveId===p.liveId&&x.memberId===me.id);
        if(old && String(p.version)!==old.version) throw new Error('他の更新がありました。再読込してください');
        write_('Attendance',{id:old?old.id:Utilities.getUuid(),liveId:p.liveId,memberId:me.id,status:enum_(p.status,['参戦','未定','不参加']),version:old?Number(old.version)+1:1},old);
      } else if(action==='addTickets') {
        if(!Array.isArray(p.numbers)||p.numbers.length<1||p.numbers.length>50) throw new Error('1回に1〜50枚まで登録できます');
        const status=enum_(p.status,['未発券','自分用','余り']);
        const nums=p.numbers.map(n=>text_(n,30,status!=='未発券'));
        const existing=rows_('Tickets').filter(t=>t.liveId===p.liveId).map(t=>t.number.toUpperCase());
        const named=nums.filter(Boolean).map(x=>x.toUpperCase());
        if(new Set(named).size!==named.length||named.some(n=>existing.includes(n))) throw new Error('このライブに同じ整理番号が登録されています。券種が異なる場合は「VIP-A12」などにしてください');
        const values=nums.map(number=>[Utilities.getUuid(),p.liveId,me.id,number,status,'','',1].map(safe_));
        const s=sheet_('Tickets');s.getRange(s.getLastRow()+1,1,values.length,TABLES.Tickets.length).setValues(values);
      } else if(action==='ticket' || action==='deleteTicket') {
        const old=rows_('Tickets').find(t=>t.id===p.id&&t.liveId===p.liveId);
        if(!old||old.memberId!==me.id) throw new Error('選択中の名前のチケットのみ編集できます');
        if(String(p.version)!==old.version) throw new Error('他の更新がありました。再読込してください');
        if(action==='deleteTicket') { sheet_('Tickets').deleteRow(rows_('Tickets').findIndex(t=>t.id===old.id)+2); }
        else {
          const status=enum_(p.status,['未発券','自分用','余り','取引中','捌けた']);
          const number=text_(p.number,30,status!=='未発券');
          if(number&&rows_('Tickets').some(t=>t.liveId===old.liveId&&t.id!==old.id&&t.number.toUpperCase()===number.toUpperCase())) throw new Error('同じ整理番号が登録されています');
          write_('Tickets',{...old,number,status,recipient:text_(p.recipient,80,false),memo:text_(p.memo,500,false),version:Number(old.version)+1},old);
        }
      } else throw new Error('操作が無効です');
    }
    SpreadsheetApp.flush(); return snapshot_(me);
  } finally { lock.releaseLock(); }
}
