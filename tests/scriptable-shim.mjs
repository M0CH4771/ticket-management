// Minimal Scriptable API emulation that renders a ListWidget tree to HTML (flexbox), for previews.
// Alignment is deliberately pessimistic: the ListWidget centers its children, so anything
// that is not a full-width row shows up as mis-aligned.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function makeScriptable({ family, fetchApi, mode = 'light', files = new Map(), screen = { width: 393, height: 852 } }) {
  let current = null;
  class Color {
    constructor(hex, alpha = 1) { this.hex = hex.startsWith('#') ? hex : '#' + hex; this.alpha = alpha; }
    css() { return this.hex; }
    static dynamic(l, d) { const c = Object.create(Color.prototype); c.light = l; c.dark = d; c.css = () => (mode === 'dark' ? d : l).css(); return c; }
    static white() { return new Color('#ffffff'); }
    static black() { return new Color('#000000'); }
  }
  const font = (size, weight, rounded) => ({ size, weight, rounded });
  const Font = { systemFont: s => font(s, 400), semiboldSystemFont: s => font(s, 600), boldSystemFont: s => font(s, 700), boldRoundedSystemFont: s => font(s, 700, true), mediumSystemFont: s => font(s, 500) };
  class Size { constructor(w, h) { this.width = w; this.height = h; } }
  class Text { constructor(t) { this.kind = 'text'; this.text = t; this.align = 'left'; } leftAlignText() { this.align = 'left'; } centerAlignText() { this.align = 'center'; } rightAlignText() { this.align = 'right'; } }
  class Stack {
    constructor(dir = 'row') { this.kind = 'stack'; this.dir = dir; this.align = 'top'; this.children = []; this.spacing = 0; this.pad = null; }
    addText(t) { const x = new Text(t); this.children.push(x); return x; }
    addStack() { const s = new Stack('row'); this.children.push(s); return s; }
    addSpacer(n = null) { const s = { kind: 'spacer', n }; this.children.push(s); return s; }
    layoutHorizontally() { this.dir = 'row'; } layoutVertically() { this.dir = 'col'; }
    topAlignContent() { this.align = 'top'; } centerAlignContent() { this.align = 'center'; } bottomAlignContent() { this.align = 'bottom'; }
    setPadding(t, l, b, r) { this.pad = [t, l, b, r]; }
  }
  class ListWidget extends Stack {
    constructor() { super('col'); this.isRoot = true; this.align = 'center'; }
    async presentSmall() { current = this; } async presentMedium() { current = this; } async presentLarge() { current = this; }
  }
  class Request {
    constructor(url) { this.url = url; this.headers = {}; this.response = null; }
    async loadJSON() { const r = await fetchApi(this.url, this.headers); this.response = { statusCode: r.status }; return r.body; }
    async loadString() { throw new Error('no network in shim'); }
  }
  const FileManager = { local: () => ({ joinPath: (a, b) => a + '/' + b, libraryDirectory: () => '/lib', fileExists: p => files.has(p), readString: p => files.get(p), writeString: (p, v) => files.set(p, v) }) };
  const config = { widgetFamily: family, runsInWidget: true, runsInAccessoryWidget: /^accessory/.test(family) };
  const Script = { setWidget: w => { current = w; }, complete() {} };
  const Device = { screenSize: () => new Size(screen.width, screen.height) };
  return { globals: { Color, Font, Size, ListWidget, Request, FileManager, config, Script, Device }, result: () => current };
}

export function toHtml(node, ctx, parentDir = 'column') {
  const accessory = ctx.accessory;
  const css = c => c ? c.css() : null;
  if (node.kind === 'spacer') return node.n == null ? '<div style="flex:1 1 0;min-width:0;min-height:0"></div>' : `<div style="flex:0 0 ${node.n}px"></div>`;
  if (node.kind === 'text') {
    const f = node.font || { size: 17, weight: 400 };
    const color = css(node.textColor) || (accessory ? '#fff' : (ctx.mode === 'dark' ? '#fff' : '#000'));
    const clamp = node.lineLimit === 1 ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' : node.lineLimit > 1 ? `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${node.lineLimit};overflow:hidden;` : '';
    return `<div class="t" style="font-size:${f.size}px;font-weight:${f.weight};${f.rounded ? 'font-family:\'SF Pro Rounded\',\'Noto Sans CJK JP\',sans-serif;' : ''}color:${color};text-align:${node.align};line-height:1.2;${clamp}">${esc(node.text)}</div>`;
  }
  const dir = node.dir === 'row' ? 'row' : 'column';
  const ai = { top: 'flex-start', center: 'center', bottom: 'flex-end' }[node.align];
  const pad = node.pad ? `padding:${node.pad[0]}px ${node.pad[3]}px ${node.pad[2]}px ${node.pad[1]}px;` : node.isRoot ? 'padding:16px;' : '';
  const size = node.size ? `${node.size.width > 0 ? `width:${node.size.width}px;` : ''}${node.size.height > 0 ? `height:${node.size.height}px;` : ''}` : '';
  const bg = !accessory && css(node.backgroundColor) ? `background:${css(node.backgroundColor)};` : '';
  const radius = node.cornerRadius ? `border-radius:${node.cornerRadius}px;` : '';
  const inner = node.children.map(c => toHtml(c, ctx, dir)).join('');
  // SwiftUI: a stack holding a flexible Spacer grows along its own axis.
  const flex = node.children.some(c => c.kind === 'spacer' && c.n == null) && !node.isRoot && !(node.size && (dir === 'row' ? node.size.width > 0 : node.size.height > 0));
  const fixed = node.size && (node.size.width > 0 || node.size.height > 0) ? 'flex-shrink:0 !important;' : '';
  const grow = fixed + (flex ? (dir === parentDir ? 'flex:1 1 auto;' : 'align-self:stretch;') : '');
  const cls = 'st ' + dir + (node.isRoot ? ' root' : '');
  return `<div class="${cls}" style="display:flex;flex-direction:${dir};align-items:${ai};gap:${node.spacing || 0}px;${grow}${pad}${size}${bg}${radius}">${inner}</div>`;
}
