/* Two backends behind one call(method, ...args) interface:
 *  - apiUrl set (Cloudflare Worker): HTTPS POST to /api/rpc with the Firebase ID token
 *    in the Authorization header. Fast; no iframe.
 *  - otherwise (legacy Google Apps Script): isolated GAS iframe -> google.script.run,
 *    with the token passed only as the first RPC argument.
 * Tokens never go into URLs or logs. No JSONP, no-cors writes, or automatic mutation retries.
 */
(() => {
  const pending = new Map();
  let connection, dispose;
  const methods = new Set(['getAuthConfig', 'getMembers', 'registerMember', 'getData', 'saveData', 'getAdminSettings', 'saveAdminSettings', 'getPushSettings', 'savePushSubscription', 'removePushSubscription', 'testPushSubscription', 'listMembers', 'saveMember', 'importData', 'getWidgetKey', 'resetWidgetKey']);
  const mutations = new Set(['saveData', 'registerMember', 'saveAdminSettings', 'savePushSubscription', 'removePushSubscription', 'testPushSubscription', 'saveMember', 'importData', 'getWidgetKey', 'resetWidgetKey']);
  const timeoutMessage = mutation => mutation ? '応答がありません。登録済みの可能性があります。再読込して内容を確認してから操作してください。' : '読み込みに時間がかかっています。再読込を押して、もう一度お試しください。';
  function apiBase() {
    const value = window.LIVE_POCKET_CONFIG?.apiUrl;
    if (!value) return null;
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if ((url.protocol !== 'https:' && !local) || url.search || url.hash) throw new Error('APIのURL（https://…）を確認してください');
    return url.origin + url.pathname.replace(/\/+$/, '');
  }
  async function authHeader(method) {
    if (method === 'getAuthConfig') return {};
    const authApi = window.LivePocketAuth || await window.LivePocketAuthReady;
    if (!authApi) throw new Error('Googleアカウントでログインしてください');
    return {authorization: 'Bearer ' + await authApi.getIdToken()};
  }
  async function fetchCall(base, method, args) {
    const mutation = mutations.has(method), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), mutation ? 30000 : 20000);
    try {
      const headers = {'content-type': 'application/json', ...await authHeader(method)};
      let response;
      try {
        response = await fetch(base + '/api/rpc', {method: 'POST', headers, body: JSON.stringify({method, args}), signal: controller.signal, credentials: 'omit', cache: 'no-store'});
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error(timeoutMessage(mutation));
        throw new Error(mutation ? '保存先に接続できませんでした。登録済みか再読込して確認してから操作してください。' : '保存先に接続できませんでした。通信環境を確認して、もう一度読み込んでください。');
      }
      let body;
      try {body = await response.json();} catch {throw new Error('保存先から正しい応答がありませんでした。少し待って再度お試しください。');}
      if (!body?.ok) throw new Error(body?.error || '保存先でエラーが発生しました');
      return body.value;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(timeoutMessage(mutation));
      throw error;
    } finally {clearTimeout(timer);}
  }
  function validateEndpoint(value) {
    const url = new URL(value);
    if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) || url.search || url.hash) throw new Error('GASの公開URL（末尾 /exec）を確認してください');
    return url;
  }
  function googleOrigin(origin) {
    try {const url = new URL(origin);return url.protocol === 'https:' && (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com' || url.hostname.endsWith('.script.googleusercontent.com') || url.hostname.endsWith('-script.googleusercontent.com'));} catch {return false;}
  }
  function resetIdleConnection() {
    // Never interrupt another request, especially a write whose outcome is unknown.
    if (!pending.size) {dispose?.();dispose = null;connection = null;}
  }
  function connect() {
    if (connection) return connection;
    const url = validateEndpoint(window.LIVE_POCKET_CONFIG?.gasUrl || '');
    connection = new Promise((resolve, reject) => {
      const channel = crypto.randomUUID();
      const frame = document.createElement('iframe');
      frame.title = 'データ接続';frame.hidden = true;frame.setAttribute('aria-hidden', 'true');
      let peer, peerOrigin;
      const handshakeTimeout = setTimeout(() => {
        dispose?.();dispose = null;connection = null;
        reject(new Error('保存先に接続できませんでした。通信環境を確認して、もう一度読み込んでください。'));
      }, 20000);
      dispose = () => {clearTimeout(handshakeTimeout);window.removeEventListener('message', onMessage);frame.remove();};
      function onMessage(event) {
        const message = event.data;
        if (!message || message.channel !== channel || !googleOrigin(event.origin)) return;
        if (message.type === 'live-pocket-ready' && !peer) {
          if (!event.source) return;
          peer = event.source;peerOrigin = event.origin;
          clearTimeout(handshakeTimeout);
          resolve({peer, peerOrigin, channel});
          return;
        }
        if (!peer || event.source !== peer || event.origin !== peerOrigin || message.type !== 'live-pocket-result') return;
        const request = pending.get(message.id);
        if (!request) return;
        if (message.ok) request.finish(null, message.value);
        else request.finish(new Error(message.error || '保存先でエラーが発生しました'));
      }
      window.addEventListener('message', onMessage);
      url.searchParams.set('channel', channel);
      frame.src = url.href;
      document.body.appendChild(frame);
    });
    return connection;
  }
  function call(method, ...args) {
    if (!methods.has(method)) return Promise.reject(new Error('未対応の操作です'));
    let base;
    try {base = apiBase();} catch (error) {return Promise.reject(error);}
    if (base) return fetchCall(base, method, args);
    const mutation = mutations.has(method);
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;clearTimeout(timeout);pending.delete(id);
        if (error) reject(error);else resolve(value);
      }
      // One deadline includes both iframe startup and the server response.
      const timeout = setTimeout(() => {
        finish(new Error(timeoutMessage(mutation)));
        resetIdleConnection();
      }, mutation ? 80000 : 30000);
      pending.set(id, {finish});
      try {
        Promise.resolve().then(async()=>{
          const authApi=method==='getAuthConfig'?null:(window.LivePocketAuth||await window.LivePocketAuthReady);
          if(method!=='getAuthConfig'&&!authApi)throw new Error('Googleアカウントでログインしてください');
          const callArgs=method==='getAuthConfig'?args:[await authApi.getIdToken(),...args];
          return connect().then(({peer,peerOrigin,channel})=>{
            if(settled)return;
            try{peer.postMessage({type:'live-pocket-call',channel,id,method,args:callArgs},peerOrigin);}
            catch(error){finish(error);resetIdleConnection();}
          });
        }).catch(error=>{finish(error);resetIdleConnection()});
      } catch (error) {finish(error);resetIdleConnection();}
    });
  }
  // Start the GAS iframe handshake early so it overlaps with sign-in.
  function warm() {
    try {
      const base = apiBase();
      if (base) {
        // Open the HTTPS connection to the API while sign-in is still starting.
        const link = document.createElement('link');link.rel = 'preconnect';link.href = new URL(base).origin;link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
        return;
      }
      connect().catch(() => {});
    } catch {}
  }
  window.LivePocketTransport = {call, warm};
})();
