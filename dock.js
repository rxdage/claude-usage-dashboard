// Edge docking: drag the widget more than half past a screen edge and it
// collapses into a slim grab handle hugging that edge; click the handle to
// bring it back. This module is the pure geometry — window plumbing lives in
// main.js, the handle UI in the renderer.
//
// Top is deliberately excluded: Windows clamps drags so a window's grab area
// can never go above the work area, so a top overflow of >=50% is unreachable.
const HANDLE_PX = 12; // strip of the window left visible while docked
const DOCK_SIDES = ['left', 'right', 'bottom'];
const DOCK_FRACTION = 0.3; // how much of the window must hang past an edge

// Where (if anywhere) should a window dropped at bounds `b` dock?
// A side qualifies when >=30% of the window hangs past that edge — a light
// flick is enough, no need to shove most of it off-screen. With several
// qualifying (dragged into a corner), the deepest overflow wins.
function decideDock(b, area) {
  const out = {
    left: area.x - b.x,
    right: (b.x + b.width) - (area.x + area.width),
    bottom: (b.y + b.height) - (area.y + area.height),
  };
  let side = null;
  if (out.left >= b.width * DOCK_FRACTION) side = 'left';
  if (out.right >= b.width * DOCK_FRACTION && (!side || out.right > out[side])) side = 'right';
  if (out.bottom >= b.height * DOCK_FRACTION && (!side || out.bottom > out[side])) side = 'bottom';
  return side;
}

// Window bounds while docked: same size, positioned so exactly HANDLE_PX of
// it stays on-screen along `side`, and the on-screen strip sits fully inside
// the work area on the other axis.
function dockBounds(side, b, area) {
  const clampX = Math.min(Math.max(b.x, area.x), area.x + area.width - b.width);
  const clampY = Math.min(Math.max(b.y, area.y), area.y + area.height - b.height);
  if (side === 'left') return { x: area.x - (b.width - HANDLE_PX), y: clampY, width: b.width, height: b.height };
  if (side === 'right') return { x: area.x + area.width - HANDLE_PX, y: clampY, width: b.width, height: b.height };
  return { x: clampX, y: area.y + area.height - HANDLE_PX, width: b.width, height: b.height }; // bottom
}

module.exports = { decideDock, dockBounds, HANDLE_PX, DOCK_SIDES, DOCK_FRACTION };
