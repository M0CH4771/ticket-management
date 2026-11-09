/* Ticket Management API — Cloudflare Worker + D1.
 *
 * Replaces the Google Apps Script + spreadsheet backend. One file, no npm
 * dependencies, so it can be pasted into the Cloudflare dashboard editor.
 *
 *   POST /api/rpc          JSON {method, args}; Authorization: Bearer <Firebase ID token>
 *   POST /  (LINE header)  LINE webhook: stores the group ID when the bot joins a group
 *   cron "*\/5 * * * *"    archives past events, prunes old save receipts, sends deadline LINE/Web push
 *
 * Bindings / variables (see README):
 *   DB                      D1 database
 *   FIREBASE_CONFIG         JSON {apiKey, projectId, appId, messagingSenderId[, authDomain]}
 *   ADMIN_EMAILS            comma-separated Google accounts that are always admins
 *   ALLOWED_ORIGINS         comma-separated site origins (default https://m0ch4771.github.io)
 *   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN        (secrets, optional)
 *   PUSH_VAPID_PUBLIC_KEY, PUSH_SERVICE_ACCOUNT (secret)  (optional Web push)
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'member', active INTEGER NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, venue TEXT NOT NULL DEFAULT '', sheet_url TEXT NOT NULL DEFAULT '', memo TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, lottery_deadline TEXT NOT NULL DEFAULT '', required_throws TEXT NOT NULL DEFAULT '', purchase_url TEXT NOT NULL DEFAULT '', groups TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS attendance (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, member_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', applied TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, UNIQUE(event_id, member_id));
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, member_id TEXT NOT NULL, number TEXT NOT NULL DEFAULT '', number_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, recipient TEXT NOT NULL DEFAULT '', memo TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, ticket_url TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS tickets_number ON tickets(event_id, number_key) WHERE number_key <> '';
CREATE INDEX IF NOT EXISTS tickets_event ON tickets(event_id);
CREATE INDEX IF NOT EXISTS events_date ON events(date);
CREATE TABLE IF NOT EXISTS save_requests (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_devices (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS guards (ok INTEGER NOT NULL CHECK (ok = 1));
`;

const TICKET_STATUSES = ['未発券', '自分用', '余り', '取引中', '捌けた'];
const UUID = /^[a-f0-9-]{36}$/;

class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/* ---------- small helpers ---------- */
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const uuid = () => crypto.randomUUID();
const japanToday = (now = new Date()) => now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const japanTime = (now = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(p => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
};
const b64urlToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const bytesToB64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytesToB64urlPadded = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_');
const textToB64url = s => bytesToB64url(new TextEncoder().encode(s));

function text(value, max, required) {
  const s = String(value == null ? '' : value).trim();
  if ((required && !s) || s.length > max) throw new AppError('入力内容・文字数を確認してください');
  return s;
}
function normalizeDate(value, year) {
  const s = String(value ?? '').normalize('NFKC').trim();
  const full = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/), short = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!full && !short) return '';
  const y = full ? Number(full[1]) : Number(year), m = Number(full ? full[2] : short[1]), d = Number(full ? full[3] : short[2]);
  if (!Number.isInteger(y) || y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : '';
}
function deadline(value) {
  const s = text(value, 10, false);
  if (s && (!/^\d{4}-\d{2}-\d{2}$/.test(s) || normalizeDate(s) !== s)) throw new AppError('抽選締切日を確認してください');
  return s;
}
function httpUrl(value, message = 'チケット購入ページURLはhttpまたはhttpsのURLで入力してください') {
  const s = text(value, 2000, false);
  if (s && !/^https?:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?(?:[/?#][^\s<>]*)?$/.test(s)) throw new AppError(message);
  return s;
}
function throwsCount(value) {
  const s = text(value, 16, false);
  if (s === '') return '';
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) throw new AppError('必要投げ数は0以上の整数で入力してください');
  return String(Number(s));
}
function oneOf(value, values) { if (!values.includes(value)) throw new AppError('選択値が無効です'); return value; }
function readGroups(value) {
  if (Array.isArray(value)) return value.filter(x => typeof x === 'string');
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : []; } catch { return []; }
}
function validateGroups(value) {
  if (!Array.isArray(value) || value.length > 20) throw new AppError('出演グループは20組まで選択できます');
  const names = value.map(v => text(v, 40, true).normalize('NFKC').replace(/\s+/g, ' '));
  if (names.some(n => /[,、\n\r]/.test(n))) throw new AppError('グループ名にカンマ・改行は使えません');
  return [...new Map(names.map(n => [n.toLowerCase(), n])).values()];
}
function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
const normalizedName = name => String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const ticketKey = number => String(number || '').normalize('NFKC').trim().toUpperCase();

/* ---------- row <-> API shapes (same keys the old GAS API returned) ---------- */
const liveOut = r => ({ id: r.id, title: r.title, date: r.date, venue: r.venue, sheetUrl: r.sheet_url, memo: r.memo, owner: r.owner, version: String(r.version),
  lotteryDeadline: r.lottery_deadline, requiredThrows: r.required_throws, purchaseUrl: r.purchase_url, groups: readGroups(r.groups), archived: !!r.archived });
const attendanceOut = r => ({ id: r.id, liveId: r.event_id, memberId: r.member_id, status: r.status, version: String(r.version), applied: r.status === '不参加' ? '申込不要' : r.applied });
const ticketOut = r => ({ id: r.id, liveId: r.event_id, memberId: r.member_id, number: r.number, status: r.status, recipient: r.recipient, memo: r.memo, version: String(r.version), ticketUrl: r.ticket_url });
// Personal ticket URLs, memos and recipients are visible only to the ticket owner.
const publicTicket = (t, me) => t.memberId === me.id ? t : { ...t, ticketUrl: '', memo: '', recipient: '' };

/* ---------- database ---------- */
let schemaReady = null;
function ensureSchema(env) {
  if (!env.DB) throw new AppError('データベース（D1）が設定されていません', 500);
  // D1's exec() runs one statement per line, so every statement in SCHEMA stays on a single line.
  if (!schemaReady) schemaReady = env.DB.exec(SCHEMA.trim()).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}
const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results || [];
const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
// A statement that aborts the surrounding batch (transaction) unless `condition` holds.
const guard = (db, condition, ...params) => db.prepare(`INSERT INTO guards(ok) SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END`).bind(...params);
async function commit(db, statements, conflictMessage = '他の更新がありました。再読込してください') {
  try {
    await db.batch([...statements, db.prepare('DELETE FROM guards')]);
  } catch (e) {
    const message = String(e?.message || e);
    if (/CHECK constraint failed/i.test(message)) throw new AppError(conflictMessage, 409);
    if (/UNIQUE constraint failed: tickets/i.test(message)) throw new AppError('このライブに同じ整理番号が登録されています。券種が異なる場合は「VIP-A12」などにしてください', 409);
    if (/UNIQUE constraint failed: members\.email/i.test(message)) throw new AppError('このGoogleアカウントは登録済みです', 409);
    if (/UNIQUE constraint failed/i.test(message)) throw new AppError(conflictMessage, 409);
    throw e;
  }
}
async function getSettings(db, keys) {
  const rows = await all(db, `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`, ...keys);
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
const putSetting = (db, key, value) => db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));

