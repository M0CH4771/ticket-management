// TICKET_WIDGET_CORE
// iPhone home / lock screen widgets for チケマネ, rendered by the Scriptable app.
// Loaded and run by the short script each member pastes into Scriptable:
//   new AsyncFunction('CONFIG', code)(CONFIG)
// CONFIG = { type, key, api, app, groups }
//   type: 'today' | 'deadlines' | 'countdown' | 'next' | 'oshi'
// The widget API only returns the member's own schedule and statuses (no ticket numbers or URLs).

const WIDGET_VERSION = 1;
const C = (light, dark) => Color.dynamic(new Color(light), new Color(dark));
const T = {
  bg: C('#ffffff', '#16213a'), ink: C('#12233f', '#e9edf5'), ink2: C('#47526a', '#b3bccd'), ink3: C('#687288', '#919bb0'),
  line: C('#dde2ea', '#2a3754'), soft: C('#f2f4f8', '#1c2945'),
  blue: C('#1f5bd6', '#8fb2ff'), blueTint: C('#eaf0fd', '#1e2f57'),
  coral: C('#e2462f', '#ff6b55'), coralInk: C('#b0301d', '#ff9d8a'), coralTint: C('#fdece8', '#3b1f1f'),
  green: C('#1c7445', '#7dd6a3'), greenTint: C('#e5f3eb', '#15362a'),
  sunInk: C('#7a5600', '#ffd56a'), sunTint: C('#fff5d6', '#352c12'),
};
const TYPE_NAMES = { today: '今日の締切', deadlines: '締切が近い順', countdown: '次の締切', next: '次の参戦', oshi: '推しの予定' };

/* ---------- dates (always Japan time) ---------- */
const japanToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const dayNum = s => { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const daysUntil = (s, today) => dayNum(s) - dayNum(today);
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const weekday = s => WEEK[new Date(dayNum(s) * 86400000).getUTCDay()];
const md = s => { const [, m, d] = String(s).split('-').map(Number); return m + '/' + d; };
const mdw = s => md(s) + '(' + weekday(s) + ')';
const until = n => n <= 0 ? '今日' : n === 1 ? '明日' : 'あと' + n + '日';
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/* ---------- data ---------- */
async function loadData() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.libraryDirectory(), 'ticket-widget-' + String(CONFIG.key).slice(-10) + '.json');
  try {
    const req = new Request(String(CONFIG.api).replace(/\/+$/, '') + '/api/widget');
    req.headers = { authorization: 'Bearer ' + CONFIG.key };
    req.timeoutInterval = 15;
    const body = await req.loadJSON();
    const status = req.response ? req.response.statusCode : 0;
    if (body && body.ok) { fm.writeString(cache, JSON.stringify(body)); return { data: body, stale: false }; }
    if (status === 401) return { error: (body && body.error) || 'キーが無効です。チケマネでスクリプトをコピーし直してください' };
  } catch (e) { /* offline: fall back to the last good data */ }
  if (fm.fileExists(cache)) { try { return { data: JSON.parse(fm.readString(cache)), stale: true }; } catch (e) {} }
  return { error: '読み込めませんでした。通信できる場所でもう一度お試しください' };
}

