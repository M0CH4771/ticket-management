/* Optional free FCM notifications. Add this file without replacing Code.gs.
 * Credentials and device tokens stay in private Script Properties, never Sheets/GitHub.
 * Functions ending in _ are editor/trigger-only, inaccessible to google.script.run.
 */
const PUSH_DEVICE_PREFIX_ = 'PUSH_DEVICE_';
function pushProperties_() { return PropertiesService.getScriptProperties(); }
function pushConfig_() {
  const p=pushProperties_();
  try {
    const raw=JSON.parse(p.getProperty('PUSH_FIREBASE_CONFIG')||'{}');
    const config={};
    for(const key of ['apiKey','projectId','messagingSenderId','appId']) {
      if(typeof raw[key]!=='string'||!raw[key]||raw[key].length>300) return null;
      config[key]=raw[key];
    }
    const vapidKey=p.getProperty('PUSH_VAPID_PUBLIC_KEY')||'';
    const service=JSON.parse(p.getProperty('PUSH_SERVICE_ACCOUNT')||'{}');
    if(!/^[A-Za-z0-9_-]{87}$/.test(vapidKey)||service.project_id!==config.projectId||!service.private_key||!service.client_email) return null;
    return {config,vapidKey};
  } catch(e) { return null; }
}
function getPushSettings() {
  const config=pushConfig_();
  return config&&pushProperties_().getProperty('PUSH_ENABLED')==='yes'?{ready:true,...config}:{ready:false};
}
function pushIdentity_(id,secret) {
  if(!/^[a-f0-9-]{36}$/.test(id||'')||!/^[a-f0-9]{64}$/.test(secret||'')) throw new Error('通知の登録情報が無効です');
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,secret));
}
function savePushSubscription(memberId,device) {
  if(!getPushSettings().ready) throw new Error('通知は管理者の初期設定待ちです');
  resetRequest_();selectedMember_(memberId);
  const hash=pushIdentity_(device?.id,device?.secret);
  if(typeof device.token!=='string'||!device.token||device.token.length>2000||!/^[A-Za-z0-9_:.-]+$/.test(device.token)) throw new Error('通知の宛先が無効です');
  const lock=LockService.getUserLock();lock.waitLock(10000);
  try {
    const p=pushProperties_(),key=PUSH_DEVICE_PREFIX_+device.id;
    const prior=JSON.parse(p.getProperty(key)||'null');
    if(prior&&prior.hash!==hash) throw new Error('通知の登録情報が一致しません');
    const entries=Object.entries(p.getProperties()).filter(([k])=>k.startsWith(PUSH_DEVICE_PREFIX_));
    if(!prior&&entries.length>=100) throw new Error('通知登録が上限です。管理者に連絡してください');
    // A cleared browser storage can reuse the same FCM token. Keep one active destination.
    let sentDay=prior?.sentDay||'';
    for(const [otherKey,value] of entries) {
      const other=JSON.parse(value);
      if(otherKey!==key&&other.token===device.token) {
        sentDay=[sentDay,other.sentDay||''].sort().pop();
        p.setProperty(otherKey,JSON.stringify({...other,enabled:false,token:'',updatedAt:Date.now()}));
      }
    }
    // Re-enabling the same device preserves today's delivery receipt.
    p.setProperty(key,JSON.stringify({...prior,sentDay,hash,token:device.token,enabled:true,updatedAt:Date.now()}));
    return {enabled:true};
  } finally { lock.releaseLock(); }
}
function removePushSubscription(id,secret) {
  const hash=pushIdentity_(id,secret),lock=LockService.getUserLock();lock.waitLock(10000);
  try {
    const p=pushProperties_(),key=PUSH_DEVICE_PREFIX_+id,prior=JSON.parse(p.getProperty(key)||'null');
    if(prior&&prior.hash!==hash) throw new Error('通知の登録情報が一致しません');
    if(prior)p.setProperty(key,JSON.stringify({...prior,enabled:false,token:'',updatedAt:Date.now()}));
    return {enabled:false};
  } finally { lock.releaseLock(); }
}
// Run once from the GAS editor after adding the three Script Properties.
function installPushNotifications_() {
  if(!pushConfig_()) throw new Error('Firebase設定・公開VAPIDキー・サービスアカウントJSONを確認してください');
  if(!pushProperties_().getProperty('SHEET_ID')) throw new Error('既存の管理スプシが設定されていません');
  pushAccessToken_(); // Validate credentials before marking the service ready.
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='sendDeadlinePush_').forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendDeadlinePush_').timeBased().everyMinutes(5).create();
  pushProperties_().setProperty('PUSH_ENABLED','yes');
  console.log('通知の準備ができました。サイトの「通知設定」から登録できます。');
}
function stopPushNotifications_() {
  pushProperties_().deleteProperty('PUSH_ENABLED');
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='sendDeadlinePush_').forEach(t=>ScriptApp.deleteTrigger(t));
}
function pushAccessToken_() {
  const p=pushProperties_(),service=JSON.parse(p.getProperty('PUSH_SERVICE_ACCOUNT')||'{}');
  const cache=CacheService.getScriptCache(),cacheKey='push-access-'+service.project_id;
  const cached=cache.get(cacheKey);if(cached)return cached;
  const now=Math.floor(Date.now()/1000),encode=s=>Utilities.base64EncodeWebSafe(s).replace(/=+$/,'');
  const unsigned=encode(JSON.stringify({alg:'RS256',typ:'JWT'}))+'.'+encode(JSON.stringify({iss:service.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const assertion=unsigned+'.'+encode(Utilities.computeRsaSha256Signature(unsigned,service.private_key));
  const response=UrlFetchApp.fetch('https://oauth2.googleapis.com/token',{method:'post',payload:{grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion},muteHttpExceptions:true});
  if(response.getResponseCode()!==200)throw new Error('通知用の認証に失敗しました。サービスアカウントの設定を確認してください');
  const result=JSON.parse(response.getContentText());
  if(!result.access_token)throw new Error('通知用の認証に失敗しました');
  cache.put(cacheKey,result.access_token,3000);return result.access_token;
}
function pushDueEvents_(lives,today) {
  return lives.filter(l=>{
    const date=normalizeDate_(l.date,Number(today.slice(0,4)));
    let deadline=normalizeDate_(l.lotteryDeadline,Number((date||today).slice(0,4)));
    if(/^\d{1,2}\/\d{1,2}$/.test(String(l.lotteryDeadline||'').normalize('NFKC').trim())&&date&&deadline>date)
      deadline=normalizeDate_(l.lotteryDeadline,Number(date.slice(0,4))-1);
    return l.id&&l.title&&date>=today&&deadline===today;
  })
    .sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title,'ja'));
}
function pushBody_(lives) {
  const lines=lives.slice(0,3).map(l=>String(l.title).slice(0,70)+'／投げ数 '+(l.requiredThrows!==''&&l.requiredThrows!=null?l.requiredThrows+'枚':'未設定'));
  if(lives.length>3)lines.push('ほか'+(lives.length-3)+'件');
  lines.push('タップしてイベントを確認');return lines.join('\n');
}
function sendDeadlinePush_() {
  const now=new Date(),today=Utilities.formatDate(now,'Asia/Tokyo','yyyy-MM-dd');
  if(Number(Utilities.formatDate(now,'Asia/Tokyo','H'))<12||!getPushSettings().ready)return;
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))return;
  try {
    resetRequest_();
    const p=pushProperties_(),config=pushConfig_();
    const lives=pushDueEvents_(rows_('Lives'),today);if(!lives.length)return;
    const entries=Object.entries(p.getProperties()).filter(([key])=>key.startsWith(PUSH_DEVICE_PREFIX_));
    const due=entries.map(([key,value])=>({key,...JSON.parse(value)})).filter(d=>d.enabled&&d.token&&d.sentDay!==today&&!(d.attemptDay===today&&(d.attempts>=3||d.nextAttempt>Date.now()))).slice(0,10);
    if(!due.length)return;
    const access=pushAccessToken_();
    const ttl=Math.max(0,Math.floor((Date.parse(today+'T23:59:59+09:00')-Date.now())/1000));if(!ttl)return;
    for(const d of due) {
      const {key,...record}=d;
      record.attempts=d.attemptDay===today?(d.attempts||0)+1:1;
      record.attemptDay=today;record.nextAttempt=Date.now()+15*60000;
      p.setProperty(key,JSON.stringify(record)); // Reserve before sending; recover after transient failure.
      try {
        const response=UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/'+encodeURIComponent(config.config.projectId)+'/messages:send',{
          method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+access},muteHttpExceptions:true,
          payload:JSON.stringify({message:{token:d.token,data:{title:'本日抽選締切（'+lives.length+'件）',body:pushBody_(lives),tag:'ticket-deadline-'+today},webpush:{headers:{TTL:String(ttl),Urgency:'normal'}}}})
        });
        const status=response.getResponseCode();
        if(status===200){record.sentDay=today;record.lastStatus='sent';}
        else {
          let result={};try{result=JSON.parse(response.getContentText())}catch(e){}
          const unregistered=result.error?.details?.some(x=>x.errorCode==='UNREGISTERED');
          record.lastStatus='HTTP '+status;
          if(unregistered){record.enabled=false;record.token='';}
          if(status===401||status===403)CacheService.getScriptCache().remove('push-access-'+config.config.projectId);
        }
      } catch(e) { record.lastStatus='network-error'; }
      p.setProperty(key,JSON.stringify(record));
    }
    p.setProperty('PUSH_LAST_RUN',now.toISOString());
  } finally { lock.releaseLock(); }
}
// Explicit device-only test; never broadcasts and never exposes tokens.
function testPushSubscription(id,secret) {
  const hash=pushIdentity_(id,secret),lock=LockService.getUserLock();lock.waitLock(10000);
  try {
    const p=pushProperties_(),key=PUSH_DEVICE_PREFIX_+id,record=JSON.parse(p.getProperty(key)||'null');
    if(!record||record.hash!==hash||!record.enabled||!record.token)throw new Error('先にこの端末の通知を登録してください');
    if(record.testAt&&Date.now()-record.testAt<60000)throw new Error('テスト通知は1分ほど間隔をあけてください');
    const config=pushConfig_();if(!config)throw new Error('通知の初期設定を確認してください');
    record.testAt=Date.now();p.setProperty(key,JSON.stringify(record));
    const response=UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/'+encodeURIComponent(config.config.projectId)+'/messages:send',{
      method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+pushAccessToken_()},muteHttpExceptions:true,
      payload:JSON.stringify({message:{token:record.token,data:{title:'通知のテスト',body:'Ticket Managementの通知が届きました。',tag:'ticket-push-test'},webpush:{headers:{TTL:'300'}}}})
    });
    if(response.getResponseCode()!==200)throw new Error('テスト送信に失敗しました。Firebase Cloud Messaging APIとサービスアカウントの権限を確認してください');
    return {accepted:true};
  } finally { lock.releaseLock(); }
}