/* ---------- Firebase ID token verification (RS256 against Google's public keys) ---------- */
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks = { keys: [], expires: 0 };
const keyCache = new Map();
async function loadJwks(force = false) {
  if (!force && jwks.keys.length && Date.now() < jwks.expires) return jwks.keys;
  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new AppError('ログインを確認できません。少し待って再度お試しください', 503);
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1] || 3600);
  const body = await response.json();
  jwks = { keys: body.keys || [], expires: Date.now() + Math.min(maxAge, 21600) * 1000 };
  keyCache.clear();
  return jwks.keys;
}
function firebaseConfig(env) {
  let config = env.FIREBASE_CONFIG;
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch { config = null; } }
  if (!config?.apiKey || !config?.projectId || !config?.appId || !config?.messagingSenderId) return null;
  return { apiKey: config.apiKey, projectId: config.projectId, appId: config.appId, messagingSenderId: config.messagingSenderId, authDomain: config.authDomain || config.projectId + '.firebaseapp.com' };
}
async function verifyIdToken(token, env) {
  const expired = () => new AppError('ログインの有効期限が切れました。再度ログインしてください', 401);
  if (typeof token !== 'string' || token.length < 100 || token.length > 5000) throw expired();
  const config = firebaseConfig(env);
  if (!config) throw new AppError('Firebase Authenticationの設定が必要です', 500);
  const parts = token.split('.');
  if (parts.length !== 3) throw expired();
  let header, payload;
  try { header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))); payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))); } catch { throw expired(); }
  if (header.alg !== 'RS256' || !header.kid) throw expired();
  let keys = await loadJwks();
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { keys = await loadJwks(true); jwk = keys.find(k => k.kid === header.kid); }
  if (!jwk) throw expired();
  let key = keyCache.get(header.kid);
  if (!key) { key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']); keyCache.set(header.kid, key); }
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  const now = Math.floor(Date.now() / 1000);
  if (!valid || payload.aud !== config.projectId || payload.iss !== 'https://securetoken.google.com/' + config.projectId ||
      typeof payload.sub !== 'string' || !payload.sub || !(payload.exp > now) || !(payload.iat <= now + 300)) throw expired();
  if (payload.email_verified !== true) throw new AppError('確認済みのGoogleアカウントでログインしてください', 403);
  const email = normalizeEmail(payload.email);
  if (!email) throw new AppError('Googleアカウントのメールアドレスを取得できませんでした', 403);
  return email;
}
const adminEmails = env => new Set(String(env.ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean));
async function memberFor(email, env) {
  const db = env.DB, admins = adminEmails(env);
  let member = await first(db, 'SELECT * FROM members WHERE email = ?', email);
  if (!member && admins.has(email)) {
    // Bootstrap: an address in ADMIN_EMAILS becomes an admin member on first sign-in.
    const name = email.split('@')[0].slice(0, 40) || '管理者';
    await db.prepare('INSERT OR IGNORE INTO members(id, name, email, role, active, created_at) VALUES(?, ?, ?, ?, 1, ?)').bind(uuid(), name, email, 'admin', new Date().toISOString()).run();
    member = await first(db, 'SELECT * FROM members WHERE email = ?', email);
  }
  if (!member || member.active !== 1) throw new AppError('このGoogleアカウントは未登録です。管理者にメンバー登録を依頼してください', 403);
  return { id: member.id, name: member.name, email: member.email, role: admins.has(email) ? 'admin' : member.role };
}
const sameMember = (me, memberId) => {
  if (typeof memberId !== 'string' || memberId !== me.id) throw new AppError('このGoogleアカウントに登録されたメンバーではありません', 403);
};
const requireAdmin = (me, message = '管理者のみ実行できます') => { if (me.role !== 'admin') throw new AppError(message, 403); };

/* ---------- data ---------- */
async function archivePastEvents(db, today = japanToday()) {
  // Past events stay in the database (with their attendance and tickets) and move to the archive.
  await db.prepare('UPDATE events SET archived = 1 WHERE archived = 0 AND date < ?').bind(today).run();
}
async function snapshot(db, me) {
  const [lives, attendance, tickets, members] = await Promise.all([
    all(db, 'SELECT * FROM events ORDER BY date, title'),
    all(db, 'SELECT * FROM attendance'),
    all(db, 'SELECT * FROM tickets'),
    all(db, 'SELECT id, name FROM members WHERE active = 1 ORDER BY created_at, name'),
  ]);
  const liveRows = lives.map(liveOut);
  return {
    me: { id: me.id, name: me.name, isAdmin: me.role === 'admin' },
    members: members.map(m => ({ id: m.id, name: m.name })),
    lives: liveRows,
    groups: [...new Set(liveRows.flatMap(l => l.groups))].sort((a, b) => a.localeCompare(b, 'ja')),
    attendance: attendance.map(attendanceOut),
    tickets: tickets.map(ticketOut).map(t => publicTicket(t, me)),
    capabilities: { durableSave: true },
    updatedAt: new Date().toISOString(),
  };
}