/* ---------- drawing helpers ---------- */
function frame() {
  const w = new ListWidget();
  w.backgroundColor = T.bg;
  w.setPadding(14, 14, 12, 14);
  w.url = CONFIG.app;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60000);
  return w;
}
function text(parent, value, size, color, weight, lines) {
  const t = parent.addText(String(value));
  t.font = weight === 'bold' ? Font.boldSystemFont(size) : weight === 'semibold' ? Font.semiboldSystemFont(size)
    : weight === 'round' ? Font.boldRoundedSystemFont(size) : Font.systemFont(size);
  if (color) t.textColor = color;
  if (lines) t.lineLimit = lines;
  return t;
}
// A full-width row, so text stays left-aligned whatever the parent's alignment is.
function ltext(parent, value, size, color, weight, lines) {
  const row = parent.addStack(); row.layoutHorizontally();
  const t = text(row, value, size, color, weight, lines);
  row.addSpacer();
  return t;
}
function header(w, title, color, right) {
  const h = w.addStack(); h.layoutHorizontally(); h.centerAlignContent();
  text(h, title, 13, color, 'bold', 1);
  h.addSpacer();
  if (right) text(h, right, 11, T.ink3, '', 1);
  return h;
}
function chip(parent, label, fg, bg) {
  const s = parent.addStack(); s.setPadding(2, 6, 2, 6); s.cornerRadius = 6; s.backgroundColor = bg; s.centerAlignContent();
  text(s, label, 10, fg, 'bold', 1);
  return s;
}
function appliedChip(parent, e) {
  if (e.applied === '申込済み') return chip(parent, '申込済み', T.green, T.greenTint);
  if (e.applied === '申込不要') return chip(parent, e.status === '不参加' ? '不参加' : '申込不要', T.ink3, T.soft);
  return chip(parent, '未確認', T.coralInk, T.coralTint);
}
function staleNote(w, stale) {
  if (!stale) return;
  w.addSpacer(4);
  ltext(w, '前回の情報（通信できませんでした）', 9, T.ink3, '', 1);
}
function message(w, title, body) {
  ltext(w, title, 13, T.ink, 'semibold', 4);
  if (body) { w.addSpacer(3); ltext(w, body, 11, T.ink3, '', 3); }
}
let STALE = false; // showing cached data: leave room for the note at the bottom
const rowsFor = (family, small, medium, large) => (family === 'small' ? small : family === 'large' || family === 'extraLarge' ? large : medium) - (STALE && family !== 'large' && family !== 'extraLarge' ? 1 : 0);

/* ---------- selections ---------- */
const upcomingDeadlines = (events, today) => events.filter(e => isDate(e.deadline) && e.deadline >= today)
  .sort((a, b) => a.deadline.localeCompare(b.deadline) || a.date.localeCompare(b.date));
const nextAttending = (events, today) => events.filter(e => e.status === '参戦' && isDate(e.date) && e.date >= today)
  .sort((a, b) => a.date.localeCompare(b.date));
function countdownTarget(events, today) {
  const list = upcomingDeadlines(events, today);
  return list.find(e => e.applied === '未確認') || list[0] || null;
}
function oshiItems(data, today) {
  const wanted = (CONFIG.groups || []).filter(Boolean);
  const events = data.events.filter(e => !wanted.length || (e.groups || []).some(g => wanted.includes(g)));
  const items = [];
  for (const e of events) {
    if (isDate(e.date)) items.push({ date: e.date, kind: 'live', e });
    if (isDate(e.deadline)) items.push({ date: e.deadline, kind: 'deadline', e });
  }
  return { wanted, items: items.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'deadline' ? -1 : 1)) };
}

/* ---------- widget: 今日の締切 ---------- */
function todayWidget(w, family, data, today) {
  const list = upcomingDeadlines(data.events, today).filter(e => e.deadline === today);
  header(w, '今日の締切', T.coral, list.length ? list.length + '件' : '');
  w.addSpacer(6);
  if (!list.length) {
    const next = upcomingDeadlines(data.events, today)[0];
    message(w, '今日締切のイベントはありません', next ? '次の締切：' + mdw(next.deadline) + '\n' + next.title : '');
    w.addSpacer();
    return;
  }
  const max = rowsFor(family, 2, 3, 8);
  for (const e of list.slice(0, max)) {
    if (family === 'small') {
      ltext(w, e.title, 12, T.ink, 'semibold', 1);
      w.addSpacer(2);
      const r = w.addStack(); r.layoutHorizontally(); r.centerAlignContent();
      appliedChip(r, e); r.addSpacer(5); text(r, '枠数' + (e.throws !== '' ? e.throws : '-'), 10, T.ink3, '', 1); r.addSpacer();
      w.addSpacer(7);
      continue;
    }
    const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent();
    const left = row.addStack(); left.layoutVertically();
    text(left, e.title, 13, T.ink, 'semibold', 1);
    text(left, '枠数 ' + (e.throws !== '' ? e.throws + '枚' : '未設定'), 10, T.ink3, '', 1);
    row.addSpacer();
    appliedChip(row, e);
    w.addSpacer(7);
  }
  if (list.length > max) ltext(w, 'ほか' + (list.length - max) + '件', 10, T.ink3, '', 1);
  else if (list.length < max || family !== 'small') {
    const next = upcomingDeadlines(data.events, today).find(e => e.deadline > today);
    if (next && list.length < max) { w.addSpacer(); ltext(w, '次の締切：' + mdw(next.deadline) + ' ' + next.title, 10, T.ink3, '', family === 'small' ? 2 : 1); }
  }
  w.addSpacer();
}

