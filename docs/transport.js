/* GitHub Pages -> isolated GAS iframe -> google.script.run.
 * No tokens, JSONP, no-cors writes, or automatic mutation retries.
 */
(() => {
  const pending = new Map();
  let connection, dispose;
  const methods = new Set(['getMembers', 'registerMember', 'getData', 'saveData']);
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
    const mutation = method === 'saveData' || method === 'registerMember';
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
        finish(new Error(mutation ? '応答がありません。登録済みの可能性があります。再読込して内容を確認してから操作してください。' : '読み込みに時間がかかっています。再読込を押して、もう一度お試しください。'));
        resetIdleConnection();
      }, mutation ? 80000 : 30000);
      pending.set(id, {finish});
      try {
        connect().then(({peer, peerOrigin, channel}) => {
          if (settled) return;
          try {peer.postMessage({type:'live-pocket-call', channel, id, method, args}, peerOrigin);}
          catch (error) {finish(error);resetIdleConnection();}
        }, error => {finish(error);resetIdleConnection();});
      } catch (error) {finish(error);resetIdleConnection();}
    });
  }
  window.LivePocketTransport = {call};
})();