async function saveData(ctx, memberId, action, payload, options) {
  const { db, me } = ctx;
  sameMember(me, memberId);
  const p = payload && typeof payload === 'object' ? payload : {};
  const body = JSON.stringify(p);
  if (body.length > 20000) throw new AppError('一度に送信する内容が大きすぎます');
  const requestId = options?.requestId ? String(options.requestId) : '';
  if (requestId) {
    if (!UUID.test(requestId)) throw new AppError('保存リクエストが不正です');
    const receipt = await first(db, 'SELECT * FROM save_requests WHERE id = ?', requestId);
    if (receipt) {
      if (receipt.member_id !== me.id || receipt.action !== action || receipt.payload !== body) throw new AppError('保存リクエストが一致しません', 409);
      const stored = JSON.parse(receipt.result);
      return options?.response === 'patch-v1' ? stored : snapshot(db, me);
    }
  }
  const today = japanToday(), year = Number(today.slice(0, 4));
  const changes = {}, statements = [];
  const upsert = (table, row) => { (changes[table] ||= { upsert: [], remove: [] }).upsert.push(row); };
  const remove = (table, id) => { (changes[table] ||= { upsert: [], remove: [] }).remove.push(id); };
  let conflict = '他の更新がありました。再読込してください';

  if (action === 'live') {
    const old = p.id ? await first(db, 'SELECT * FROM events WHERE id = ?', String(p.id)) : null;
    if (p.id && !old) throw new AppError('ライブが見つかりません', 404);
    if (old && String(p.version) !== String(old.version)) throw new AppError(conflict, 409);
    const date = normalizeDate(p.date, year);
    if (!date) throw new AppError('日付を確認してください');
    if (date < today) throw new AppError('終了済みのイベントは登録できません');
    const sheetUrl = text(p.sheetUrl, 600, false);
    if (sheetUrl && !/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+(?:[/?#].*)?$/.test(sheetUrl)) throw new AppError('スプレッドシートURLを確認してください');
    const ownerValid = old?.owner ? await first(db, 'SELECT id FROM members WHERE id = ? AND active = 1', old.owner) : null;
    const row = {
      id: old ? old.id : uuid(), title: text(p.title, 120, true), date, venue: text(p.venue, 120, false), sheet_url: sheetUrl, memo: text(p.memo, 500, false),
      owner: ownerValid ? old.owner : me.id, version: old ? old.version + 1 : 1,
      lottery_deadline: deadline(p.lotteryDeadline === undefined ? old?.lottery_deadline : p.lotteryDeadline),
      required_throws: throwsCount(p.requiredThrows === undefined ? old?.required_throws : p.requiredThrows),
      purchase_url: httpUrl(p.purchaseUrl === undefined ? old?.purchase_url : p.purchaseUrl),
      groups: JSON.stringify(validateGroups(p.groups === undefined ? readGroups(old?.groups) : p.groups)),
      archived: old?.archived || 0,
    };
    if (old) statements.push(guard(db, '(SELECT version FROM events WHERE id = ?) = ?', old.id, old.version));
    statements.push(db.prepare(`INSERT INTO events(id, title, date, venue, sheet_url, memo, owner, version, lottery_deadline, required_throws, purchase_url, groups, archived)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, date = excluded.date, venue = excluded.venue, sheet_url = excluded.sheet_url,
      memo = excluded.memo, owner = excluded.owner, version = excluded.version, lottery_deadline = excluded.lottery_deadline, required_throws = excluded.required_throws,
      purchase_url = excluded.purchase_url, groups = excluded.groups, archived = excluded.archived`)
      .bind(row.id, row.title, row.date, row.venue, row.sheet_url, row.memo, row.owner, row.version, row.lottery_deadline, row.required_throws, row.purchase_url, row.groups, row.archived));
    upsert('Lives', liveOut(row));
  } else if (action === 'archiveLive' || action === 'restoreLive' || action === 'deleteLive') {
    const live = await first(db, 'SELECT * FROM events WHERE id = ?', String(p.id || ''));
    if (!live) throw new AppError(action === 'deleteLive' ? 'ライブが見つかりません' : 'イベントが見つかりません', 404);
    if (String(p.version) !== String(live.version)) throw new AppError(conflict, 409);
    statements.push(guard(db, '(SELECT version FROM events WHERE id = ?) = ?', live.id, live.version));
    if (action === 'deleteLive') {
      // Attendance and ticket rows are kept, as before.
      statements.push(db.prepare('DELETE FROM events WHERE id = ?').bind(live.id));
      remove('Lives', live.id);
    } else {
      const row = { ...live, archived: action === 'archiveLive' ? 1 : 0, version: live.version + 1 };
      statements.push(db.prepare('UPDATE events SET archived = ?, version = ? WHERE id = ?').bind(row.archived, row.version, live.id));
      upsert('Lives', liveOut(row));
    }
  } else {
    const live = await first(db, 'SELECT * FROM events WHERE id = ?', String(p.liveId || ''));
    if (!live) throw new AppError('ライブが見つかりません', 404);
    if (live.date < today) throw new AppError('終了済みまたは日付が不正なイベントです。再読込してください');
    if (action === 'attendance' || action === 'application') {
      const old = await first(db, 'SELECT * FROM attendance WHERE event_id = ? AND member_id = ?', live.id, me.id);
      if (old && String(p.version) !== String(old.version)) throw new AppError(action === 'application' ? '申込状況が更新されています。再読込してください' : conflict, 409);
      if (action === 'application') conflict = '申込状況が更新されています。再読込してください';
      let status = old?.status || '', applied;
      if (action === 'attendance') {
        status = oneOf(p.status, ['参戦', '未定', '不参加']);
        applied = status === '不参加' ? '申込不要' : old?.status === '不参加' ? '' : old?.applied || '';
      } else {
        const selected = oneOf(p.applied, ['申込済み', '申込不要', '未確認', '未申込']);
        applied = old?.status === '不参加' ? '申込不要' : selected === '未確認' ? '' : selected;
      }
      const row = { id: old ? old.id : uuid(), event_id: live.id, member_id: me.id, status, applied, version: old ? old.version + 1 : 1 };
      if (old) {
        statements.push(guard(db, '(SELECT version FROM attendance WHERE id = ?) = ?', old.id, old.version));
        statements.push(db.prepare('UPDATE attendance SET status = ?, applied = ?, version = ? WHERE id = ?').bind(row.status, row.applied, row.version, row.id));
      } else {
        statements.push(db.prepare('INSERT INTO attendance(id, event_id, member_id, status, applied, version) VALUES(?, ?, ?, ?, ?, 1)').bind(row.id, row.event_id, row.member_id, row.status, row.applied));
      }
      upsert('Attendance', attendanceOut(row));
    } else if (action === 'addTickets') {
      // Accept the old uniform-status payload as well as per-ticket entries.
      const input = p.entries !== undefined ? p.entries : (Array.isArray(p.numbers) ? p.numbers.map(number => ({ number, status: p.status })) : null);
      if (!Array.isArray(input) || input.length < 1 || input.length > 50) throw new AppError('1回に1〜50枚まで登録できます');
      const rows = input.map(entry => {
        if (!entry || typeof entry !== 'object') throw new AppError('チケットの入力内容を確認してください');
        const status = oneOf(entry.status, TICKET_STATUSES);
        const number = status === '未発券' ? '' : text(String(entry.number ?? '').normalize('NFKC'), 30, true);
        return { id: uuid(), event_id: live.id, member_id: me.id, number, number_key: ticketKey(number), status, recipient: '', memo: '', version: 1, ticket_url: httpUrl(entry.ticketUrl) };
      });
      const keys = rows.map(r => r.number_key).filter(Boolean);
      const existing = new Set((await all(db, "SELECT number_key FROM tickets WHERE event_id = ? AND number_key <> ''", live.id)).map(r => r.number_key));
      if (new Set(keys).size !== keys.length || keys.some(k => existing.has(k))) throw new AppError('このライブに同じ整理番号が登録されています。券種が異なる場合は「VIP-A12」などにしてください', 409);
      // One statement for all rows: the payload travels as a single JSON parameter.
      statements.push(db.prepare(`INSERT INTO tickets(id, event_id, member_id, number, number_key, status, recipient, memo, version, ticket_url)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.event_id'), json_extract(value, '$.member_id'), json_extract(value, '$.number'), json_extract(value, '$.number_key'),
               json_extract(value, '$.status'), '', '', 1, json_extract(value, '$.ticket_url') FROM json_each(?)`).bind(JSON.stringify(rows)));
      rows.forEach(r => upsert('Tickets', ticketOut(r)));
    } else if (action === 'ticket' || action === 'deleteTicket') {
      const old = await first(db, 'SELECT * FROM tickets WHERE id = ? AND event_id = ?', String(p.id || ''), live.id);
      if (!old || old.member_id !== me.id) throw new AppError('選択中の名前のチケットのみ編集できます', 403);
      if (String(p.version) !== String(old.version)) throw new AppError(conflict, 409);
      statements.push(guard(db, '(SELECT version FROM tickets WHERE id = ?) = ?', old.id, old.version));
      if (action === 'deleteTicket') {
        statements.push(db.prepare('DELETE FROM tickets WHERE id = ?').bind(old.id));
        remove('Tickets', old.id);
      } else {
        const status = oneOf(p.status, TICKET_STATUSES);
        const number = text(String(p.number ?? '').normalize('NFKC'), 30, status !== '未発券');
        if (number && await first(db, 'SELECT id FROM tickets WHERE event_id = ? AND id <> ? AND number_key = ?', live.id, old.id, ticketKey(number))) throw new AppError('同じ整理番号が登録されています', 409);
        const row = { ...old, number, number_key: ticketKey(number), status, recipient: text(p.recipient, 80, false), memo: text(p.memo, 500, false), version: old.version + 1, ticket_url: httpUrl(p.ticketUrl) };
        statements.push(db.prepare('UPDATE tickets SET number = ?, number_key = ?, status = ?, recipient = ?, memo = ?, version = ?, ticket_url = ? WHERE id = ?')
          .bind(row.number, row.number_key, row.status, row.recipient, row.memo, row.version, row.ticket_url, row.id));
        upsert('Tickets', ticketOut(row));
      }
    } else throw new AppError('操作が無効です');
  }
  const result = { kind: 'patch-v1', changes, savedAt: new Date().toISOString() };
  // The receipt is written in the same transaction as the change: a retried request
  // either finds the receipt (and gets the same answer) or nothing was written at all.
  if (requestId) statements.push(db.prepare('INSERT INTO save_requests(id, member_id, action, payload, result, created_at) VALUES(?, ?, ?, ?, ?, ?)').bind(requestId, me.id, action, body, JSON.stringify(result), Date.now()));
  await commit(db, statements, conflict);
  return options?.response === 'patch-v1' ? result : snapshot(db, me);
}

/* ---------- admin: members, LINE settings, import ---------- */
async function listMembers({ db, me }) {
  requireAdmin(me);
  return (await all(db, 'SELECT id, name, email, role, active FROM members ORDER BY active DESC, created_at, name'))
    .map(m => ({ id: m.id, name: m.name, email: m.email || '', role: m.role, active: m.active === 1, isMe: m.id === me.id }));
}
async function saveMember({ db, me, env }, input) {
  requireAdmin(me, 'メンバー登録は管理者のみ実行できます');
  const m = input && typeof input === 'object' ? input : {};
  const name = text(m.name, 40, true).normalize('NFKC').replace(/\s+/g, ' ');
  const email = normalizeEmail(m.email);
  if (!email) throw new AppError('Googleアカウントのメールアドレスを入力してください');
  const role = oneOf(m.role || 'member', ['admin', 'member']);
  const active = m.active === false ? 0 : 1;
  const old = m.id ? await first(db, 'SELECT * FROM members WHERE id = ?', String(m.id)) : null;
  if (m.id && !old) throw new AppError('メンバーが見つかりません', 404);
  const others = await all(db, 'SELECT id, name, email, role, active FROM members WHERE id <> ?', old?.id || '');
  if (others.some(o => o.active === 1 && active === 1 && normalizedName(o.name) === normalizedName(name))) throw new AppError('同じ名前のメンバーが登録されています', 409);
  if (others.some(o => o.email === email)) throw new AppError('このGoogleアカウントは登録済みです', 409);
  if (old?.id === me.id && (role !== 'admin' || !active) && !adminEmails(env).has(email)) throw new AppError('自分自身の管理者権限・利用状態は変更できません');
  const id = old ? old.id : uuid();
  await commit(db, [db.prepare(`INSERT INTO members(id, name, email, role, active, created_at) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, role = excluded.role, active = excluded.active`)
    .bind(id, name, email, role, active, old?.created_at || new Date().toISOString())]);
  return { id, name, email, role, active: active === 1 };
}
// Old GAS-compatible call kept for any cached page that still uses it.
const registerMember = (ctx, name, email) => saveMember(ctx, { name, email, role: 'member' }).then(m => ({ id: m.id, name: m.name }));

const LINE_DEFAULTS = { line_day_time: '12:00', line_night_time: '21:00', line_day_mode: 'all', line_night_mode: 'unconfirmed' };
async function adminSettings(db) {
  const s = await getSettings(db, Object.keys(LINE_DEFAULTS));
  return { dayTime: s.line_day_time || LINE_DEFAULTS.line_day_time, nightTime: s.line_night_time || LINE_DEFAULTS.line_night_time,
    dayMode: s.line_day_mode || LINE_DEFAULTS.line_day_mode, nightMode: s.line_night_mode || LINE_DEFAULTS.line_night_mode };
}
async function getAdminSettings({ db, me }) { requireAdmin(me, '管理者のみ設定を確認できます'); return adminSettings(db); }
async function saveAdminSettings({ db, me }, settings) {
  requireAdmin(me, '管理者のみ設定を変更できます');
  const s = settings || {};
  const time = value => {
    const t = String(value || '');
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(t) || Number(t.slice(3)) % 5 !== 0) throw new AppError('配信時刻は5分単位で設定してください');
    return t;
  };
  const dayTime = time(s.dayTime), nightTime = time(s.nightTime);
  const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  if (minutes(nightTime) - minutes(dayTime) < 60) throw new AppError('昼の配信時刻は夜より1時間以上前に設定してください');
  const mode = value => { if (!['all', 'unconfirmed'].includes(value)) throw new AppError('通知内容を選択してください'); return value; };
  const values = { line_day_time: dayTime, line_night_time: nightTime, line_day_mode: mode(s.dayMode), line_night_mode: mode(s.nightMode) };
  await db.batch(Object.entries(values).map(([k, v]) => putSetting(db, k, v)));
  return adminSettings(db);
}

// One-time move from the spreadsheet: the JSON written by exportForMigration() in Code.gs.
async function importData({ db, me, env }, data, options) {
  requireAdmin(me);
  if (!data || data.format !== 'ticket-management-export' || data.version !== 1) throw new AppError('移行ファイルの形式が違います。Code.gsのexportForMigrationで書き出したファイルを選んでください');
  const existing = await first(db, 'SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM tickets) AS n');
  if (existing.n > 0 && options?.replace !== true) throw new AppError('すでにデータがあります。置き換える場合は確認してから実行してください', 409);
  const list = value => Array.isArray(value) ? value : [];
  const year = Number(japanToday().slice(0, 4));
  const members = new Map();
  for (const m of list(data.members)) {
    const email = normalizeEmail(m.email), id = String(m.id || '');
    if (!UUID.test(id) && !/^[\w-]{1,64}$/.test(id)) continue;
    if (!String(m.name || '').trim()) continue;
    // Members without a Google account are kept as they are (they cannot sign in until an email is set).
    members.set(id, { id, name: String(m.name).trim().slice(0, 40), email: email || null, role: m.role === 'admin' ? 'admin' : 'member',
      active: String(m.active) === 'yes' || m.active === true ? 1 : 0, created_at: new Date().toISOString() });
  }
  // Keep the person running the import signed in, even if the sheet had no email for them.
  if (![...members.values()].some(m => m.email === me.email)) members.set(me.id, { id: me.id, name: me.name, email: me.email, role: 'admin', active: 1, created_at: new Date().toISOString() });
  const seenEmail = new Set();
  for (const [id, m] of members) { if (!m.email) continue; if (seenEmail.has(m.email)) members.delete(id); else seenEmail.add(m.email); }
  const events = list(data.lives).map(l => {
    const date = normalizeDate(l.date, year);
    if (!l.id || !String(l.title || '').trim() || !date) return null;
    return { id: String(l.id), title: String(l.title).trim().slice(0, 120), date, venue: String(l.venue || '').slice(0, 120), sheet_url: String(l.sheetUrl || '').slice(0, 600),
      memo: String(l.memo || '').slice(0, 500), owner: String(l.owner || ''), version: Math.max(1, Number(l.version) || 1),
      lottery_deadline: normalizeDate(l.lotteryDeadline, Number(date.slice(0, 4))) || '', required_throws: /^\d+$/.test(String(l.requiredThrows ?? '')) ? String(Number(l.requiredThrows)) : '',
      purchase_url: String(l.purchaseUrl || '').slice(0, 2000), groups: JSON.stringify(readGroups(l.groups)), archived: String(l.archived) === 'yes' || l.archived === true ? 1 : 0 };
  }).filter(Boolean);
  const eventIds = new Set(events.map(e => e.id));
  const attendanceSeen = new Set();
  // Every row moves as it is, including rows of events deleted earlier (the app keeps those too).
  const attendance = list(data.attendance).filter(a => a.id && a.liveId && a.memberId).map(a => ({
    id: String(a.id), event_id: String(a.liveId), member_id: String(a.memberId), status: ['参戦', '未定', '不参加'].includes(a.status) ? a.status : '',
    applied: ['申込済み', '申込不要', '未申込'].includes(a.applied) ? a.applied : '', version: Math.max(1, Number(a.version) || 1),
  })).filter(a => { const k = a.event_id + '|' + a.member_id; if (attendanceSeen.has(k)) return false; attendanceSeen.add(k); return true; });
  const numberSeen = new Set();
  const tickets = list(data.tickets).filter(t => t.id && t.liveId && t.memberId && TICKET_STATUSES.includes(t.status)).map(t => {
    const number = String(t.number || '').normalize('NFKC').trim().slice(0, 30);
    return { id: String(t.id), event_id: String(t.liveId), member_id: String(t.memberId), number, number_key: ticketKey(number), status: t.status,
      recipient: String(t.recipient || '').slice(0, 80), memo: String(t.memo || '').slice(0, 500), version: Math.max(1, Number(t.version) || 1), ticket_url: String(t.ticketUrl || '').slice(0, 2000) };
  }).map(t => { const k = t.event_id + '|' + t.number_key; if (t.number_key && numberSeen.has(k)) t.number_key = ''; else if (t.number_key) numberSeen.add(k); return t; });
  const devices = list(data.devices).filter(d => d && UUID.test(String(d.id || '')) && typeof d.hash === 'string').map(d => ({ id: String(d.id), data: JSON.stringify({ ...d, id: undefined }) }));
  const settings = Object.entries(data.settings || {}).filter(([k, v]) => ['line_day_time', 'line_night_time', 'line_day_mode', 'line_night_mode', 'line_group_id'].includes(k) && typeof v === 'string' && v);

  // Large tables travel as JSON parameters in chunks so every statement stays within D1 limits.
  const chunks = (rows, size = 400) => { const out = []; for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size)); return out; };
  const insertJson = (table, columns, rows) => chunks(rows).map(part => db.prepare(
    `INSERT INTO ${table}(${columns.join(', ')}) SELECT ${columns.map(c => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?)`).bind(JSON.stringify(part)));
  const statements = [
    db.prepare('DELETE FROM tickets'), db.prepare('DELETE FROM attendance'), db.prepare('DELETE FROM events'), db.prepare('DELETE FROM members'), db.prepare('DELETE FROM save_requests'),
    ...insertJson('members', ['id', 'name', 'email', 'role', 'active', 'created_at'], [...members.values()]),
    ...insertJson('events', ['id', 'title', 'date', 'venue', 'sheet_url', 'memo', 'owner', 'version', 'lottery_deadline', 'required_throws', 'purchase_url', 'groups', 'archived'], events),
    ...insertJson('attendance', ['id', 'event_id', 'member_id', 'status', 'applied', 'version'], attendance),
    ...insertJson('tickets', ['id', 'event_id', 'member_id', 'number', 'number_key', 'status', 'recipient', 'memo', 'version', 'ticket_url'], tickets),
    ...(devices.length ? [db.prepare('DELETE FROM push_devices'), ...insertJson('push_devices', ['id', 'data'], devices)] : []),
    ...settings.map(([k, v]) => putSetting(db, k, v)),
  ];
  if (statements.length > 40) throw new AppError('移行データが大きすぎます。管理者に相談してください', 413);
  await commit(db, statements, '移行に失敗しました。ファイルを確認してください');
  return { members: members.size, lives: events.length, attendance: attendance.length, tickets: tickets.length, devices: devices.length };
}