/* ---------- widget: 締切が近い順 ---------- */
function deadlinesWidget(w, family, data, today) {
  const list = upcomingDeadlines(data.events, today);
  header(w, family === 'small' ? '締切が近い順' : '抽選締切が近い順', T.coral, list.length ? list.length + '件' : '');
  w.addSpacer(6);
  if (!list.length) { message(w, 'これからの締切はありません'); w.addSpacer(); return; }
  const max = rowsFor(family, 3, 3, 7);
  for (const e of list.slice(0, max)) {
    const n = daysUntil(e.deadline, today);
    const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent();
    const when = row.addStack(); when.size = new Size(family === 'small' ? 44 : 48, 0); when.layoutVertically();
    text(when, until(n), family === 'small' ? 10 : 12, n <= 1 ? T.coral : T.ink, 'bold', 1);
    row.addSpacer(4);
    const mid = row.addStack(); mid.layoutVertically();
    text(mid, e.title, family === 'small' ? 11 : 13, T.ink, 'semibold', 1);
    if (family !== 'small') text(mid, mdw(e.deadline) + '締切 ・ 枠数' + (e.throws !== '' ? e.throws : '-'), 10, T.ink3, '', 1);
    row.addSpacer();
    if (family !== 'small') appliedChip(row, e);
    w.addSpacer(family === 'small' ? 5 : family === 'large' ? 9 : 6);
  }
  w.addSpacer();
}

/* ---------- widget: 次の締切（ロック画面） ---------- */
function countdownWidget(w, family, data, today) {
  const e = countdownTarget(data.events, today);
  const n = e ? daysUntil(e.deadline, today) : null;
  if (family === 'accessoryInline') { text(w, e ? '締切' + until(n) + ' ' + e.title : '締切の予定なし', 12, null, '', 1); return; }
  if (family === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const s = w.addStack(); s.layoutVertically(); s.centerAlignContent();
    const a = text(s, '締切', 10, null, 'semibold', 1); a.centerAlignText();
    const b = text(s, e ? (n <= 0 ? '今日' : n === 1 ? '明日' : String(n)) : '-', e && n > 1 ? 22 : 15, null, 'round', 1); b.centerAlignText(); b.minimumScaleFactor = 0.6;
    if (e && n > 1) { const c = text(s, '日', 9, null, '', 1); c.centerAlignText(); }
    return;
  }
  if (family === 'accessoryRectangular') {
    if (!e) { ltext(w, '締切の予定なし', 13, null, 'semibold', 1); return; }
    ltext(w, '締切 ' + until(n) + '（' + mdw(e.deadline) + '）', 13, null, 'bold', 1);
    ltext(w, e.title, 12, null, '', 1);
    ltext(w, e.applied === '未確認' ? '申込状況：未確認' : e.applied === '申込済み' ? '申込済み ✓' : e.applied, 11, null, '', 1);
    return;
  }
  header(w, '次の締切', T.coral, '');
  w.addSpacer(4);
  if (!e) { message(w, 'これからの締切はありません'); w.addSpacer(); return; }
  ltext(w, until(n), family === 'small' ? 26 : 30, n <= 1 ? T.coral : T.ink, 'round', 1);
  w.addSpacer(2);
  ltext(w, e.title, family === 'small' ? 13 : 15, T.ink, 'semibold', 2);
  w.addSpacer();
  const foot = w.addStack(); foot.layoutHorizontally(); foot.centerAlignContent();
  text(foot, mdw(e.deadline), 11, T.ink3, '', 1);
  foot.addSpacer();
  appliedChip(foot, e);
}

