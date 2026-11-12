// iPhone widgets (docs/widget/core.js) in a Scriptable emulation: every type x family renders,
// shows the expected content, handles a bad key / offline / empty data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeScriptable, toHtml } from './scriptable-shim.mjs';

const code = fs.readFileSync(new URL('../docs/widget/core.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const day = o => new Date(Date.now() + 9 * 3600000 + o * 86400000).toISOString().slice(0, 10);
const today = day(0);
const ev = (id, title, date, deadline, extra = {}) => ({ id, title, date, venue: '会場' + id, deadline, throws: '2', groups: ['A'], status: '', applied: '未確認', own: 0, surplus: 0, ...extra });
const data = { ok: true, today, member: { name: 'テスト' }, groups: ['A', 'B'], events: [
  ev('1', '今日締切ライブ', day(20), today, { status: '参戦', own: 2 }),
  ev('2', '申込済みライブ', day(8), day(3), { status: '参戦', applied: '申込済み' }),
  ev('3', 'Bのライブ', day(5), day(1), { groups: ['B'], status: '不参加', applied: '申込不要' }),
  ev('4', '締切なしライブ', day(2), '', { status: '参戦', own: 3, ownNumbers: ['A012', 'A013'], surplus: 2 }),
  ev('5', '推しの未回答ライブ', day(1), '', { groups: ['C'] }),
  ev('6', '推しの不参加ライブ', day(1), '', { groups: ['C'], status: '不参加', applied: '申込不要' }),
] };
let api = { status: 200, body: data }, offline = false;
async function render(type, family, groups = [], files = new Map()) {
  const S = makeScriptable({ family, files, fetchApi: async () => { if (offline) throw new Error('offline'); return api; } });
  const names = Object.keys(S.globals);
  await new AsyncFunction('CONFIG', ...names, code)({ type, key: 'wk_test', api: 'https://api.example', app: 'https://app.example/', groups }, ...names.map(n => S.globals[n]));
  const w = S.result();
  assert.ok(w, `${type}/${family} produced no widget`);
  assert.equal(w.url, 'https://app.example/');
  return toHtml(w, { accessory: /^accessory/.test(family), mode: 'light' }).replace(/<[^>]+>/g, ' ');
}
const has = (s, ...parts) => parts.forEach(p => assert.ok(s.includes(p), `missing "${p}" in: ${s.replace(/\s+/g, ' ').slice(0, 300)}`));
const not = (s, ...parts) => parts.forEach(p => assert.ok(!s.includes(p), `unexpected "${p}"`));

has(await render('today', 'small'), '今日の締切', '今日締切ライブ', '未確認');
not(await render('today', 'medium'), '申込済みライブ');
has(await render('deadlines', 'medium'), '今日', '明日', 'あと3日', '申込済み', '不参加');
not(await render('deadlines', 'large'), '締切なしライブ');
// countdown prefers the nearest deadline that is still 未確認
has(await render('countdown', 'accessoryRectangular'), '締切 今日', '今日締切ライブ', '申込状況：未確認');
has(await render('countdown', 'accessoryInline'), '締切今日');
has(await render('countdown', 'accessoryCircular'), '締切', '今日');
// 次のイベント: 参戦 only, unless 推し groups are chosen — then that group's events show whatever the plan is.
{
  const plain = await render('next', 'small');
  has(plain, '次のイベント', 'あと2日', '締切なしライブ', '参戦', '余り 2枚', '自分用 A012・A013 ほか1枚'); not(plain, '推しの未回答ライブ');
  has(await render('next', 'accessoryRectangular'), '自分用 A012・A013 ほか1枚 ・ 余り2枚');
  const oshi = await render('next', 'medium', ['C']);
  has(oshi, '明日', '推しの不参加ライブ', '推しの未回答ライブ', '不参加', '未回答', 'その次', '締切なしライブ');
  has(await render('next', 'accessoryRectangular', ['C']), '明日', '不参加');
  has(await render('next', 'accessoryRectangular'), 'あと2日');
}
{
  const a = await render('oshi', 'large', ['A']);
  has(a, 'A', '推しの予定', '月', '今日締切ライブ', '締切', 'ライブ'); not(a, 'Bのライブ');
  has(await render('oshi', 'medium', []), 'すべてのグループ', 'Bのライブ');
  has(await render('oshi', 'small', ['B']), 'Bのライブ');
}
console.log('PASS: 5 widget types x home/lock screen sizes render the member\'s data');

// first-come data for today shown when nothing today; empty data
api = { status: 200, body: { ...data, events: [ev('9', '先のライブ', day(9), day(4))] } };
has(await render('today', 'small'), '今日締切のイベントはありません', '先のライブ');
api = { status: 200, body: { ...data, events: [] } };
has(await render('deadlines', 'medium'), 'これからの締切はありません');
has(await render('next', 'small'), 'これからのイベントはありません');
has(await render('countdown', 'accessoryRectangular'), '締切の予定なし');
// bad key, offline with and without the last good data
api = { status: 401, body: { ok: false, error: 'ウィジェットのキーが無効です' } };
has(await render('deadlines', 'medium'), 'キーが無効');
api = { status: 200, body: data };
const files = new Map();
await render('deadlines', 'medium', [], files);
offline = true;
has(await render('deadlines', 'medium', [], files), '前回の情報', '今日締切ライブ');
has(await render('today', 'small'), '読み込めませんでした');
console.log('PASS: widget empty states, invalid key message, offline fallback to the last good data');