/* ---------- Web push (FCM) and LINE ---------- */
function pushConfig(env) {
  const config = firebaseConfig(env);
  const vapidKey = String(env.PUSH_VAPID_PUBLIC_KEY || '');
  let service = env.PUSH_SERVICE_ACCOUNT;
  if (typeof service === 'string') { try { service = JSON.parse(service); } catch { service = null; } }
  if (!config || !/^[A-Za-z0-9_-]{87}$/.test(vapidKey) || service?.project_id !== config.projectId || !service?.private_key || !service?.client_email) return null;
  return { config: { apiKey: config.apiKey, projectId: config.projectId, messagingSenderId: config.messagingSenderId, appId: config.appId }, vapidKey, service };
}
async function pushIdentity(id, secret) {
  if (!UUID.test(id || '') || !/^[a-f0-9]{64}$/.test(secret || '')) throw new AppError('通知の登録情報が無効です');
  // Same encoding as the GAS version (web-safe base64 with padding), so migrated devices still match.
  return bytesToB64urlPadded(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
}
const readDevice = row => row ? { ...JSON.parse(row.data), key: row.id } : null;
const writeDevice = (db, id, device) => { const { key, events, ...data } = device; return db.prepare('INSERT INTO push_devices(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').bind(id, JSON.stringify(data)); };
function pushGroups(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(g => typeof g !== 'string' || !g.trim() || g.length > 100)) throw new AppError('通知するグループを1つ以上選んでください');
  return [...new Set(value.map(g => g.trim()))];
}
async function getPushSettings({ db, env }, id, secret, includeGroups) {
  const config = pushConfig(env);
  const result = config ? { ready: true, config: config.config, vapidKey: config.vapidKey, groupFiltering: true } : { ready: false, groupFiltering: true };
  if (includeGroups) {
    const lives = await all(db, 'SELECT groups FROM events');
    result.availableGroups = [...new Set(lives.flatMap(l => readGroups(l.groups)))].sort((a, b) => a.localeCompare(b, 'ja'));
    if (id) {
      const hash = await pushIdentity(id, secret), device = readDevice(await first(db, 'SELECT * FROM push_devices WHERE id = ?', id));
      if (device && device.hash !== hash) throw new AppError('通知の登録情報が一致しません', 403);
      result.selectedGroups = device?.groups ?? null;
    } else result.selectedGroups = null;
  }
  return result;
}
async function savePushSubscription({ db, me, env }, memberId, device) {
  sameMember(me, memberId);
  if (!pushConfig(env)) throw new AppError('通知は管理者の初期設定待ちです');
  const hash = await pushIdentity(device?.id, device?.secret);
  if (typeof device.token !== 'string' || !device.token || device.token.length > 2000 || !/^[A-Za-z0-9_:.-]+$/.test(device.token)) throw new AppError('通知の宛先が無効です');
  const rows = (await all(db, 'SELECT * FROM push_devices')).map(readDevice);
  const prior = rows.find(d => d.key === device.id);
  if (prior && prior.hash !== hash) throw new AppError('通知の登録情報が一致しません', 403);
  if (!prior && rows.length >= 100) throw new AppError('通知登録が上限です。管理者に連絡してください');
  const groups = Object.prototype.hasOwnProperty.call(device, 'groups') ? pushGroups(device.groups) : (prior?.groups ?? null);
  // A cleared browser storage can reuse the same FCM token. Keep one active destination.
  let sentDay = prior?.sentDay || '';
  const statements = [];
  for (const other of rows) {
    if (other.key !== device.id && other.token === device.token) {
      sentDay = [sentDay, other.sentDay || ''].sort().pop();
      statements.push(writeDevice(db, other.key, { ...other, enabled: false, token: '', updatedAt: Date.now() }));
    }
  }
  statements.push(writeDevice(db, device.id, { ...prior, memberId: me.id, sentDay, hash, token: device.token, groups, enabled: true, updatedAt: Date.now() }));
  await db.batch(statements);
  return { enabled: true, groups, groupFiltering: true };
}
async function removePushSubscription({ db }, id, secret) {
  const hash = await pushIdentity(id, secret), prior = readDevice(await first(db, 'SELECT * FROM push_devices WHERE id = ?', id));
  if (prior && prior.hash !== hash) throw new AppError('通知の登録情報が一致しません', 403);
  if (prior) await writeDevice(db, id, { ...prior, enabled: false, token: '', updatedAt: Date.now() }).run();
  return { enabled: false };
}
let fcmToken = { value: '', expires: 0 };
async function fcmAccessToken(service) {
  if (fcmToken.value && Date.now() < fcmToken.expires) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = textToB64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    textToB64url(JSON.stringify({ iss: service.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = service.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + bytesToB64url(signature) }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new AppError('通知用の認証に失敗しました。サービスアカウントの設定を確認してください', 502);
  fcmToken = { value: body.access_token, expires: Date.now() + 50 * 60000 };
  return fcmToken.value;
}
const fcmSend = async (config, access, message) => fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.config.projectId)}/messages:send`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + access }, body: JSON.stringify({ message }) });
async function testPushSubscription({ db, env }, id, secret) {
  const hash = await pushIdentity(id, secret), record = readDevice(await first(db, 'SELECT * FROM push_devices WHERE id = ?', id));
  if (!record || record.hash !== hash || !record.enabled || !record.token) throw new AppError('先にこの端末の通知を登録してください');
  if (record.testAt && Date.now() - record.testAt < 60000) throw new AppError('テスト通知は1分ほど間隔をあけてください');
  const config = pushConfig(env);
  if (!config) throw new AppError('通知の初期設定を確認してください');
  await writeDevice(db, id, { ...record, testAt: Date.now() }).run();
  const response = await fcmSend(config, await fcmAccessToken(config.service), { token: record.token, data: { title: '通知のテスト', body: 'Ticket Managementの通知が届きました。', tag: 'ticket-push-test' }, webpush: { headers: { TTL: '300' } } });
  if (!response.ok) throw new AppError('テスト送信に失敗しました。Firebase Cloud Messaging APIとサービスアカウントの権限を確認してください', 502);
  return { accepted: true };
}

function dueEvents(lives, today) {
  return lives.filter(l => l.date >= today && l.lottery_deadline === today && !l.archived)
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'ja'));
}
const slash = date => date.replace(/-/g, '/');
function pushBody(lives) {
  const lines = lives.slice(0, 3).map(l => String(l.title).slice(0, 70) + '／投げ数 ' + (l.required_throws !== '' ? l.required_throws + '枚' : '未設定'));
  if (lives.length > 3) lines.push('ほか' + (lives.length - 3) + '件');
  lines.push('タップしてイベントを確認');
  return lines.join('\n');
}
async function lineBody(db, events, mode) {
  const lines = ['【本日締切】']; let included = 0;
  const add = (block, total) => { if (lines.join('\n').length + block.length > 4500) return false; lines.push(block); included++; return true; };
  if (mode === 'unconfirmed') {
    const members = await all(db, 'SELECT id, name FROM members WHERE active = 1 ORDER BY created_at, name');
    const statuses = await all(db, `SELECT * FROM attendance WHERE event_id IN (${events.map(() => '?').join(',')})`, ...events.map(e => e.id));
    const pending = events.map(l => ({ live: l, names: members.filter(m => {
      const record = statuses.find(a => a.event_id === l.id && a.member_id === m.id);
      return !record || (record.status !== '不参加' && !['申込済み', '申込不要'].includes(record.applied));
    }).map(m => m.name) })).filter(x => x.names.length);
    if (!pending.length) return '【本日締切】\n申込状況の未確認はありません。';
    for (const item of pending) if (!add(['', '開催日：' + slash(item.live.date), 'イベント名：' + item.live.title, '未確認：' + item.names.join('、')].join('\n'))) break;
    if (included < pending.length) lines.push('', 'ほか' + (pending.length - included) + '件（文字数上限のため省略）');
    return lines.join('\n');
  }
  for (const l of events) if (!add(['', '開催日：' + slash(l.date), 'イベント名：' + l.title, 'チケットURL：' + (l.purchase_url || '未登録'), '枠数：' + (l.required_throws !== '' ? l.required_throws + '枚' : '未設定')].join('\n'))) break;
  if (included < events.length) lines.push('', 'ほか' + (events.length - included) + '件（文字数上限のため省略）');
  return lines.join('\n');
}
async function sendDeadlineNotifications(env, now = new Date()) {
  const db = env.DB, today = japanToday(now), minute = japanTime(now);
  const lives = dueEvents(await all(db, 'SELECT * FROM events WHERE lottery_deadline = ? AND archived = 0', today), today);
  if (!lives.length) return { line: 'no-events', push: 0 };
  const report = { line: 'skipped', push: 0 };
  const settingsRow = await getSettings(db, ['line_group_id', 'line_state']);
  const groupId = String(env.LINE_GROUP_ID || settingsRow.line_group_id || '').trim(), token = String(env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
  if (token && groupId) {
    const settings = await adminSettings(db);
    const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const slot = minute >= minutes(settings.nightTime) ? 'night' : minute >= minutes(settings.dayTime) ? 'day' : '';
    if (slot) {
      const state = JSON.parse(settingsRow.line_state || '{}');
      const s = state[slot]?.day === today ? state[slot] : { day: today, attempts: 0, nextAttempt: 0, sent: false, retryKey: uuid() };
      if (!s.sent && s.attempts < 3 && s.nextAttempt <= now.getTime()) {
        s.attempts += 1; s.nextAttempt = now.getTime() + 15 * 60000;
        state[slot] = s; await putSetting(db, 'line_state', JSON.stringify(state)).run();
        try {
          // The same retry key all day: if LINE accepted a request whose response was lost, the retry gets 409 instead of a duplicate post.
          const response = await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'X-Line-Retry-Key': s.retryKey },
            body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: await lineBody(db, lives, slot === 'day' ? settings.dayMode : settings.nightMode) }] }) });
          s.sent = response.status === 200 || response.status === 409; s.lastStatus = 'HTTP ' + response.status;
        } catch { s.lastStatus = 'network-error'; }
        state[slot] = s; await putSetting(db, 'line_state', JSON.stringify(state)).run();
        report.line = s.lastStatus;
      }
    }
  }
  const config = pushConfig(env), hour = Math.floor(minute / 60);
  if (!config || hour < 12) return report;
  const groupsOf = l => readGroups(l.groups);
  const devices = (await all(db, 'SELECT * FROM push_devices')).map(readDevice)
    .map(d => ({ ...d, events: d.groups == null ? lives : lives.filter(l => groupsOf(l).some(g => d.groups.includes(g))) }))
    .filter(d => d.enabled && d.token && d.events.length && d.sentDay !== today && !(d.attemptDay === today && (d.attempts >= 3 || d.nextAttempt > now.getTime())))
    .slice(0, 10);
  if (!devices.length) return report;
  const access = await fcmAccessToken(config.service);
  const ttl = Math.max(0, Math.floor((Date.parse(today + 'T23:59:59+09:00') - now.getTime()) / 1000));
  if (!ttl) return report;
  // Merge delivery fields into the latest stored record, in case the device changed meanwhile.
  const update = async (d, patch) => {
    const current = readDevice(await first(db, 'SELECT * FROM push_devices WHERE id = ?', d.key));
    if (current && current.token === d.token) await writeDevice(db, d.key, { ...current, ...patch }).run();
  };
  for (const d of devices) {
    const attempts = d.attemptDay === today ? (d.attempts || 0) + 1 : 1;
    await update(d, { attempts, attemptDay: today, nextAttempt: now.getTime() + 15 * 60000 });
    const patch = {};
    try {
      const response = await fcmSend(config, access, { token: d.token, data: { title: '本日抽選締切（' + d.events.length + '件）', body: pushBody(d.events), tag: 'ticket-deadline-' + today }, webpush: { headers: { TTL: String(ttl), Urgency: 'normal' } } });
      patch.lastStatus = response.ok ? 'sent' : 'HTTP ' + response.status;
      if (response.ok) { patch.sentDay = today; report.push++; }
      else {
        const body = await response.json().catch(() => ({}));
        if (body.error?.details?.some(x => x.errorCode === 'UNREGISTERED')) { patch.enabled = false; patch.token = ''; }
        if (response.status === 401 || response.status === 403) fcmToken = { value: '', expires: 0 };
      }
    } catch { patch.lastStatus = 'network-error'; }
    await update(d, patch);
  }
  return report;
}
async function scheduled(env, now = new Date()) {
  await ensureSchema(env);
  await archivePastEvents(env.DB, japanToday(now));
  // Completed save receipts are only needed while a client might still retry.
  await env.DB.prepare('DELETE FROM save_requests WHERE created_at < ?').bind(now.getTime() - 30 * 86400000).run();
  return sendDeadlineNotifications(env, now);
}

/* ---------- LINE webhook (bot joined a group) ---------- */
async function lineWebhook(request, env) {
  const secret = env.LINE_CHANNEL_SECRET;
  if (typeof secret !== 'string' || !secret) return new Response('Webhook is not configured', { status: 503 });
  const raw = await request.text();
  if (raw.length > 100000) return new Response('Payload too large', { status: 413 });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))));
  const received = request.headers.get('x-line-signature') || '';
  let diff = expected.length ^ received.length;
  for (let i = 0; i < Math.max(expected.length, received.length); i++) diff |= (expected.charCodeAt(i) || 0) ^ (received.charCodeAt(i) || 0);
  if (diff !== 0) return new Response('Invalid signature', { status: 401 });
  let payload; try { payload = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
  const joined = (Array.isArray(payload.events) ? payload.events : []).find(e => e?.type === 'join' && e.source?.type === 'group' && typeof e.source.groupId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(e.source.groupId));
  if (!joined) return new Response('OK');
  await ensureSchema(env);
  // The first group the bot joins becomes the fixed destination.
  await env.DB.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('line_group_id', ?)").bind(joined.source.groupId).run();
  return new Response('OK');
}

/* ---------- RPC ---------- */
const METHODS = {
  getMembers: async ({ me }) => [{ id: me.id, name: me.name }],
  getData: async ({ db, me }, memberId) => { sameMember(me, memberId); await archivePastEvents(db); return snapshot(db, me); },
  saveData, getAdminSettings, saveAdminSettings, getPushSettings, savePushSubscription, removePushSubscription, testPushSubscription,
  listMembers, saveMember, registerMember, importData,
};
function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || 'https://m0ch4771.github.io').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : { vary: 'origin' };
}
async function rpc(request, env) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400' } });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405, cors);
  if (!cors['access-control-allow-origin']) return json({ ok: false, error: 'このサイトからは利用できません' }, 403, cors);
  try {
    const raw = await request.text();
    if (raw.length > 3_000_000) throw new AppError('送信内容が大きすぎます', 413);
    let body; try { body = JSON.parse(raw); } catch { throw new AppError('リクエストが不正です'); }
    const method = String(body?.method || ''), args = Array.isArray(body?.args) ? body.args : [];
    if (method === 'getAuthConfig') {
      const firebase = firebaseConfig(env);
      return json({ ok: true, value: firebase ? { ready: true, firebase } : { ready: false } }, 200, cors);
    }
    const handler = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
    if (!handler) throw new AppError('未対応の操作です', 404);
    await ensureSchema(env);
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const email = await verifyIdToken(token, env);
    const me = await memberFor(email, env);
    const value = await handler({ db: env.DB, env, me }, ...args);
    return json({ ok: true, value }, 200, cors);
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500;
    if (!(e instanceof AppError)) console.error(e);
    return json({ ok: false, error: e instanceof AppError ? e.message : '処理に失敗しました。少し待って再度お試しください' }, status, cors);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/rpc') return rpc(request, env);
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/line/webhook') && request.headers.has('x-line-signature')) return lineWebhook(request, env);
    if (request.method === 'GET' && url.pathname === '/') return new Response('Ticket Management API is running.');
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env, new Date(event.scheduledTime || Date.now())));
  },
};

// Exposed for tests only.
export const __test = { normalizeDate, verifyIdToken, scheduled, sendDeadlineNotifications, pushIdentity, resetCaches: () => { schemaReady = null; jwks = { keys: [], expires: 0 }; keyCache.clear(); fcmToken = { value: '', expires: 0 }; } };
