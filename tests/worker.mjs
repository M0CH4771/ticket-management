// Cloudflare Worker + D1 backend. D1 is emulated with node:sqlite (same SQLite engine:
// transactions, JSON functions, CHECK/UNIQUE constraints). Firebase ID tokens are real
// RS256 JWTs signed with a test key whose public JWK is served by a mocked fetch.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto as crypto } from 'node:crypto';

/* ---------- D1 emulation ---------- */
function d1() {
  const db = new DatabaseSync(':memory:');
  const clean = params => params.map(v => v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
  const wrap = (sql, params = []) => ({
    bind: (...p) => wrap(sql, p),
    async all() { return { success: true, results: db.prepare(sql).all(...clean(params)).map(r => ({ ...r })), meta: {} }; },
    async first() { const r = db.prepare(sql).get(...clean(params)); return r ? { ...r } : null; },
    async run() { const r = db.prepare(sql).run(...clean(params)); return { success: true, meta: { changes: Number(r.changes) } }; },
    _sync() { db.prepare(sql).run(...clean(params)); },
  });
  return {
    raw: db,
    prepare: sql => wrap(sql),
    async exec(sql) { for (const line of sql.split('\n').map(s => s.trim()).filter(Boolean)) db.exec(line); return { count: 1 }; },
    async batch(statements) {
      db.exec('BEGIN');
      try { statements.forEach(s => s._sync()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return statements.map(() => ({ success: true }));
    },
  };
}

/* ---------- Firebase token signing ---------- */
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
const PROJECT = 'ticket-test';
async function token(email, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, sub: 'uid-' + email, email, email_verified: true, iat: now - 10, exp: now + 3600, auth_time: now - 10, ...extra };
  const unsigned = b64({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' }) + '.' + b64(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
  return unsigned + '.' + Buffer.from(sig).toString('base64url');
}

/* ---------- outbound HTTP mock ---------- */
const outbound = [];
let lineStatus = 200, fcmStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  outbound.push({ url, init });
  if (url.startsWith('https://www.googleapis.com/service_accounts/')) return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'cache-control': 'public, max-age=3600' } });
  if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'fcm-access' }));
  if (url.startsWith('https://fcm.googleapis.com/')) return new Response(JSON.stringify(fcmStatus === 200 ? { name: 'sent' } : { error: { details: [{ errorCode: 'UNREGISTERED' }] } }), { status: fcmStatus });
  if (url === 'https://api.line.me/v2/bot/message/push') return new Response('{}', { status: lineStatus });
  throw new Error('unexpected fetch ' + url);
};

