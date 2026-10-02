const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const properties = new Map([['LINE_WEBHOOK_SHARED_SECRET', 'a'.repeat(48)]]);
const gasContext = {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: key => properties.get(key) || null,
    setProperty: (key, value) => properties.set(key, value)
  }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: value => ({
    value, setMimeType() { return this; }
  }) },
  JSON
};
vm.runInNewContext(fs.readFileSync('LineWebhook.gs', 'utf8'), gasContext);
const response = (result) => JSON.parse(result.value);
const good = secret => gasContext.doPost({ postData: { contents: JSON.stringify({
  kind: 'line_group_join', groupId: 'Cgroup-123', secret
}) } });
assert.equal(response(good('wrong')).error, 'unauthorized');
assert.equal(response(good('a'.repeat(48))).ok, true);
assert.equal(properties.get('LINE_GROUP_ID'), 'Cgroup-123');
const overwrite = gasContext.doPost({ postData: { contents: JSON.stringify({
  kind: 'line_group_join', groupId: 'Cother', secret: 'a'.repeat(48)
}) } });
assert.equal(response(overwrite).error, 'group_already_set');
assert.equal(properties.get('LINE_GROUP_ID'), 'Cgroup-123');

let forwarded = [];
const workerSource = fs.readFileSync('line-webhook/worker.js', 'utf8')
  .replace('export default {', 'const worker = {') + '\nglobalThis.worker = worker;';
const workerContext = {
  TextEncoder, crypto: webcrypto, btoa, Request, Response, JSON,
  fetch: async (url, options) => {
    forwarded.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
};
vm.runInNewContext(workerSource, workerContext);
const worker = workerContext.worker;
const env = {
  LINE_CHANNEL_SECRET: 'channel-secret',
  GAS_WEB_APP_URL: 'https://script.google.com/macros/s/deployment/exec',
  GAS_WEBHOOK_SHARED_SECRET: 'b'.repeat(48)
};
async function signature(body) {
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return Buffer.from(digest).toString('base64');
}
(async () => {
  const body = JSON.stringify({ events: [{ type: 'join', source: { type: 'group', groupId: 'Cgroup-123' } }] });
  const sig = await signature(body);
  const rejected = await worker.fetch(new Request('https://worker.test', { method: 'POST', body, headers: { 'x-line-signature': 'bad' } }), env);
  assert.equal(rejected.status, 401);
  assert.equal(forwarded.length, 0);
  const accepted = await worker.fetch(new Request('https://worker.test', { method: 'POST', body, headers: { 'x-line-signature': sig } }), env);
  assert.equal(accepted.status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, env.GAS_WEB_APP_URL);
  assert.deepEqual(JSON.parse(forwarded[0].options.body), {
    kind: 'line_group_join', groupId: 'Cgroup-123', secret: env.GAS_WEBHOOK_SHARED_SECRET
  });
  const ignoredBody = JSON.stringify({ events: [{ type: 'message', source: { type: 'group', groupId: 'Cignored' } }] });
  const ignored = await worker.fetch(new Request('https://worker.test', { method: 'POST', body: ignoredBody, headers: { 'x-line-signature': await signature(ignoredBody) } }), env);
  assert.equal(ignored.status, 200);
  assert.equal(forwarded.length, 1);
  console.log('LINE webhook signature, single-group lock, and forwarding checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
