const storageKey='ticket-push-v1';
let dialog,working=false,settings,clientPromise;
const read=()=>{try{return JSON.parse(localStorage.getItem(storageKey)||'null')}catch{return null}};
const write=value=>localStorage.setItem(storageKey,JSON.stringify(value));
const rpc=(...args)=>window.LivePocketTransport.call(...args);
const endpoint=()=>window.LIVE_POCKET_CONFIG?.gasUrl;
const saved=()=>{const state=read();return state?.endpoint===endpoint()?state:null};
function timed(promise,ms=20000){let timer;return Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('接続に時間がかかっています。もう一度お試しください。')),ms))]).finally(()=>clearTimeout(timer))}
function status(message){if(dialog)dialog.querySelector('[role=status]').textContent=message}
function controls(){
  if(!dialog)return;
  const state=saved(),permitted=globalThis.Notification?.permission==='granted';
  dialog.querySelector('[data-enable]').disabled=working||!settings?.ready||!supported()||globalThis.Notification?.permission==='denied';
  dialog.querySelector('[data-enable]').textContent=state?.enabled&&permitted?'通知の登録を更新':'通知を受け取る';
  dialog.querySelector('[data-test]').hidden=!state?.enabled;
  dialog.querySelector('[data-test]').disabled=working;
  dialog.querySelector('[data-disable]').hidden=!state;
  dialog.querySelector('[data-disable]').disabled=working;
}
function supported(){return isSecureContext&&'Notification' in window&&'serviceWorker' in navigator&&'PushManager' in window}
function isIOSBrowser(){return (/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1))&&!navigator.standalone&&!matchMedia('(display-mode: standalone)').matches}
async function client(config){
  if(!clientPromise)clientPromise=Promise.all([
    import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js')
  ]).then(async([app,sdk])=>{
    if(!await sdk.isSupported())throw new Error('この端末では通知を利用できません。');
    const firebase=app.getApps().find(a=>a.name==='ticket-push')||app.initializeApp(config,'ticket-push');
    return {sdk,messaging:sdk.getMessaging(firebase)};
  }).catch(error=>{clientPromise=null;throw error});
  return clientPromise;
}
async function worker(){
  const registration=await navigator.serviceWorker.register(new URL('./push-worker.js',import.meta.url),{scope:new URL('./',import.meta.url).pathname,updateViaCache:'none'});
  if(!registration.active)await timed(new Promise((resolve,reject)=>{
    const sw=registration.installing||registration.waiting;
    if(!sw)return reject(new Error('通知の準備に失敗しました。'));
    const changed=()=>{if(sw.state==='activated'){sw.removeEventListener('statechange',changed);resolve()}else if(sw.state==='redundant'){sw.removeEventListener('statechange',changed);reject(new Error('通知の準備に失敗しました。'))}};
    sw.addEventListener('statechange',changed);changed();
  }));
  return registration;
}
async function register(state){
  const registration=await timed(worker()),{sdk,messaging}=await timed(client(state.config));
  const token=await timed(sdk.getToken(messaging,{vapidKey:state.vapidKey,serviceWorkerRegistration:registration}));
  if(!token)throw new Error('通知の宛先を作成できませんでした。');
  await rpc('savePushSubscription',state.memberId,{id:state.id,secret:state.secret,token});
  write({...state,enabled:true,pending:false});
}
async function enable(memberId){
  if(working||!settings?.ready)return;
  working=true;controls();
  try {
    // Permission must be requested directly from the user's tap (especially iOS).
    const permission=await Notification.requestPermission();
    if(permission!=='granted')throw new Error('通知が許可されていません。端末の設定から通知を許可してください。');
    const prior=saved();
    const state={id:prior?.id||crypto.randomUUID(),secret:prior?.secret||Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),endpoint:endpoint(),memberId,config:settings.config,vapidKey:settings.vapidKey,enabled:false,pending:true};
    write(state);status('通知を登録しています…');
    await register(state);status('通知をオンにしました。締切日の昼12時以降にお知らせします。');
  } catch(error){status(error.message||'通知を登録できませんでした。')}
  finally{working=false;controls()}
}
async function disable(){
  const state=saved();if(working||!state)return;
  working=true;controls();
  try{
    write({...state,enabled:false,pending:false});
    const registration=await navigator.serviceWorker.getRegistration(new URL('./',import.meta.url));
    const subscription=await registration?.pushManager.getSubscription();
    if(subscription)await subscription.unsubscribe();
    await rpc('removePushSubscription',state.id,state.secret);
    status('この端末の通知をオフにしました。');
  }catch(error){status('通知停止を完了できませんでした。もう一度「通知をオフ」を押してください。')}
  finally{working=false;controls()}
}
export async function open(memberId){
  if(dialog?.open)return;
  dialog?.remove();dialog=document.createElement('dialog');dialog.setAttribute('aria-labelledby','push-title');
  dialog.innerHTML='<div class="modal-head"><h2 id="push-title">締切の通知</h2></div><div class="modal-body"><p>抽選締切日の昼12時以降に、その日が締切のイベントをまとめて通知します。</p><p class="muted">通知にはイベント名と投げ数を表示します。端末や通信の状態により遅れる場合があります。</p><p role="status" aria-live="polite">設定を確認しています…</p><p class="muted"><a href="./notifications-setup.html" target="_blank" rel="noopener">管理者向け：初回の設定手順</a></p><button type="button" class="primary" data-enable disabled>通知を受け取る</button> <button type="button" data-disable hidden>通知をオフ</button> <button type="button" data-test hidden>テスト通知</button><p class="muted">iPhoneは「ホーム画面に追加」して、追加したアイコンから開いてください。</p></div><div class="modal-actions"><button type="button" data-close>閉じる</button></div>';
  document.body.appendChild(dialog);dialog.showModal();dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.querySelector('[data-enable]').onclick=()=>enable(memberId);dialog.querySelector('[data-disable]').onclick=disable;
  dialog.querySelector('[data-test]').onclick=async()=>{
    const state=saved();if(working||!state?.enabled)return;working=true;controls();
    try{await rpc('testPushSubscription',state.id,state.secret);status('テスト通知を送信しました。端末に届いたか確認してください。')}
    catch(error){status(error.message)}finally{working=false;controls()}
  };
  settings=null;controls();
  if(isIOSBrowser()){status('ホーム画面に追加したアイコンから開くと、通知を設定できます。');return}
  if(!supported()){status('このブラウザでは通知を利用できません。対応する端末・ブラウザから開いてください。');return}
  try{
    settings=await rpc('getPushSettings');
    if(!settings?.ready)status('通知は管理者の初期設定待ちです。設定が完了したらここから登録できます。');
    else if(Notification.permission==='denied')status('通知がブロックされています。端末・ブラウザの設定から許可してください。');
    else status(saved()?.enabled&&Notification.permission==='granted'?'この端末は通知を受け取る設定です。':'通知はオフです。「通知を受け取る」を押して許可してください。');
  }catch(error){status('通知設定に接続できませんでした。初期設定がまだの場合は、管理者によるGASの更新が必要です。')}
  controls();
}
// Refresh an already-consented device token on reopening; never request permission here.
export async function resume(){
  const state=saved();
  if(!state?.enabled||!supported()||Notification.permission!=='granted'||working)return;
  working=true;controls();
  try{await register(state)}catch(error){/* Main event loading must remain independent. */}
  finally{working=false;controls()}
}