const { default: worker, __test } = await import('../api/worker.js');
const servicePair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', servicePair.privateKey)).toString('base64');
const env = {
  DB: d1(),
  FIREBASE_CONFIG: JSON.stringify({ apiKey: 'public-key', projectId: PROJECT, appId: 'app', messagingSenderId: '123' }),
  ADMIN_EMAILS: 'Admin@Example.com',
  ALLOWED_ORIGINS: 'https://m0ch4771.github.io',
  LINE_CHANNEL_SECRET: 'line-secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
  PUSH_VAPID_PUBLIC_KEY: 'A'.repeat(87),
  PUSH_SERVICE_ACCOUNT: JSON.stringify({ project_id: PROJECT, client_email: 'svc@example.com', private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n` }),
};
const ORIGIN = 'https://m0ch4771.github.io';
async function call(email, method, ...args) {
  const headers = { origin: ORIGIN, 'content-type': 'application/json' };
  if (email) headers.authorization = 'Bearer ' + (email.startsWith('ey') ? email : await token(email));
  const response = await worker.fetch(new Request('https://api.example/api/rpc', { method: 'POST', headers, body: JSON.stringify({ method, args }) }), env);
  const body = await response.json();
  if (!body.ok) { const e = new Error(body.error); e.status = response.status; throw e; }
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  return body.value;
}
const rejects = (promise, pattern, status) => assert.rejects(promise, e => (pattern.test(e.message) && (!status || e.status === status)) || assert.fail(`${e.status} ${e.message}`));
const day = offset => new Date(Date.now() + offset * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const today = day(0), tomorrow = day(1), yesterday = day(-1), later = day(20);

/* ---------- transport, CORS and authentication ---------- */
{
  const pre = await worker.fetch(new Request('https://api.example/api/rpc', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } }), env);
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  const evil = await worker.fetch(new Request('https://api.example/api/rpc', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{"method":"getAuthConfig"}' }), env);
  assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const config = await call(null, 'getAuthConfig');
  assert.equal(config.ready, true); assert.equal(config.firebase.projectId, PROJECT); assert.ok(!JSON.stringify(config).includes('private'));
  await rejects(call(null, 'getData', 'x'), /ログインの有効期限/, 401);
  await rejects(call(await token('admin@example.com', { aud: 'other-project' }), 'getMembers'), /ログインの有効期限/, 401);
  await rejects(call(await token('admin@example.com', { exp: Math.floor(Date.now() / 1000) - 5 }), 'getMembers'), /ログインの有効期限/, 401);
  const forged = (await token('admin@example.com')).replace(/\.[^.]+$/, '.' + Buffer.from('forged').toString('base64url'));
  await rejects(call(forged, 'getMembers'), /ログインの有効期限/, 401);
  await rejects(call(await token('admin@example.com', { email_verified: false }), 'getMembers'), /確認済み/, 403);
  await rejects(call('stranger@example.com', 'getMembers'), /未登録/, 403);
  await rejects(call('admin@example.com', 'nope'), /未対応/, 404);
  console.log('PASS: CORS allowlist, public config, RS256 signature / audience / expiry / verified-email checks');
}

/* ---------- members (admin screen) ---------- */
const admin = (await call('admin@example.com', 'getMembers'))[0];
assert.ok(admin.id);
const alice = await call('admin@example.com', 'saveMember', { name: 'Alice', email: 'alice@example.com', role: 'member' });
const bob = await call('admin@example.com', 'saveMember', { name: 'Bob', email: 'BOB@example.com' });
assert.equal(bob.email, 'bob@example.com');
await rejects(call('alice@example.com', 'saveMember', { name: 'Eve', email: 'eve@example.com' }), /管理者/, 403);
await rejects(call('alice@example.com', 'listMembers'), /管理者/, 403);
await rejects(call('admin@example.com', 'saveMember', { name: 'Other', email: 'alice@example.com' }), /登録済み/, 409);
await rejects(call('admin@example.com', 'saveMember', { name: ' alice ', email: 'x@example.com' }), /同じ名前/, 409);
await rejects(call('admin@example.com', 'saveMember', { name: 'Ａｌｉｃｅ', email: 'x@example.com' }), /同じ名前/, 409);
await rejects(call('admin@example.com', 'saveMember', { name: 'No mail', email: 'not-an-email' }), /メールアドレス/);
{
  const list = await call('admin@example.com', 'listMembers');
  assert.deepEqual(list.map(m => m.name).sort(), ['Alice', 'Bob', 'admin']);
  assert.equal(list.find(m => m.isMe).role, 'admin');
  const renamed = await call('admin@example.com', 'saveMember', { id: admin.id, name: '管理者', email: 'admin@example.com', role: 'admin', active: true });
  assert.equal(renamed.name, '管理者');
  const carol = await call('admin@example.com', 'saveMember', { name: 'Carol', email: 'carol@example.com' });
  await call('carol@example.com', 'getMembers');
  await call('admin@example.com', 'saveMember', { ...carol, active: false });
  await rejects(call('carol@example.com', 'getMembers'), /未登録/, 403); // stopping a member takes effect immediately
  await call('admin@example.com', 'saveMember', { ...carol, role: 'admin', active: true });
  await rejects(call('carol@example.com', 'saveMember', { id: carol.id, name: 'Carol', email: 'carol@example.com', role: 'member' }), /自分自身/);
  await call('admin@example.com', 'saveMember', { ...carol, role: 'member', active: false });
  assert.equal(typeof (await call('admin@example.com', 'getAdminSettings')).dayTime, 'string');
  await rejects(call('alice@example.com', 'getAdminSettings'), /管理者/, 403);
  console.log('PASS: admin bootstrap from ADMIN_EMAILS, member add/edit/stop, duplicate name/email, admin-only, no self-demotion');
}

/* ---------- events, attendance, tickets ---------- */
const A = alice.id, B = bob.id, fast = { response: 'patch-v1' };
await rejects(call('alice@example.com', 'getData', B), /登録されたメンバーではありません/, 403);
let live = (await call('alice@example.com', 'saveData', A, 'live', { title: 'ライブ', date: later, venue: '会場', groups: ['グループA', 'グループB', 'グループA'] }, fast)).changes.Lives.upsert[0];
assert.deepEqual(live.groups, ['グループA', 'グループB']); assert.equal(live.version, '1'); assert.equal(live.owner, A);
await rejects(call('alice@example.com', 'saveData', A, 'live', { title: '過去', date: yesterday }), /終了済み/);
for (const bad of [{ purchaseUrl: 'javascript:alert(1)' }, { requiredThrows: '-1' }, { lotteryDeadline: '2026-02-30' }, { groups: ['bad,name'] }, { sheetUrl: 'https://example.com' }, { title: '' }])
  await rejects(call('alice@example.com', 'saveData', A, 'live', { ...live, ...bad }), /./);
const edited = (await call('bob@example.com', 'saveData', B, 'live', { ...live, title: '変更', lotteryDeadline: tomorrow, requiredThrows: '3', purchaseUrl: 'https://example.com/t' }, fast)).changes.Lives.upsert[0];
assert.equal(edited.version, '2'); assert.equal(edited.owner, A); assert.equal(edited.requiredThrows, '3');
await rejects(call('alice@example.com', 'saveData', A, 'live', { ...live, title: '古い画面' }), /他の更新/, 409);
live = edited;
// Two edits from the same version at once: exactly one wins, the other is a conflict.
{
  const results = await Promise.allSettled([
    call('alice@example.com', 'saveData', A, 'live', { ...live, title: '同時A' }, fast),
    call('bob@example.com', 'saveData', B, 'live', { ...live, title: '同時B' }, fast),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /他の更新/);
  live = (await call('alice@example.com', 'getData', A)).lives.find(l => l.id === live.id);
  assert.equal(live.version, '3');
}
await call('alice@example.com', 'saveData', A, 'attendance', { liveId: live.id, status: '参戦' });
let att = (await call('alice@example.com', 'getData', A)).attendance.find(a => a.memberId === A);
await rejects(call('alice@example.com', 'saveData', A, 'application', { liveId: live.id, applied: '申込済み' }), /申込状況が更新/, 409);
att = (await call('alice@example.com', 'saveData', A, 'application', { liveId: live.id, applied: '申込済み', version: att.version }, fast)).changes.Attendance.upsert[0];
assert.equal(att.applied, '申込済み');
att = (await call('alice@example.com', 'saveData', A, 'attendance', { liveId: live.id, status: '不参加', version: att.version }, fast)).changes.Attendance.upsert[0];
assert.equal(att.applied, '申込不要');

let added = (await call('alice@example.com', 'saveData', A, 'addTickets', { liveId: live.id, entries: [{ number: 'Ａ１２', status: '余り', ticketUrl: 'https://example.com/a12' }, { number: 'A35', status: '自分用' }, { number: 'x', status: '未発券' }] }, fast)).changes.Tickets.upsert;
assert.deepEqual(added.map(t => t.number), ['A12', 'A35', '']);
await rejects(call('bob@example.com', 'saveData', B, 'addTickets', { liveId: live.id, entries: [{ number: 'a12', status: '余り' }] }), /同じ整理番号/, 409);
await rejects(call('bob@example.com', 'saveData', B, 'addTickets', { liveId: live.id, entries: [{ number: 'Q1', status: '余り' }, { number: 'q1', status: '余り' }] }), /同じ整理番号/);
await rejects(call('bob@example.com', 'saveData', B, 'addTickets', { liveId: live.id, entries: Array(51).fill({ number: '', status: '未発券' }) }), /1〜50枚/);
assert.equal((await call('bob@example.com', 'saveData', B, 'addTickets', { liveId: live.id, entries: Array(50).fill({ number: '', status: '未発券' }) }, fast)).changes.Tickets.upsert.length, 50);
const a12 = added[0];
await rejects(call('bob@example.com', 'saveData', B, 'ticket', { ...a12, status: '捌けた' }), /のみ編集/, 403);
await rejects(call('alice@example.com', 'saveData', A, 'ticket', { ...added[1], number: 'ａ１２' }), /同じ整理番号/, 409);
const updated = (await call('alice@example.com', 'saveData', A, 'ticket', { ...a12, status: '捌けた', recipient: '友人', memo: '連絡済み', ticketUrl: 'https://example.com/mine' }, fast)).changes.Tickets.upsert[0];
assert.equal(updated.version, '2');
{
  const mine = (await call('alice@example.com', 'getData', A)).tickets.find(t => t.id === a12.id);
  const seen = (await call('bob@example.com', 'getData', B)).tickets.find(t => t.id === a12.id);
  assert.equal(mine.ticketUrl, 'https://example.com/mine'); assert.equal(mine.memo, '連絡済み');
  assert.equal(seen.ticketUrl, ''); assert.equal(seen.memo, ''); assert.equal(seen.recipient, ''); assert.equal(seen.number, 'A12');
}
console.log('PASS: events with groups/validation/version conflicts (incl. simultaneous edits), attendance + application, ticket batch with NFKC duplicates, owner-only edits, private ticket fields');

/* ---------- iPhone widget key + read-only widget API ---------- */
{
  const widget = (key, init = {}) => worker.fetch(new Request('https://api.example/api/widget', { headers: key ? { authorization: 'Bearer ' + key } : {}, ...init }), env);
  await rejects(call('alice@example.com', 'getWidgetKey', B), /登録されたメンバーではありません/, 403);
  const { key } = await call('alice@example.com', 'getWidgetKey', A);
  assert.match(key, /^wk_[A-Za-z0-9_-]{43}$/);
  assert.equal((await call('alice@example.com', 'getWidgetKey', A)).key, key, 'same key is returned again for each widget type');
  const bobKey = (await call('bob@example.com', 'getWidgetKey', B)).key;
  assert.notEqual(bobKey, key);
  let res = await widget(key);
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.today, today); assert.equal(body.member.name, 'Alice'); assert.deepEqual(body.groups, ['グループA', 'グループB']);
  const ev = body.events.find(e => e.id === live.id);
  assert.deepEqual({ date: ev.date, deadline: ev.deadline, throws: ev.throws, status: ev.status, applied: ev.applied, own: ev.own, surplus: ev.surplus },
    { date: later, deadline: tomorrow, throws: '3', status: '不参加', applied: '申込不要', own: 1, surplus: 0 });
  const raw = JSON.stringify(body);
  for (const secret of ['A12', 'A35', 'example.com/mine', '連絡済み', '友人', 'alice@example.com', 'Bob', 'sheet']) assert.ok(!raw.includes(secret), 'widget leaks ' + secret);
  // Bob has no attendance row: 未確認. His own 50 unissued tickets are not counted as 自分用/余り.
  const bobEv = (await (await widget(bobKey)).json()).events.find(e => e.id === live.id);
  assert.deepEqual([bobEv.status, bobEv.applied, bobEv.own, bobEv.surplus], ['', '未確認', 0, 0]);
  for (const bad of [null, 'wk_short', key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A')]) {
    res = await widget(bad); assert.equal(res.status, 401); assert.match((await res.json()).error, /キーが無効/);
  }
  assert.equal((await widget(key, { method: 'POST', body: '{}' })).status, 405);
  // Re-issuing invalidates the old key; stopping the member blocks the widget too.
  const fresh = (await call('alice@example.com', 'resetWidgetKey', A)).key;
  assert.notEqual(fresh, key); assert.equal((await widget(key)).status, 401); assert.equal((await widget(fresh)).status, 200);
  await call('admin@example.com', 'saveMember', { id: B, name: 'Bob', email: 'bob@example.com', role: 'member', active: false });
  assert.equal((await widget(bobKey)).status, 401);
  await call('admin@example.com', 'saveMember', { id: B, name: 'Bob', email: 'bob@example.com', role: 'member', active: true });
  assert.equal((await widget(bobKey)).status, 200);
  console.log('PASS: widget key per member (owner-only, stable, re-issue revokes), widget API returns own statuses only, no ticket numbers/URLs/memos/other members');
}

/* ---------- durable save receipts ---------- */
{
  const rid = { response: 'patch-v1', requestId: crypto.randomUUID() };
  const body = { liveId: live.id, entries: [{ number: 'R900', status: '余り' }] };
  const first = await call('alice@example.com', 'saveData', A, 'addTickets', body, rid);
  assert.deepEqual(await call('alice@example.com', 'saveData', A, 'addTickets', body, rid), first);
  await rejects(call('alice@example.com', 'saveData', A, 'addTickets', { ...body, entries: [{ number: 'R901', status: '余り' }] }, rid), /一致しません/, 409);
  await rejects(call('bob@example.com', 'saveData', B, 'addTickets', body, rid), /一致しません/, 409);
  const count = env.DB.raw.prepare("SELECT COUNT(*) n FROM tickets WHERE number = 'R900'").get().n;
  assert.equal(count, 1);
  // A failed save writes neither the change nor the receipt, so it can be retried.
  const failing = { response: 'patch-v1', requestId: crypto.randomUUID() };
  await rejects(call('alice@example.com', 'saveData', A, 'addTickets', { liveId: live.id, entries: [{ number: 'R900', status: '余り' }] }, failing), /同じ整理番号/);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM save_requests WHERE id = ?').get(failing.requestId).n, 0);
  const del = { response: 'patch-v1', requestId: crypto.randomUUID() }, target = first.changes.Tickets.upsert[0];
  await call('alice@example.com', 'saveData', A, 'deleteTicket', target, del);
  assert.deepEqual((await call('alice@example.com', 'saveData', A, 'deleteTicket', target, del)).changes.Tickets.remove, [target.id]);
  console.log('PASS: save receipts replay the same result, reject mismatches, and are written atomically with the change');
}

/* ---------- archive, delete, scheduled jobs ---------- */
{
  env.DB.raw.prepare("INSERT INTO events(id, title, date, version) VALUES('old', '昨日の公演', ?, 1)").run(yesterday);
  const data = await call('alice@example.com', 'getData', A);
  assert.equal(data.lives.find(l => l.id === 'old').archived, true);
  await rejects(call('alice@example.com', 'saveData', A, 'attendance', { liveId: 'old', status: '参戦' }), /終了済み/);
  const temp = (await call('alice@example.com', 'saveData', A, 'live', { title: '削除対象', date: later }, fast)).changes.Lives.upsert[0];
  await call('alice@example.com', 'saveData', A, 'addTickets', { liveId: temp.id, entries: [{ number: 'DEL1', status: '余り' }] });
  const removed = await call('alice@example.com', 'saveData', A, 'deleteLive', temp, fast);
  assert.deepEqual(removed.changes.Lives.remove, [temp.id]);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM tickets WHERE event_id = ?').get(temp.id).n, 1);
  const archived = (await call('bob@example.com', 'saveData', B, 'archiveLive', live, fast)).changes.Lives.upsert[0];
  assert.equal(archived.archived, true);
  live = (await call('bob@example.com', 'saveData', B, 'restoreLive', archived, fast)).changes.Lives.upsert[0];
  assert.equal(live.archived, false);
  env.DB.raw.prepare("INSERT INTO save_requests VALUES('stale', 'm', 'x', '{}', '{}', ?)").run(Date.now() - 31 * 86400000);
  await __test.scheduled(env, new Date());
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM save_requests WHERE id = 'stale'").get().n, 0);
  console.log('PASS: past events archived (data kept), delete keeps tickets, archive/restore, receipt pruning');
}

/* ---------- LINE webhook and deadline notifications ---------- */
async function lineHook(body, secret = 'line-secret') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))).toString('base64');
  return worker.fetch(new Request('https://api.example/', { method: 'POST', headers: { 'x-line-signature': signature }, body: raw }), env);
}
{
  const join = group => ({ events: [{ type: 'join', source: { type: 'group', groupId: group } }] });
  assert.equal((await lineHook(join('Cgroup1'), 'wrong')).status, 401);
  assert.equal((await lineHook(join('Cgroup1'))).status, 200);
  assert.equal((await lineHook(join('Cgroup2'))).status, 200);
  assert.equal(env.DB.raw.prepare("SELECT value FROM settings WHERE key = 'line_group_id'").get().value, 'Cgroup1');

  const due = (await call('alice@example.com', 'saveData', A, 'live', { title: '本日締切の公演', date: later, lotteryDeadline: today, requiredThrows: '2', purchaseUrl: 'https://example.com/due', groups: ['グループA'] }, fast)).changes.Lives.upsert[0];
  await call('alice@example.com', 'saveData', A, 'attendance', { liveId: due.id, status: '参戦' });
  const noon = new Date(today + 'T12:05:00+09:00');
  outbound.length = 0; lineStatus = 503;
  await __test.sendDeadlineNotifications(env, noon);
  const first = outbound.filter(r => r.url.includes('line.me'));
  assert.equal(first.length, 1);
  const retryKey = first[0].init.headers['X-Line-Retry-Key'];
  assert.match(retryKey, /^[0-9a-f-]{36}$/);
  const message = JSON.parse(first[0].init.body);
  assert.equal(message.to, 'Cgroup1');
  assert.match(message.messages[0].text, /本日締切の公演/); assert.match(message.messages[0].text, /枠数：2枚/);
  await __test.sendDeadlineNotifications(env, noon); // waits 15 minutes before retrying
  assert.equal(outbound.filter(r => r.url.includes('line.me')).length, 1);
  lineStatus = 409; // LINE already accepted the earlier request
  await __test.sendDeadlineNotifications(env, new Date(noon.getTime() + 16 * 60000));
  const retries = outbound.filter(r => r.url.includes('line.me'));
  assert.equal(retries.length, 2); assert.equal(retries[1].init.headers['X-Line-Retry-Key'], retryKey);
  await __test.sendDeadlineNotifications(env, new Date(noon.getTime() + 40 * 60000));
  assert.equal(outbound.filter(r => r.url.includes('line.me')).length, 2);
  // Night: list members who have not answered their application status.
  outbound.length = 0; lineStatus = 200;
  await __test.sendDeadlineNotifications(env, new Date(today + 'T21:05:00+09:00'));
  const night = JSON.parse(outbound.find(r => r.url.includes('line.me')).init.body).messages[0].text;
  assert.match(night, /未確認：.*Alice/); assert.match(night, /Bob/);
  assert.match(night, /チケットURL：/); assert.match(night, /枠数：2枚\n未確認：/);

  // Web push: per-device groups, one send per day, unregistered tokens disabled.
  const device = { id: crypto.randomUUID(), secret: 'a'.repeat(64), token: 'fcm:token-1' };
  await rejects(call('alice@example.com', 'savePushSubscription', B, device), /登録されたメンバー/);
  await call('alice@example.com', 'savePushSubscription', A, { ...device, groups: ['グループA'] });
  assert.deepEqual((await call('bob@example.com', 'getPushSettings', device.id, device.secret, true)).selectedGroups, ['グループA']);
  await rejects(call('bob@example.com', 'getPushSettings', device.id, 'b'.repeat(64), true), /一致しません/);
  const other = { id: crypto.randomUUID(), secret: 'c'.repeat(64), token: 'fcm:token-2' };
  await call('bob@example.com', 'savePushSubscription', B, { ...other, groups: ['グループZ'] });
  outbound.length = 0;
  await __test.sendDeadlineNotifications(env, new Date(today + 'T12:30:00+09:00'));
  const pushes = outbound.filter(r => r.url.startsWith('https://fcm.googleapis.com/'));
  assert.equal(pushes.length, 1); assert.equal(JSON.parse(pushes[0].init.body).message.token, 'fcm:token-1');
  assert.match(JSON.parse(pushes[0].init.body).message.data.body, /本日締切の公演／投げ数 2枚/);
  await __test.sendDeadlineNotifications(env, new Date(today + 'T12:35:00+09:00'));
  assert.equal(outbound.filter(r => r.url.startsWith('https://fcm.googleapis.com/')).length, 1);
  await call('alice@example.com', 'savePushSubscription', A, { ...other, id: crypto.randomUUID(), token: 'fcm:token-1' }).catch(() => {});
  fcmStatus = 404;
  await call('bob@example.com', 'savePushSubscription', B, { ...other, groups: null });
  await __test.sendDeadlineNotifications(env, new Date(today + 'T13:00:00+09:00'));
  const stored = JSON.parse(env.DB.raw.prepare('SELECT data FROM push_devices WHERE id = ?').get(other.id).data);
  assert.equal(stored.enabled, false); assert.equal(stored.token, '');
  fcmStatus = 200;
  // Migrated devices keep working: the secret hash matches the GAS encoding (padded web-safe base64).
  assert.equal(await __test.pushIdentity(device.id, device.secret), Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(device.secret))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
  console.log('PASS: LINE webhook signature + fixed group, deadline LINE with retry key/409/backoff, unconfirmed list, Web push groups/dedupe/unregistered');
}

/* ---------- one-time import from the spreadsheet export ---------- */
{
  const exportFile = {
    format: 'ticket-management-export', version: 1,
    members: [
      { id: 'm-1', name: '旧メンバー', email: 'old@example.com', role: 'member', active: 'yes' },
      { id: 'm-2', name: '管理者', email: 'admin@example.com', role: 'admin', active: 'yes' },
      { id: 'm-3', name: '停止中', email: 'stopped@example.com', role: 'member', active: '' },
      { id: 'm-4', name: 'メールなし1', email: '', role: 'member', active: 'yes' },
      { id: 'm-5', name: 'メールなし2', email: '', role: 'member', active: 'yes' },
    ],
    lives: [
      { id: 'l-1', title: '移行イベント', date: later, venue: '会場', version: '4', lotteryDeadline: tomorrow, requiredThrows: '2', groups: '["G1"]', archived: '' },
      { id: 'l-2', title: '過去', date: '2025/1/10', version: '1', archived: 'yes' },
      { id: '', title: 'IDなし', date: later },
    ],
    attendance: [{ id: 'a-1', liveId: 'l-1', memberId: 'm-1', status: '参戦', applied: '申込済み', version: '2' },
      { id: 'a-2', liveId: 'deleted-event', memberId: 'm-4', status: '参戦', applied: '', version: '1' }],
    tickets: [{ id: 't-0', liveId: 'deleted-event', memberId: 'm-5', number: '12(さやか)', status: '捌けた', version: '1' },
      { id: 't-1', liveId: 'l-1', memberId: 'm-1', number: 'A1', status: '余り', ticketUrl: 'https://example.com/t1', version: '3' },
      { id: 't-2', liveId: 'l-1', memberId: 'm-1', number: 'a1', status: '自分用', version: '1' }],
    settings: { line_day_time: '11:00', line_night_time: '20:00', line_day_mode: 'all', line_night_mode: 'unconfirmed' },
    devices: [{ id: crypto.randomUUID(), hash: 'h', token: 'fcm:x', enabled: true, groups: null }],
  };
  await rejects(call('alice@example.com', 'importData', exportFile), /管理者/, 403);
  await rejects(call('admin@example.com', 'importData', { format: 'other' }), /形式/);
  await rejects(call('admin@example.com', 'importData', exportFile), /すでにデータ/, 409);
  const result = await call('admin@example.com', 'importData', exportFile, { replace: true });
  assert.deepEqual(result, { members: 5, lives: 2, attendance: 2, tickets: 3, devices: 1 });
  const listed = await call('admin@example.com', 'listMembers');
  assert.deepEqual(listed.filter(m => !m.email).map(m => m.name).sort(), ['メールなし1', 'メールなし2']);
  // A member without an account can be given one later from the admin screen.
  await call('admin@example.com', 'saveMember', { id: 'm-4', name: 'メールなし1', email: 'later@example.com', role: 'member', active: true });
  assert.equal((await call('later@example.com', 'getMembers'))[0].id, 'm-4');
  // The importer is now the imported admin row; the old ID no longer matches, so the app signs in again.
  const me = (await call('admin@example.com', 'getMembers'))[0];
  assert.equal(me.id, 'm-2');
  await rejects(call('old@example.com', 'getData', 'wrong'), /登録されたメンバー/);
  const data = await call('old@example.com', 'getData', 'm-1');
  assert.equal(data.lives.find(l => l.id === 'l-1').version, '4');
  assert.equal(data.lives.find(l => l.id === 'l-2').archived, true);
  assert.equal(data.tickets.find(t => t.id === 't-1').ticketUrl, 'https://example.com/t1');
  assert.equal(data.attendance.find(a => a.id === 'a-1').applied, '申込済み');
  assert.ok(data.attendance.some(a => a.id === 'a-2')); assert.equal(data.tickets.find(t => t.id === 't-0').number, '12(さやか)');
  await rejects(call('stopped@example.com', 'getMembers'), /未登録/);
  assert.equal((await call('admin@example.com', 'getAdminSettings')).dayTime, '11:00');
  console.log('PASS: spreadsheet import (admin-only, explicit replace, keeps IDs/versions/archive, duplicate numbers tolerated, settings and devices)');
}
