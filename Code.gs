const TABLES = {
  Lives: ['id','title','date','venue','sheetUrl','memo','owner','version','lotteryDeadline','requiredThrows','purchaseUrl','groups'],
  Members: ['id','name','tokenHash','active','email','role'],
  Attendance: ['id','liveId','memberId','status','version','applied'],
  Tickets: ['id','liveId','memberId','number','status','recipient','memo','version','ticketUrl'],
};
// Column positions and internal keys remain stable; only sheet labels are translated.
const HEADERS_JA = {
  Lives: ['イベントID（自動）','イベント名','開催日','会場','関連スプシURL','メモ','登録者ID','更新番号（自動）','抽選締切','必要投げ数（1人あたり）','チケット購入URL','出演グループ'],
  Members: ['メンバーID（自動）','名前','旧認証情報（使用しません）','利用状態（yes / no）','Googleアカウント','権限（admin / member）'],
  Attendance: ['参戦予定ID','イベントID','メンバーID','参戦状況','更新番号','申込状況'],
  Tickets: ['チケットID','イベントID','メンバーID','整理番号','チケット状況','譲り先','メモ','更新番号','本人用チケットURL'],
};
function doGet(e) {
  // Connect immediately; initialization and maintenance happen in the data request.
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
    p.setProperty('SCHEMA_VERSION','japanese-headers-v5');
    console.log('管理スプレッドシート: '+ss.getUrl());
  } finally { lock.releaseLock(); }
}
function ensureReady_(maintenance=true) {
  resetRequest_();
  const p=PropertiesService.getScriptProperties();
  if(!p.getProperty('SHEET_ID')) setup_();
  if(!maintenance && p.getProperty('SCHEMA_VERSION')==='japanese-headers-v5') return;
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    if(p.getProperty('SCHEMA_VERSION')!=='japanese-headers-v5') {
      // Validate every table before changing any header. Preserve all existing rows.
      Object.keys(TABLES).forEach(name=>{
        const headers=sheet_(name).getDataRange().getDisplayValues()[0]||[];
        TABLES[name].forEach((key,i)=>{
          const additiveColumn=(name==='Members'&&i>=4)||(name==='Attendance'&&i>=5);
          if(headers[i]!==key && headers[i]!==HEADERS_JA[name][i] && !((name==='Lives' && i>=8 || name==='Tickets' && i===8) && !headers[i]) && !(additiveColumn&&!headers[i]))
            throw new Error(name+'の列の順番を確認してください');
        });
      });
      Object.keys(TABLES).forEach(name=>sheet_(name).getRange(1,1,1,TABLES[name].length).setValues([HEADERS_JA[name]]).setFontWeight('bold').setBackground('#dde8ff'));
      p.setProperty('SCHEMA_VERSION','japanese-headers-v5');
    }
    if(maintenance) {normalizeSheetDates_();fillSheetIds_();deletePastEvents_();}
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
  const s=sheet_('Lives'),raw=readTable_('Lives',true).raw;
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
      if(date && row[col]!==date) {s.getRange(i+1,col+1,1,1).setNumberFormat('@').setValues([[date]]);invalidate_('Lives');}
    });
  }
}
function deletePastEvents_() {
  const s=sheet_('Lives'),rows=readTable_('Lives').display,today=japanToday_();
  // Delete bottom-up so blank rows, adjacent events and references cannot shift targets.
  // Only event rows are deleted. Member, attendance and ticket records are retained.
  for(let i=rows.length-1;i>=1;i--) {
    const row=rows[i],date=normalizeDate_(row[2],Number(today.slice(0,4)));
    if(String(row[1]||'').trim() && date && date<today) {s.deleteRow(i+1);invalidate_('Lives');}
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
    const s=sheet_(name), rows=readTable_(name).display.slice(1);
    const seen=new Set();
    rows.forEach(r=>{if(r[0]) {if(seen.has(r[0])) throw new Error(name+'のIDが重複しています。コピーして追加した行のIDを空欄にしてください'); seen.add(r[0]);}});
    rows.forEach((r,i)=>{
      if(!r[1]?.trim() || (name==='Lives' && !normalizeDate_(r[2],Number(japanToday_().slice(0,4))))) return;
      if(!r[0]) {
        let id; do {id=Utilities.getUuid();} while(seen.has(id)); seen.add(id);
        s.getRange(i+2,1,1,1).setValues([[id]]);invalidate_(name);
      }
      const col=name==='Members'?4:8;
      if(!r[col-1]) {s.getRange(i+2,col,1,1).setValues([[name==='Members'?'yes':'1']]);invalidate_(name);}
    });
  });
}
function getMembers(idToken) {
  ensureReady_();
  const me=authenticatedMember_(idToken);
  return [{id:me.id,name:me.name}];
}
function normalizedName_(name) { return String(name).normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase(); }
function registerMember(idToken,name,email) {
  ensureReady_(false);
  const actor=authenticatedMember_(idToken);
  if(actor.role!=='admin')throw new Error('メンバー登録は管理者のみ実行できます');
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    requestTables={};
    const displayName=text_(name,40,true).normalize('NFKC').replace(/\s+/g,' ');
    const normalizedEmail=normalizeEmail_(email);
    if(!normalizedEmail)throw new Error('Googleアカウントのメールアドレスを入力してください');
    if(rows_('Members').some(m=>m.active==='yes'&&(normalizedName_(m.name)===normalizedName_(displayName)||normalizeEmail_(m.email)===normalizedEmail))) throw new Error('名前またはGoogleアカウントは登録済みです');
    const member={id:Utilities.getUuid(),name:displayName,tokenHash:'',active:'yes',email:normalizedEmail,role:'member'};
    write_('Members',member,null); SpreadsheetApp.flush();
    return {id:member.id,name:member.name};
  } finally { lock.releaseLock(); }
}
// Request-local reuse only: a manual reload always reads the current spreadsheet.
let requestBook=null,requestSheets={},requestTables={},requestChanges={};
function resetRequest_() { requestReceipt=null;requestBook=null;requestSheets={};requestTables={};requestChanges={}; }
function sheet_(name) {
  if(!requestBook) requestBook=SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  return requestSheets[name]||(requestSheets[name]=requestBook.getSheetByName(name));
}
function invalidate_(name) { delete requestTables[name]; }
function readTable_(name,includeRaw=false) {
  if(!requestTables[name]) {
    const range=sheet_(name).getDataRange();
    requestTables[name]={display:range.getDisplayValues(),range,raw:null};
  }
  if(includeRaw && !requestTables[name].raw) requestTables[name].raw=requestTables[name].range.getValues();
  return requestTables[name];
}
function rows_(name) { return readTable_(name).display.slice(1).map(r => Object.fromEntries(TABLES[name].map((k,i)=>[k,r[i]??'']))); }
function canEditLive_(live,me) {
  return !!me && me.active==='yes' && (me.role==='admin' || live.owner===me.id);
}
// A selected name is a convenience label, not authentication.
// Anyone with the app URL can select any active member.
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
  const attendance=rows_('Attendance').map(a=>a.status==='不参加'?{...a,applied:'申込不要'}:a);
  return {me:{id:me.id,name:me.name,isAdmin:me.role==='admin'},members:rows_('Members').filter(x=>x.active==='yes').map(x=>({id:x.id,name:x.name})),lives,groups,attendance,tickets:rows_('Tickets'),capabilities:{durableSave:true},updatedAt:new Date().toISOString()};
}
function firebaseAuthConfig_() {
  try {
    const p=PropertiesService.getScriptProperties();
    const raw=JSON.parse(p.getProperty('FIREBASE_AUTH_CONFIG')||p.getProperty('PUSH_FIREBASE_CONFIG')||'{}');
    if(!raw.apiKey||!raw.projectId||!raw.appId||!raw.messagingSenderId)return null;
    return {apiKey:raw.apiKey,projectId:raw.projectId,appId:raw.appId,messagingSenderId:raw.messagingSenderId,authDomain:raw.authDomain||raw.projectId+'.firebaseapp.com'};
  } catch(e) { return null; }
}
function getAuthConfig() {
  const firebase=firebaseAuthConfig_();
  return firebase?{ready:true,firebase}:{ready:false};
}
function normalizeEmail_(value) {
  const email=String(value||'').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?email:'';
}
function authenticatedMember_(idToken) {
  resetRequest_();
  if(typeof idToken!=='string'||idToken.length<100||idToken.length>5000)throw new Error('ログインの有効期限が切れました。再度ログインしてください');
  const cache=CacheService.getScriptCache();
  const cacheKey='auth-email-'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,idToken)).slice(0,40);
  let email=cache.get(cacheKey);
  if(!email) {
    const config=firebaseAuthConfig_();
    if(!config)throw new Error('Firebase Authenticationの設定が必要です');
    const response=UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+encodeURIComponent(config.apiKey),{
      method:'post',contentType:'application/json',muteHttpExceptions:true,payload:JSON.stringify({idToken})
    });
    if(response.getResponseCode()!==200)throw new Error('ログインを確認できません。再度ログインしてください');
    let result={};try{result=JSON.parse(response.getContentText())}catch(e){}
    const account=result.users?.[0];
    if(!account||account.disabled||!account.emailVerified)throw new Error('確認済みのGoogleアカウントでログインしてください');
    email=normalizeEmail_(account.email);
    if(!email)throw new Error('Googleアカウントのメールアドレスを取得できませんでした');
    cache.put(cacheKey,email,240);
  }
  const member=rows_('Members').find(m=>m.active==='yes'&&normalizeEmail_(m.email)===email);
  if(!member)throw new Error('このGoogleアカウントは未登録です。管理者にメンバー登録を依頼してください');
  return member;
}
function selectedMember_(memberId,idToken) {
  const me=authenticatedMember_(idToken);
  if(typeof memberId!=='string'||me.id!==memberId)throw new Error('このGoogleアカウントに登録されたメンバーではありません');
  return me;
}
function adminSettings_() {
  const p=PropertiesService.getScriptProperties();
  return {
    dayTime:p.getProperty('LINE_DAY_TIME')||'12:00',
    nightTime:p.getProperty('LINE_NIGHT_TIME')||'21:00',
    dayMode:p.getProperty('LINE_DAY_MODE')||'all',
    nightMode:p.getProperty('LINE_NIGHT_MODE')||'unconfirmed'
  };
}
function getAdminSettings(idToken) {
  const actor=authenticatedMember_(idToken);
  if(actor.role!=='admin')throw new Error('管理者のみ設定を確認できます');
  return adminSettings_();
}
function saveAdminSettings(idToken,settings) {
  const actor=authenticatedMember_(idToken);
  if(actor.role!=='admin')throw new Error('管理者のみ設定を変更できます');
  const s=settings||{},timeValue=value=>{
    const t=String(value||'');
    if(!/^([01]\d|2[0-3]):([0-5]\d)$/.test(t)||Number(t.slice(3))%5!==0)throw new Error('配信時刻は5分単位で設定してください');
    return t;
  };
  const dayTime=timeValue(s.dayTime),nightTime=timeValue(s.nightTime);
  const day=Number(dayTime.slice(0,2))*60+Number(dayTime.slice(3)),night=Number(nightTime.slice(0,2))*60+Number(nightTime.slice(3));
  if(day>=night||night-day<60)throw new Error('昼の配信時刻は夜より1時間以上前に設定してください');
  const mode=value=>{if(!['all','unconfirmed'].includes(value))throw new Error('通知内容を選択してください');return value};
  const p=PropertiesService.getScriptProperties();
  p.setProperties({LINE_DAY_TIME:dayTime,LINE_NIGHT_TIME:nightTime,LINE_DAY_MODE:mode(s.dayMode),LINE_NIGHT_MODE:mode(s.nightMode)});
  return adminSettings_();
}
function getData(idToken,memberId) { ensureReady_(); return snapshot_(selectedMember_(memberId,idToken)); }
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
    invalidate_('Lives');
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}
function enum_(value,values) { if (!values.includes(value)) throw new Error('選択値が無効です'); return value; }
function safe_(v) { const s=String(v); return /^[=+\-@]/.test(s)?"'"+s:s; }
function write_(table,row,old) {
  prepareSave_();
  const s=sheet_(table); const vals=TABLES[table].map(k=>safe_(row[k]??''));
  if (!old) s.appendRow(vals);
  else { const index=rows_(table).findIndex(x=>x.id===old.id); if(index<0) throw new Error('データが見つかりません'); s.getRange(index+2,1,1,vals.length).setValues([vals]); }
  invalidate_(table);
  recordChange_(table,row);
}
function recordChange_(table,row) {
  const normalized=Object.fromEntries(TABLES[table].map(k=>[k,String(row[k]??'')]));
  if(table==='Lives') normalized.groups=readGroups_(normalized.groups);
  if(!requestChanges[table]) requestChanges[table]={upsert:[],remove:[]};
  requestChanges[table].upsert.push(normalized);
}
// A durable receipt makes retrying a lost response safe. An interrupted write
// without a completion receipt is never automatically repeated.
let requestReceipt=null;
function receiptSheet_() {
  if(!requestBook) sheet_('Members');
  let s=requestBook.getSheetByName('SaveRequests');
  if(!s){s=requestBook.insertSheet('SaveRequests');s.appendRow(['リクエストID','メンバーID','操作','入力','状態','結果','日時']);}
  return s;
}
function prepareSave_() {
  if(!requestReceipt||requestReceipt.prepared)return;
  const r=requestReceipt;
  r.sheet.appendRow([r.id,r.member,r.action,r.payload,'pending','',new Date().toISOString()]);
  r.row=r.sheet.getLastRow();
  SpreadsheetApp.flush(); // Persist intent before changing user data.
  r.prepared=true;
}
function saveData(idToken,memberId,action,payload,options) {
  // Save only the requested change; bulk import/cleanup run on reload or daily trigger.
  requestReceipt=null;
  ensureReady_(false);
  const lock=LockService.getScriptLock(); if(!lock.tryLock(10000)) throw new Error('更新が混み合っています。少し待って再度保存してください');
  try {
    requestTables={}; // Discard reads made before this write lock.
    const me=selectedMember_(memberId,idToken); const p=payload||{};
    if(options?.requestId){
      const id=String(options.requestId);
      if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('保存リクエストが不正です');
      const sheet=receiptSheet_(),body=JSON.stringify(p);
      if(body.length>20000)throw new Error('一度に送信する内容が大きすぎます');
      const receipt=sheet.getDataRange().getDisplayValues().slice(1).find(row=>row[0]===id);
      if(receipt){
        if(receipt[1]!==me.id||receipt[2]!==action||receipt[3]!==body)throw new Error('保存リクエストが一致しません');
        if(receipt[4]==='done')return JSON.parse(receipt[5]);
        throw new Error('SAVE_UNCERTAIN: 前回の保存結果を確認する必要があります。再読込して登録内容を確認してください。');
      }
      requestReceipt={sheet,id,member:me.id,action,payload:body,prepared:false};
    }
    if (action==='live') {
      const old=p.id?rows_('Lives').find(x=>x.id===p.id):null;
      if(p.id&&!old) throw new Error('ライブが見つかりません');
      if(old && !canEditLive_(old,me)) throw new Error('名前を選び直してください');
      if(old && String(p.version)!==old.version) throw new Error('他の更新がありました。再読込してください');
      const date=normalizeDate_(p.date,Number(japanToday_().slice(0,4))); if(!date) throw new Error('日付を確認してください');
      if(date<japanToday_()) throw new Error('終了済みのイベントは登録できません');
      const url=text_(p.sheetUrl,600,false); if(url&&!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+(?:[/?#].*)?$/.test(url)) throw new Error('スプレッドシートURLを確認してください');
      write_('Lives',{id:old?old.id:Utilities.getUuid(),title:text_(p.title,120,true),date,groups:JSON.stringify(validateGroups_(p.groups===undefined?readGroups_(old?.groups):p.groups)),purchaseUrl:purchaseUrl_(p.purchaseUrl===undefined?old?.purchaseUrl:p.purchaseUrl),lotteryDeadline:deadline_(p.lotteryDeadline===undefined?old?.lotteryDeadline:p.lotteryDeadline),requiredThrows:throws_(p.requiredThrows===undefined?old?.requiredThrows:p.requiredThrows),venue:text_(p.venue,120,false),sheetUrl:url,memo:text_(p.memo,500,false),owner:old?.owner||me.id,version:old?Number(old.version)+1:1},old);
    } else if(action==='deleteLive') {
      const live=rows_('Lives').find(x=>x.id===p.id);
      if(!live) throw new Error('ライブが見つかりません');
      if(!canEditLive_(live,me)) throw new Error('名前を選び直してください');
      if(String(p.version)!==live.version) throw new Error('他の更新がありました。再読込してください');
      prepareSave_();
      const index=rows_('Lives').findIndex(row=>row.id===live.id);
      sheet_('Lives').deleteRow(index+2);
      invalidate_('Lives');
      requestChanges.Lives={upsert:[],remove:[live.id]};
    } else {
      const live=rows_('Lives').find(x=>x.id===p.liveId);
      if(!live) throw new Error('ライブが見つかりません');
      const liveDate=normalizeDate_(live.date,Number(japanToday_().slice(0,4)));
      if(!liveDate || liveDate<japanToday_()) throw new Error('終了済みまたは日付が不正なイベントです。再読込してください');
      if(action==='attendance') {
        const old=rows_('Attendance').find(x=>x.liveId===p.liveId&&x.memberId===me.id);
        if(old && String(p.version)!==old.version) throw new Error('他の更新がありました。再読込してください');
        const status=enum_(p.status,['参戦','未定','不参加']);
        const applied=status==='不参加'?'申込不要':old?.status==='不参加'?'':old?.applied||'';
        write_('Attendance',{id:old?old.id:Utilities.getUuid(),liveId:p.liveId,memberId:me.id,status,applied,version:old?Number(old.version)+1:1},old);
      } else if(action==='application') {
        const old=rows_('Attendance').find(x=>x.liveId===p.liveId&&x.memberId===me.id);
        if(old&&p.version!==undefined&&String(p.version)!==old.version)throw new Error('申込状況が更新されています。再読込してください');
        const selected=enum_(p.applied,['申込済み','申込不要','未確認']);
        const applied=old?.status==='不参加'?'申込不要':selected==='未確認'?'':selected;
        write_('Attendance',{id:old?old.id:Utilities.getUuid(),liveId:p.liveId,memberId:me.id,status:old?.status||'',applied,version:old?Number(old.version)+1:1},old);
      } else if(action==='addTickets') {
        // Accept the old uniform-status payload as well as per-ticket entries.
        const input=p.entries!==undefined?p.entries:(Array.isArray(p.numbers)?p.numbers.map(number=>({number,status:p.status})):null);
        if(!Array.isArray(input)||input.length<1||input.length>50) throw new Error('1回に1〜50枚まで登録できます');
        const entries=input.map(entry=>{
          if(!entry||typeof entry!=='object') throw new Error('チケットの入力内容を確認してください');
          const status=enum_(entry.status,['未発券','自分用','余り','取引中','捌けた']);
          const number=status==='未発券'?'':text_(String(entry.number??'').normalize('NFKC'),30,true);
          return {number,status,ticketUrl:purchaseUrl_(entry.ticketUrl)};
        });
        const nums=entries.map(entry=>entry.number);
        const existing=rows_('Tickets').filter(t=>t.liveId===p.liveId).map(t=>t.number.toUpperCase());
        const named=nums.filter(Boolean).map(x=>x.toUpperCase());
        if(new Set(named).size!==named.length||named.some(n=>existing.includes(n))) throw new Error('このライブに同じ整理番号が登録されています。券種が異なる場合は「VIP-A12」などにしてください');
        const added=entries.map(({number,status,ticketUrl})=>({id:Utilities.getUuid(),liveId:p.liveId,memberId:me.id,number,status,recipient:'',memo:'',version:1,ticketUrl}));
        const values=added.map(row=>TABLES.Tickets.map(k=>safe_(row[k])));
        prepareSave_();
        const s=sheet_('Tickets');s.getRange(s.getLastRow()+1,1,values.length,TABLES.Tickets.length).setValues(values);invalidate_('Tickets');added.forEach(row=>recordChange_('Tickets',row));
      } else if(action==='ticket' || action==='deleteTicket') {
        const old=rows_('Tickets').find(t=>t.id===p.id&&t.liveId===p.liveId);
        if(!old||old.memberId!==me.id) throw new Error('選択中の名前のチケットのみ編集できます');
        if(String(p.version)!==old.version) throw new Error('他の更新がありました。再読込してください');
        if(action==='deleteTicket') { prepareSave_();sheet_('Tickets').deleteRow(rows_('Tickets').findIndex(t=>t.id===old.id)+2);invalidate_('Tickets');requestChanges.Tickets={upsert:[],remove:[old.id]}; }
        else {
          const status=enum_(p.status,['未発券','自分用','余り','取引中','捌けた']);
          const number=text_(p.number,30,status!=='未発券');
          if(number&&rows_('Tickets').some(t=>t.liveId===old.liveId&&t.id!==old.id&&t.number.toUpperCase()===number.toUpperCase())) throw new Error('同じ整理番号が登録されています');
          write_('Tickets',{...old,number,status,recipient:text_(p.recipient,80,false),memo:text_(p.memo,500,false),version:Number(old.version)+1,ticketUrl:purchaseUrl_(p.ticketUrl)},old);
        }
      } else throw new Error('操作が無効です');
    }
    SpreadsheetApp.flush();
    // Old clients still receive a full snapshot. New clients request a compact receipt.
    const result={kind:'patch-v1',changes:requestChanges,savedAt:new Date().toISOString()};
    if(requestReceipt?.prepared){
      requestReceipt.sheet.getRange(requestReceipt.row,5,1,2).setValues([['done',JSON.stringify(result)]]);
      SpreadsheetApp.flush();
    }
    if(options?.response==='patch-v1') return result;
    return snapshot_(me);
  } finally { lock.releaseLock(); }
}
