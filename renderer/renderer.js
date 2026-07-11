// Compact luxury instrument cluster: one small tachometer (5h session) + two
// segmented "fuel" bars (Fable-5 weekly, all-model weekly). Pure SVG/DOM.
const NS = 'http://www.w3.org/2000/svg';
const SWEEP = 260, START = -130;

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

  el('text', { x: c, y: c - 15, fill: '#c2cbdb', 'font-size': 8.5, 'letter-spacing': 1.2,
    'text-anchor': 'middle', 'font-weight': 700 }, svg).textContent = 'SESSION';
  const digital = el('text', { x: c, y: c + 13, fill: '#ffc76e', 'font-size': 21, 'font-weight': 700,
    'text-anchor': 'middle', 'font-variant-numeric': 'tabular-nums',
    style: 'text-shadow:0 0 8px rgba(255,170,60,.55)' }, svg);
  const subEl = el('text', { x: c, y: c + 26, fill: '#aab4c8', 'font-size': 8.5, 'font-weight': 600,
    'text-anchor': 'middle', 'letter-spacing': .3 }, svg);

  const g = el('g', { style: 'transition:transform .9s cubic-bezier(.25,1.4,.4,1)', 'transform-origin': `${c}px ${c}px` }, svg);
  el('polygon', { points: `${c - 1.4},${c + 5} ${c + 1.4},${c + 5} ${c + 0.5},${c - rInMaj} ${c - 0.5},${c - rInMaj}`,
    fill: `url(#${id}-nd)`, filter: `url(#${id}-gl)` }, g);
  el('circle', { cx: c, cy: c, r: 5, fill: '#1a1e28', stroke: '#4a5266', 'stroke-width': 1 }, svg);
  el('circle', { cx: c, cy: c, r: 2.3, fill: '#2c3242' }, svg);

  return {
    set(frac) { g.style.transform = `rotate(${START + SWEEP * Math.max(0, Math.min(1, frac))}deg)`; },
    digital, sub: subEl,
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
const fableFill = makeBar('fable-bar');
const allFill = makeBar('all-bar');

function barColor(pct, remaining) {
  // remaining bars: green when plenty, red when nearly gone
  const v = remaining ? pct : 100 - pct;
  if (v > 60) return 'linear-gradient(90deg,#2fd06b,#7dffb0)';
  if (v > 30) return 'linear-gradient(90deg,#e0a92a,#ffd76a)';
  return 'linear-gradient(90deg,#ff3b30,#ff8a6a)';
}

// ---- formatting ----
function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtCountdown(ms) {
  if (ms <= 0) return '--:--';
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
function fmtDaysHours(ms) {
  if (ms == null || ms <= 0) return '--';
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  return `${Math.floor(ms / 60000)}m`;
}
const $ = (id) => document.getElementById(id);

function render(s) {
  // session tach — digital goes red in the redline zone, like a real cluster
  tach.set(s.sessionPct / 100);
  tach.digital.textContent = s.active ? Math.round(s.sessionPct) + '%' : 'IDLE';
  const inRed = s.active && s.sessionPct >= 80;
  tach.digital.setAttribute('fill', inRed ? '#ff4d42' : '#ffc76e');
  tach.digital.setAttribute('style', inRed
    ? 'text-shadow:0 0 10px rgba(255,60,40,.7)'
    : 'text-shadow:0 0 8px rgba(255,170,60,.55)');
  tach.sub.textContent = s.active ? fmtTokens(s.sessionTokens) + ' · ' + fmtCountdown(s.resetInMs) : '5h window';

  // FABLE weekly row
  if (s.fableRemainingPct != null) {
    fableFill.style.width = s.fableRemainingPct + '%';
    fableFill.style.background = barColor(s.fableRemainingPct, true);
    $('fable-val').className = 'row-val';
    $('fable-val').textContent = Math.round(s.fableRemainingPct) + '% left';
  } else {
    // uncalibrated: show used amount; bar reflects Fable's share of the week
    const share = s.weekTokens > 0 ? (s.fableWeekTokens / s.weekTokens) * 100 : 0;
    fableFill.style.width = Math.max(2, share) + '%';
    fableFill.style.background = 'linear-gradient(90deg,#c98a2a,#ffd27a)';
    $('fable-val').className = 'row-val dim';
    $('fable-val').textContent = fmtTokens(s.fableWeekTokens) + ' used · set limit';
  }

  // ALL weekly row
  if (s.weeklyRemainingPct != null) {
    allFill.style.width = s.weeklyRemainingPct + '%';
    allFill.style.background = barColor(s.weeklyRemainingPct, true);
    $('all-val').className = 'row-val';
    $('all-val').textContent = Math.round(s.weeklyRemainingPct) + '% left';
  } else {
    allFill.style.width = Math.max(2, s.weeklyPct) + '%';
    allFill.style.background = 'linear-gradient(90deg,#3a6ea5,#7fbfff)';
    $('all-val').className = 'row-val dim';
    $('all-val').textContent = fmtTokens(s.weekTokens) + ' used';
  }

  // footer: weekly reset countdown (the 5h countdown already lives in the tach)
  $('today-cost').textContent = '$' + s.dayCost.toFixed(2);
  $('block-reset').textContent = fmtDaysHours(s.weekResetInMs);
  const lamp = $('lamp-live');
  lamp.style.color = ''; // clear any error tint from a previous bad poll
  const live = s.lastActivity && Date.now() - s.lastActivity < 90000;
  lamp.classList.toggle('on', !!live);
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
} else {
  // browser demo
  let t = 0;
  setInterval(() => {
    t += 0.05;
    const pct = 50 + 30 * Math.sin(t) + 12 * Math.sin(t * 3.3);
    render({
      active: true,
      sessionPct: Math.max(3, Math.min(97, pct)),
      sessionTokens: 8.4e6 * (pct / 100),
      resetInMs: 2.6 * 3600 * 1000,
      dayCost: 8.62, weekTokens: 148e6, fableWeekTokens: 96e6,
      fableRemainingPct: 88 - 20 * (0.5 + 0.5 * Math.sin(t / 2)),
      weeklyRemainingPct: 61 - 15 * (0.5 + 0.5 * Math.sin(t / 3)),
      weekResetInMs: 2.4 * 86400000,
      lastActivity: Date.now(),
    });
  }, 700);
}
