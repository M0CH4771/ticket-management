/* GitHub Pages -> isolated GAS iframe -> google.script.run.
 * No tokens, JSONP, no-cors writes, or automatic mutation retries.
 */
(() => {
  const pending = new Map();
  let connection;
  const methods = new Set(['getMembers', 'registerMember', 'getData', 'saveData']);
  function validateEndpoint(value) {
    const url = new URL(value);
    if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) || url.search || url.hash) throw new Error('GASの公開URL（末尾 /exec）を確認してください');
    return url;
  }
  function googleOrigin(origin) {
    try {const url = new URL(origin);return url.protocol === 'https:' && (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com' || url.hostname.endsWith('.script.googleusercontent.com') || url.hostname.endsWith('-script.googleusercontent.com'));} catch {return false;}
  }
  function connect() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      let url;
      try {url = validateEndpoint(window.LIVE_POCKET_CONFIG?.gasUrl || '');} catch(e) {reject(e);return;}
      const channel = crypto.randomUUID();
      const frame = document.createElement('iframe');
      frame.title = 'データ接続';frame.hidden = true;frame.setAttribute('aria-hidden', 'true');
      let peer, peerOrigin;
      const handshakeTimeout = setTimeout(() => {
        window.removeEventListener('message', onMessage);frame.remove();connection = null;
        reject(new Error('保存先に接続できません。GASを「自分として実行・全員がアクセス可」で公開し、最新のCode.gsとBridge.htmlを反映してください。'));
      }, 30000);
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
        pending.delete(message.id);clearTimeout(request.timeout);
        if (message.ok) request.resolve(message.value);
        else request.reject(new Error(message.error || '保存先でエラーが発生しました'));
      }
      window.addEventListener('message', onMessage);
      url.searchParams.set('channel', channel);
      frame.src = url.href;
      document.body.appendChild(frame);
    });
    return connection;
  }
  async function call(method, ...args) {
    if (!methods.has(method)) throw new Error('未対応の操作です');
    const {peer, peerOrigin, channel} = await connect();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method==='saveData'||method==='registerMember' ? '応答がありません。登録済みの可能性があります。再読込して内容を確認してから操作してください。' : '読込がタイムアウトしました。再読込してください。'));
      }, 60000);
      pending.set(id, {resolve, reject, timeout});
      peer.postMessage({type:'live-pocket-call', channel, id, method, args}, peerOrigin);
    });
  }
  window.LivePocketTransport = {call};
})();
