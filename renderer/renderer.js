// Compact luxury instrument cluster: one small tachometer (5h session) + two
// segmented "fuel" bars (Fable-5 weekly, all-model weekly). Pure SVG/DOM.
const NS = 'http://www.w3.org/2000/svg';
// 240° sweep (not 260): keeps the needle's extreme angles clear of the text
// zone at the bottom of the dial — see the center-disc note in buildTach.
const SWEEP = 240, START = -120;

function el(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
function pt(cx, cy, r, t) { const a = t * Math.PI / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; }
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = pt(cx, cy, r, a0), [x1, y1] = pt(cx, cy, r, a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

function buildTach(container) {
  const size = 104, c = size / 2, id = 'sg';
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}` }, container);
  const defs = el('defs', {}, svg);
  const bezel = el('linearGradient', { id: id + '-bz', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: '0%', 'stop-color': '#e8ecf2' }, bezel);
  el('stop', { offset: '20%', 'stop-color': '#8d96a8' }, bezel);
  el('stop', { offset: '50%', 'stop-color': '#3c4454' }, bezel);
  el('stop', { offset: '82%', 'stop-color': '#20242e' }, bezel);
  el('stop', { offset: '100%', 'stop-color': '#565f72' }, bezel);
  const face = el('radialGradient', { id: id + '-fc', cx: '50%', cy: '36%', r: '75%' }, defs);
  el('stop', { offset: '0%', 'stop-color': '#161a23' }, face);
  el('stop', { offset: '72%', 'stop-color': '#0a0c11' }, face);
  el('stop', { offset: '100%', 'stop-color': '#040507' }, face);
  const ndl = el('linearGradient', { id: id + '-nd', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: '0%', 'stop-color': '#ff3b30' }, ndl);
  el('stop', { offset: '100%', 'stop-color': '#7a0f0a' }, ndl);
  const glow = el('filter', { id: id + '-gl', x: '-60%', y: '-60%', width: '220%', height: '220%' }, defs);
  el('feGaussianBlur', { stdDeviation: 1.1, result: 'b' }, glow);
  const mg = el('feMerge', {}, glow);
  el('feMergeNode', { in: 'b' }, mg); el('feMergeNode', { in: 'SourceGraphic' }, mg);

  el('circle', { cx: c, cy: c, r: c - 1, fill: `url(#${id}-bz)` }, svg);
  el('circle', { cx: c, cy: c, r: c - 3, fill: '#0c0e13' }, svg);
  el('circle', { cx: c, cy: c, r: c - 4.5, fill: `url(#${id}-fc)` }, svg);

  const rOut = c - 9, rInMaj = rOut - 6, rInMin = rOut - 3.5;
  const redFrom = 0.8;
  el('path', {
    d: arcPath(c, c, rOut - 1.5, START + SWEEP * redFrom, START + SWEEP),
    stroke: '#ff3b30', 'stroke-width': 3, fill: 'none', opacity: 0.9, filter: `url(#${id}-gl)`,
  }, svg);

  const N = 40;
  for (let i = 0; i <= N; i++) {
    const frac = i / N, theta = START + SWEEP * frac, maj = i % 4 === 0;
    const inRed = frac >= redFrom - 1e-9;
    const [x0, y0] = pt(c, c, rOut, theta), [x1, y1] = pt(c, c, maj ? rInMaj : rInMin, theta);
    el('line', {
      x1: x0, y1: y0, x2: x1, y2: y1,
      stroke: inRed ? '#ff3b30' : '#e6ebf2',
      'stroke-width': maj ? 1.3 : 0.6, 'stroke-linecap': 'round',
      opacity: maj ? 1 : 0.5,
    }, svg);
  }

  // Floating needle behind a central display disc (virtual-cockpit style).
  // The needle used to run hub-to-ticks and swept straight across the digital
  // readout at low/high percentages. Now a dark disc covers the center, the
  // text sits ON the disc, and the needle — drawn before both — is visible
  // only in the outer scale zone (r ≈ 30..41), passing behind the readout.
  const g = el('g', { style: 'transition:transform .9s cubic-bezier(.25,1.4,.4,1)', 'transform-origin': `${c}px ${c}px` }, svg);
  el('polygon', { points: `${c - 2.6},${c - 27} ${c + 2.6},${c - 27} ${c + 1.1},${c - (rOut - 2)} ${c - 1.1},${c - (rOut - 2)}`,
    fill: `url(#${id}-nd)`, filter: `url(#${id}-gl)` }, g);
  // bright core line so the needle stays readable when it sits on the redline
  el('line', { x1: c, y1: c - 28, x2: c, y2: c - (rOut - 3),
    stroke: '#ffe2dc', 'stroke-width': 1.1, 'stroke-linecap': 'round', opacity: 0.95 }, g);

  const rDisc = 30;
  el('circle', { cx: c, cy: c, r: rDisc, fill: `url(#${id}-fc)` }, svg);
  el('circle', { cx: c, cy: c, r: rDisc, fill: 'none', stroke: '#2a3140', 'stroke-width': 1, opacity: 0.9 }, svg);

  const labelEl = el('text', { x: c, y: c - 15, fill: '#c2cbdb', 'font-size': 8, 'letter-spacing': 1,
    'text-anchor': 'middle', 'font-weight': 700 }, svg);
  labelEl.textContent = 'SESSION';
  const digital = el('text', { x: c, y: c + 13, fill: '#ffc76e', 'font-size': 21, 'font-weight': 700,
    'text-anchor': 'middle', 'font-variant-numeric': 'tabular-nums',
    style: 'text-shadow:0 0 8px rgba(255,170,60,.55)' }, svg);
  const subEl = el('text', { x: c, y: c + 26, fill: '#aab4c8', 'font-size': 8.5, 'font-weight': 600,
    'text-anchor': 'middle', 'letter-spacing': .3 }, svg);

  return {
    set(frac) { g.style.transform = `rotate(${START + SWEEP * Math.max(0, Math.min(1, frac))}deg)`; },
    digital, sub: subEl, label: labelEl,
  };
}

const tach = buildTach(document.getElementById('gauge-session'));

// ---- bars ----
function makeBar(id) {
  const bar = document.getElementById(id);
  const fill = document.createElement('div');
  fill.className = 'fill';
  bar.appendChild(fill);
  return fill;
}
const bar1Fill = makeBar('bar1-bar');
const bar2Fill = makeBar('bar2-bar');

function remainingColor(pct) {
  if (pct > 60) return 'linear-gradient(90deg,#2fd06b,#7dffb0)';
  if (pct > 30) return 'linear-gradient(90deg,#e0a92a,#ffd76a)';
  return 'linear-gradient(90deg,#ff3b30,#ff8a6a)';
}
const TONE = {
  'info-amber': 'linear-gradient(90deg,#c98a2a,#ffd27a)',
  'info-blue': 'linear-gradient(90deg,#3a6ea5,#7fbfff)',
};

const $ = (id) => document.getElementById(id);

function applyBar(fill, nameId, valId, b) {
  $(nameId).innerHTML = `${b.label} ${b.wk ? '<span class="wk">WK</span>' : ''}`;
  const val = $(valId);
  fill.style.width = Math.max(0, Math.min(100, b.fillPct)) + '%';
  if (b.tone === 'remaining') {
    fill.style.background = remainingColor(b.fillPct);
    val.className = 'row-val';
  } else {
    fill.style.background = TONE[b.tone] || TONE['info-blue'];
    val.className = 'row-val dim';
  }
  val.textContent = b.valText;
}

function usedColor(pct) {
  if (pct == null) return '#3a4254';
  if (pct < 60) return 'linear-gradient(90deg,#2fd06b,#7dffb0)';
  if (pct < 85) return 'linear-gradient(90deg,#e0a92a,#ffd76a)';
  return 'linear-gradient(90deg,#ff3b30,#ff8a6a)';
}

function renderSecondary(sec, mode) {
  const strip = $('secondary');
  if (!sec) {
    strip.classList.add('hidden');
    document.body.classList.remove('dual');
    return;
  }
  strip.classList.remove('hidden');
  document.body.classList.add('dual');
  $('sec-name').textContent = sec.label;
  $('sec-live').classList.toggle('on', !!sec.live);

  // pin button reflects mode: lit amber = pinned, greyed = auto-following
  const pinned = mode !== 'auto';
  const pinBtn = $('sec-pin');
  pinBtn.classList.toggle('pinned', pinned);
  pinBtn.title = pinned
    ? '已锁定当前主显 · 点击恢复自动跟随 / pinned — click for auto-follow'
    : '自动跟随中 · 点击锁定当前主显 / auto-following — click to pin current';
  const setMetric = (valId, fillId, pct) => {
    $(valId).textContent = pct == null ? '–' : Math.round(pct) + '%';
    const f = $(fillId);
    f.style.width = pct == null ? '0%' : Math.max(0, Math.min(100, pct)) + '%';
    f.style.background = usedColor(pct);
  };
  setMetric('sec-s', 'sec-s-fill', sec.sessionPct);
  setMetric('sec-w', 'sec-w-fill', sec.weeklyPct);
}

// consumes the normalized payload produced by providers.js (Claude or Codex)
function render(p) {
  tach.set(p.tach.pct / 100);
  tach.digital.textContent = p.tach.text;
  tach.digital.setAttribute('fill', p.tach.red ? '#ff4d42' : '#ffc76e');
  tach.digital.setAttribute('style', p.tach.red
    ? 'text-shadow:0 0 10px rgba(255,60,40,.7)'
    : 'text-shadow:0 0 8px rgba(255,170,60,.55)');
  tach.sub.textContent = p.tach.sub;
  // color the source tag so SERVER/STALE/EST is obvious at a glance
  const SRC_COLOR = { server: '#5cff8f', stale: '#ffbe5c', est: '#c98a2a', local: '#aab4c8' };
  const SRC_GLOW = { server: '0 0 7px rgba(90,255,140,.85)', stale: '0 0 7px rgba(255,190,90,.7)' };
  const src = p.tach.src || 'local';
  tach.sub.setAttribute('fill', SRC_COLOR[src] || '#aab4c8');
  tach.sub.setAttribute('style', `font-weight:600; text-shadow:${SRC_GLOW[src] || 'none'}`);
  tach.label.textContent = p.tach.label;

  applyBar(bar1Fill, 'bar1-name', 'bar1-val', p.bars[0]);
  applyBar(bar2Fill, 'bar2-name', 'bar2-val', p.bars[1]);

  $('foot-left-val').textContent = p.footer.left.val;
  $('foot-left-label').textContent = p.footer.left.label;
  $('foot-right-val').textContent = p.footer.right.val;
  $('foot-right-label').textContent = p.footer.right.label;

  const lamp = $('lamp-live');
  lamp.style.color = '';
  lamp.classList.toggle('on', !!p.live);

  renderSecondary(p.secondary, p.mode);
  renderAlert(p.alert);
}

// Edge glow when a real limit is near: amber at warn (>=80%), red at crit
// (>=95%). The glow fades in as the level rises and settles into a slow
// breathing pulse. Nothing pops up or blocks — it reads like a dashboard
// tell-tale, matching the cluster's own warning language.
function renderAlert(alert) {
  const level = (alert && alert.level) || 'none';
  const panel = document.getElementById('panel');
  panel.classList.toggle('alert-warn', level === 'warn');
  panel.classList.toggle('alert-crit', level === 'crit');
  panel.title = level === 'none' ? '' : (alert.reason || '');
}

if (window.electronAPI) {
  window.electronAPI.onStats(render);
  window.electronAPI.onStatsError((msg) => {
    const lamp = $('lamp-live');
    lamp.classList.remove('on');
    lamp.style.color = '#ff5f56';
    lamp.title = msg;
  });
  $('btn-close').addEventListener('click', () => window.electronAPI.close());
  $('btn-hide').addEventListener('click', () => window.electronAPI.hide());
  // Two explicit buttons: ⇄ always swaps the primary; 📌 toggles pin/auto.
  // Drag-intent guard: a mouseup after >4px of pointer travel is a drag
  // attempt, not a click.
  const guardedClick = (id, fn) => {
    const el = $(id);
    let downAt = null;
    el.addEventListener('mousedown', (e) => { downAt = [e.screenX, e.screenY]; });
    el.addEventListener('click', (e) => {
      if (downAt && Math.hypot(e.screenX - downAt[0], e.screenY - downAt[1]) > 4) return;
      fn();
    });
  };
  guardedClick('sec-swap', () => window.electronAPI.swapProvider());
  guardedClick('sec-pin', () => window.electronAPI.togglePin());
} else {
  // browser demo (normalized payload)
  let t = 0;
  setInterval(() => {
    t += 0.05;
    const pct = 50 + 30 * Math.sin(t) + 12 * Math.sin(t * 3.3);
    const rem = 88 - 20 * (0.5 + 0.5 * Math.sin(t / 2));
    render({
      provider: 'claude', active: true, live: true,
      tach: { pct: Math.max(3, Math.min(97, pct)), text: Math.round(pct) + '%',
        sub: '8.4M · 2:36', red: pct >= 80, label: 'CLAUDE·5H' },
      bars: [
        { label: 'FABLE·5', wk: true, fillPct: rem, tone: 'remaining', valText: Math.round(rem) + '% left' },
        { label: 'ALL', wk: true, fillPct: 61, tone: 'remaining', valText: '61% left' },
      ],
      footer: { left: { val: '$8.62', label: 'today' }, right: { val: '2d 9h', label: 'wk reset' } },
      secondary: { provider: 'codex', label: 'CODEX',
        sessionPct: 20 + 15 * Math.sin(t / 2), weeklyPct: 8, live: true },
    });
  }, 700);
}
