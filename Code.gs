const TABLES = {
  Lives: ['id','title','date','venue','sheetUrl','memo','owner','version','lotteryDeadline','requiredThrows','purchaseUrl'],
  Members: ['id','name','tokenHash','active'],
  Attendance: ['id','liveId','memberId','status','version'],
  Tickets: ['id','liveId','memberId','number','status','recipient','memo','version'],
};
function doGet() { return HtmlService.createHtmlOutputFromFile('Index').setTitle('LIVE POCKET').addMetaTag('viewport','width=device-width, initial-scale=1'); }
// Run once from the Apps Script editor. No credentials are returned to web clients.
function setup_() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('SHEET_ID')) throw new Error('初期設定済みです');
  const ss = SpreadsheetApp.create('LIVE POCKET 管理');
  Object.keys(TABLES).forEach(name => { const s = ss.insertSheet(name); s.getRange(1,1,s.getMaxRows(),TABLES[name].length).setNumberFormat('@'); s.appendRow(TABLES[name]); s.setFrozenRows(1); s.getRange(1,1,1,TABLES[name].length).setFontWeight('bold').setBackground('#dde8ff'); });
  p.setProperty('SHEET_ID', ss.getId());
  console.log('管理スプレッドシート: '+ss.getUrl());
}
// Edit name and run from the editor for each member. Keep the issued key private.
function issueMember_() {
  const name = '幹事';
  const key = Utilities.getUuid() + Utilities.getUuid();
  sheet_('Members').appendRow([Utilities.getUuid(),name,hash_(key),'yes']);
  console.log(name+' のメンバーキー: '+key);
}
function sheet_(name) { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')).getSheetByName(name); }
function rows_(name) { return sheet_(name).getDataRange().getDisplayValues().slice(1).map(r => Object.fromEntries(TABLES[name].map((k,i)=>[k,r[i]??'']))); }
function hash_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,s).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join(''); }
function auth_(key) {
  if (typeof key !== 'string' || key.length < 60 || key.length > 100) throw new Error('メンバーキーを確認してください');
  const me = rows_('Members').find(x=>x.active==='yes' && x.tokenHash===hash_(key));
  if (!me) throw new Error('メンバーキーが無効です');
  return me;
}
function snapshot_(me) { return {me:{id:me.id,name:me.name},members:rows_('Members').filter(x=>x.active==='yes').map(x=>({id:x.id,name:x.name})),lives:rows_('Lives'),attendance:rows_('Attendance'),tickets:rows_('Tickets'),updatedAt:new Date().toISOString()}; }
function getData(key) { return snapshot_(auth_(key)); }
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
    TABLES.Lives.slice(0,8).forEach((h,i)=>{if(headers[i]!==h) throw new Error('Livesの列構成を確認してください');});
    TABLES.Lives.slice(8).forEach((h,i)=>{if(headers[i+8] && headers[i+8]!==h) throw new Error('追加先の列に既存データがあります');});
    s.getRange(1,9,s.getMaxRows(),TABLES.Lives.length-8).setNumberFormat('@');
    s.getRange(1,9,1,TABLES.Lives.length-8).setValues([TABLES.Lives.slice(8)]).setFontWeight('bold').setBackground('#dde8ff');
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
function saveData(key,action,payload) {
  const lock=LockService.getScriptLock(); if(!lock.tryLock(10000)) throw new Error('更新が混み合っています。少し待って再度保存してください');
  try {
    const me=auth_(key); const p=payload||{};
    if (action==='live') {
      const old=p.id?rows_('Lives').find(x=>x.id===p.id):null;
      if(p.id&&!old) throw new Error('ライブが見つかりません');
      if(old && old.owner!==me.id) throw new Error('ライブの編集は登録者のみ可能です');
      if(old && String(p.version)!==old.version) throw new Error('他の更新がありました。再読込してください');
      const date=text_(p.date,10,true); if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||isNaN(Date.parse(date))) throw new Error('日付を確認してください');
      const url=text_(p.sheetUrl,600,false); if(url&&!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+(?:[/?#].*)?$/.test(url)) throw new Error('スプレッドシートURLを確認してください');
      write_('Lives',{id:old?old.id:Utilities.getUuid(),title:text_(p.title,120,true),date,purchaseUrl:purchaseUrl_(p.purchaseUrl===undefined?old?.purchaseUrl:p.purchaseUrl),lotteryDeadline:deadline_(p.lotteryDeadline===undefined?old?.lotteryDeadline:p.lotteryDeadline),requiredThrows:throws_(p.requiredThrows===undefined?old?.requiredThrows:p.requiredThrows),venue:text_(p.venue,120,false),sheetUrl:url,memo:text_(p.memo,500,false),owner:me.id,version:old?Number(old.version)+1:1},old);
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
        if(!old||old.memberId!==me.id) throw new Error('自分のチケットのみ編集できます');
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
