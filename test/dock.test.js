// Tests for the edge-docking geometry (dock.js).
// Runs with: `node --test test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decideDock, dockBounds, HANDLE_PX, DOCK_FRACTION } = require('../dock');

const AREA = { x: 0, y: 0, width: 1200, height: 800 };
const W = 300, H = 140;
const OUT_W = W * DOCK_FRACTION;   // 90px with the 30% threshold
const OUT_H = H * DOCK_FRACTION;   // 42px
const at = (x, y) => ({ x, y, width: W, height: H });

test('fully inside: no dock', () => {
  assert.equal(decideDock(at(400, 300), AREA), null);
});

test('right edge: docks at >=30% out, not just under', () => {
  assert.equal(decideDock(at(1200 - W + OUT_W, 300), AREA), 'right');      // exactly 30% out
  assert.equal(decideDock(at(1200 - W + OUT_W - 1, 300), AREA), null);     // 1px under
  assert.equal(decideDock(at(1150, 300), AREA), 'right');                  // deep out
});

test('left edge symmetric', () => {
  assert.equal(decideDock(at(-OUT_W, 300), AREA), 'left');
  assert.equal(decideDock(at(-OUT_W + 1, 300), AREA), null);
});

test('bottom edge uses height', () => {
  assert.equal(decideDock(at(400, 800 - H + OUT_H), AREA), 'bottom');
  assert.equal(decideDock(at(400, 800 - H + OUT_H - 1), AREA), null);
});

test('corner drop: the deeper overflow wins', () => {
  // far out right, just past threshold at the bottom -> right
  const b = { x: 1200 - W + OUT_W + 60, y: 800 - H + OUT_H, width: W, height: H };
  assert.equal(decideDock(b, AREA), 'right');
});

test('dockBounds leaves exactly HANDLE_PX visible', () => {
  const r = dockBounds('right', at(1150, 300), AREA);
  assert.equal(r.x, 1200 - HANDLE_PX);
  const l = dockBounds('left', at(-200, 300), AREA);
  assert.equal(l.x + W, HANDLE_PX);                    // right edge of window pokes in
  const b = dockBounds('bottom', at(400, 750), AREA);
  assert.equal(b.y, 800 - HANDLE_PX);
});

test('dockBounds clamps the cross axis fully on-screen', () => {
  const r = dockBounds('right', at(1150, -50), AREA);  // dragged high past the top
  assert.equal(r.y, 0);
  const r2 = dockBounds('right', at(1150, 790), AREA); // and low past the bottom
  assert.equal(r2.y, 800 - H);
  const b = dockBounds('bottom', at(-80, 750), AREA);
  assert.equal(b.x, 0);
});

test('offset work area (secondary monitor / taskbar) respected', () => {
  const area2 = { x: 1200, y: 100, width: 1000, height: 700 };
  assert.equal(decideDock({ x: 2200 - W / 2, y: 300, width: W, height: H }, area2), 'right');
  const r = dockBounds('right', { x: 2100, y: 300, width: W, height: H }, area2);
  assert.equal(r.x, 2200 - HANDLE_PX);
});