/* ---------- widget: 次の参戦 ---------- */
function nextWidget(w, family, data, today) {
  const list = nextAttending(data.events, today);
  const e = list[0], n = e ? daysUntil(e.date, today) : null;
  if (family === 'accessoryInline') { text(w, e ? '参戦' + until(n) + ' ' + e.title : '参戦予定なし', 12, null, '', 1); return; }
  if (family === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const s = w.addStack(); s.layoutVertically(); s.centerAlignContent();
    const a = text(s, '参戦', 10, null, 'semibold', 1); a.centerAlignText();
    const b = text(s, e ? (n <= 0 ? '今日' : n === 1 ? '明日' : String(n)) : '-', e && n > 1 ? 22 : 15, null, 'round', 1); b.centerAlignText(); b.minimumScaleFactor = 0.6;
    if (e && n > 1) { const c = text(s, '日', 9, null, '', 1); c.centerAlignText(); }
    return;
  }
  if (family === 'accessoryRectangular') {
    if (!e) { ltext(w, '参戦予定なし', 13, null, 'semibold', 1); return; }
    ltext(w, '参戦 ' + until(n) + '（' + mdw(e.date) + '）', 13, null, 'bold', 1);
    ltext(w, e.title, 12, null, '', 1);
    ltext(w, e.venue || ' ', 11, null, '', 1);
    return;
  }
  if (!e) { header(w, '次の参戦', T.blue, ''); w.addSpacer(6); message(w, '参戦予定のイベントはありません', 'チケマネで参戦予定を「参戦」にすると表示されます'); w.addSpacer(); return; }
  const main = family === 'small' ? w : w.addStack();
  if (family !== 'small') { main.layoutHorizontally(); main.topAlignContent(); }
  const card = family === 'small' ? w : main.addStack();
  if (family !== 'small') { card.layoutVertically(); card.size = new Size(138, 0); }
  header(card, '次の参戦', T.blue, '');
  card.addSpacer(4);
  ltext(card, until(n), family === 'small' ? 26 : 30, n <= 0 ? T.coral : T.ink, 'round', 1);
  card.addSpacer(2);
  ltext(card, e.title, 13, T.ink, 'semibold', 2);
  card.addSpacer(3);
  ltext(card, mdw(e.date) + (e.venue ? ' ・ ' + e.venue : ''), 10, T.ink3, '', 1);
  if (e.own > 0) { card.addSpacer(4); const r = card.addStack(); chip(r, '自分用 ' + e.own + '枚', T.blue, T.blueTint); r.addSpacer(); }
  if (family === 'small') { w.addSpacer(); return; }
  card.addSpacer();
  main.addSpacer(10);
  const side = main.addStack(); side.layoutVertically();
  text(side, 'その次', 11, T.ink3, 'semibold', 1);
  side.addSpacer(5);
  const rest = list.slice(1, family === 'large' ? 9 : 4);
  if (!rest.length) text(side, '予定なし', 11, T.ink3, '', 1);
  for (const x of rest) {
    text(side, mdw(x.date) + ' ' + until(daysUntil(x.date, today)), 10, T.ink3, '', 1);
    text(side, x.title, 12, T.ink, 'semibold', 1);
    side.addSpacer(5);
  }
  side.addSpacer();
}

