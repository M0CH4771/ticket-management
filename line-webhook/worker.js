const encoder = new TextEncoder();

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return constantTimeEqual(btoa(binary), signature);
}

async function saveGroupId(groupId, env) {
  if (typeof env.GAS_WEB_APP_URL !== 'string' || !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(env.GAS_WEB_APP_URL)) return false;
  if (typeof env.GAS_WEBHOOK_SHARED_SECRET !== 'string' || env.GAS_WEBHOOK_SHARED_SECRET.length < 32) return false;
  const response = await fetch(env.GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'line_group_join',
      groupId,
      secret: env.GAS_WEBHOOK_SHARED_SECRET
    })
  });
  let result;
  try { result = await response.json(); } catch { result = null; }
  return response.ok && result?.ok === true;
}

export default {
  async fetch(request, env) {
    if (request.method === 'GET') return new Response('Ticket Management LINE webhook is ready.');
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (typeof env.LINE_CHANNEL_SECRET !== 'string' || !env.LINE_CHANNEL_SECRET) return new Response('Webhook is not configured', { status: 503 });

    const rawBody = await request.text();
    if (rawBody.length > 100000) return new Response('Payload too large', { status: 413 });
    const signature = request.headers.get('x-line-signature');
    if (!await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET))
      return new Response('Invalid signature', { status: 401 });

    let payload;
    try { payload = JSON.parse(rawBody); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const joined = (Array.isArray(payload.events) ? payload.events : []).find(event =>
      event?.type === 'join' && event.source?.type === 'group' && typeof event.source.groupId === 'string'
    );
    if (!joined) return new Response('OK');

    const accepted = await saveGroupId(joined.source.groupId, env);
    return accepted ? new Response('OK') : new Response('GAS did not accept the group ID', { status: 502 });
  }
};