/* ---------- widget: 推しの予定（カレンダー） ---------- */
function itemRow(parent, it, today, size) {
  const row = parent.addStack(); row.layoutHorizontally(); row.centerAlignContent();
  const d = row.addStack(); d.size = new Size(size === 'small' ? 34 : 64, 0);
  text(d, size === 'small' ? md(it.date) : mdw(it.date), 10, it.date === today ? T.coral : T.ink3, it.date === today ? 'bold' : '', 1);
  row.addSpacer(3);
  if (it.kind === 'deadline') chip(row, '締切', T.coralInk, T.coralTint); else chip(row, 'ライブ', T.blue, T.blueTint);
  row.addSpacer(5);
  text(row, it.e.title, size === 'small' ? 11 : 12, T.ink, 'semibold', 1);
  row.addSpacer();
}
function oshiWidget(w, family, data, today) {
  const { wanted, items } = oshiItems(data, today);
  const label = wanted.length ? wanted.join('・') : 'すべてのグループ';
  const upcoming = items.filter(it => it.date >= today);
  header(w, label, T.blue, family === 'small' ? '' : '推しの予定');
  if (family === 'small' || family === 'medium') {
    w.addSpacer(6);
    if (!upcoming.length) { message(w, 'これからの予定はありません'); w.addSpacer(); return; }
    const max = rowsFor(family, 3, 4, 4);
    for (const it of upcoming.slice(0, max)) {
      if (family === 'small') {
        const s = w.addStack(); s.layoutHorizontally(); s.centerAlignContent();
        text(s, md(it.date), 10, it.date === today ? T.coral : T.ink3, 'bold', 1);
        s.addSpacer(4);
        text(s, it.kind === 'deadline' ? '締切' : 'ライブ', 9, it.kind === 'deadline' ? T.coral : T.blue, 'bold', 1);
        s.addSpacer();
        w.addSpacer(1);
        ltext(w, it.e.title, 11, T.ink, 'semibold', 1);
        w.addSpacer(4);
      } else { itemRow(w, it, today, family); w.addSpacer(6); }
    }
    w.addSpacer();
    return;
  }
  // large: month calendar + upcoming list
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = first.getUTCDay(), weeks = Math.ceil((lead + days) / 7);
  const marks = {};
  for (const it of items) { (marks[it.date] = marks[it.date] || {})[it.kind] = true; }
  w.addSpacer(4);
  const legend = w.addStack(); legend.layoutHorizontally(); legend.centerAlignContent();
  text(legend, y + '年' + m + '月', 12, T.ink, 'bold', 1);
  legend.addSpacer();
  text(legend, '●', 8, T.blue, '', 1); text(legend, ' ライブ  ', 9, T.ink3, '', 1);
  text(legend, '●', 8, T.coral, '', 1); text(legend, ' 締切', 9, T.ink3, '', 1);
  w.addSpacer(4);
  const CELL_W = 40, CELL_H = weeks > 5 ? 22 : 25;
  const head = w.addStack(); head.layoutHorizontally(); head.addSpacer();
  WEEK.forEach((name, i) => {
    const c = head.addStack(); c.size = new Size(CELL_W, 13); c.centerAlignContent();
    text(c, name, 9, i === 0 ? T.coral : T.ink3, 'semibold', 1);
  });
  head.addSpacer();
  for (let wk = 0; wk < weeks; wk++) {
    const r = w.addStack(); r.layoutHorizontally(); r.addSpacer();
    for (let i = 0; i < 7; i++) {
      const day = wk * 7 + i - lead + 1;
      const c = r.addStack(); c.size = new Size(CELL_W, CELL_H); c.layoutVertically(); c.centerAlignContent();
      if (day < 1 || day > days) continue;
      const iso = y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      if (iso === today) { c.backgroundColor = T.blueTint; c.cornerRadius = 7; }
      const num = c.addStack(); num.layoutHorizontally(); num.addSpacer();
      text(num, day, 11, iso < today ? T.ink3 : i === 0 ? T.coral : T.ink, iso === today ? 'bold' : '', 1);
      num.addSpacer();
      const dots = c.addStack(); dots.layoutHorizontally(); dots.addSpacer();
      const mk = marks[iso];
      if (mk && mk.live) text(dots, '●', 6, T.blue, '', 1);
      if (mk && mk.deadline) text(dots, '●', 6, T.coral, '', 1);
      if (!mk) text(dots, ' ', 6, null, '', 1);
      dots.addSpacer();
    }
    r.addSpacer();
  }
  w.addSpacer(6);
  const max = weeks > 5 ? 3 : 5;
  if (!upcoming.length) ltext(w, 'これからの予定はありません', 11, T.ink3, '', 1);
  for (const it of upcoming.slice(0, max)) { itemRow(w, it, today, 'large'); w.addSpacer(4); }
  w.addSpacer();
}

/* ---------- entry ---------- */
async function main() {
  const family = config.widgetFamily || (CONFIG.type === 'oshi' ? 'large' : CONFIG.type === 'deadlines' ? 'medium' : CONFIG.type === 'next' ? 'medium' : 'small');
  const accessory = /^accessory/.test(family);
  const w = accessory ? new ListWidget() : frame();
  if (accessory) { w.setPadding(0, 0, 0, 0); w.url = CONFIG.app; w.refreshAfterDate = new Date(Date.now() + 30 * 60000); }
  const { data, stale, error } = await loadData();
  if (error) {
    if (accessory) ltext(w, 'チケマネ：' + error, 11, null, '', 3);
    else { header(w, 'チケマネ', T.blue, ''); w.addSpacer(6); message(w, error); w.addSpacer(); }
  } else {
    const today = japanToday();
    STALE = !!stale;
    const draw = { today: todayWidget, deadlines: deadlinesWidget, countdown: countdownWidget, next: nextWidget, oshi: oshiWidget }[CONFIG.type] || deadlinesWidget;
    draw(w, family, data, today);
    if (!accessory) staleNote(w, stale);
  }
  if (config.runsInWidget) Script.setWidget(w);
  else if (family === 'large') await w.presentLarge();
  else if (family === 'medium') await w.presentMedium();
  else await w.presentSmall();
  Script.complete();
}
await main();
