// Calibration dialog logic. Reads current cost-weighted usage from main, and as
// the user types the official %, previews the implied limit ("= $X limit").
const api = window.electronAPI;
let cur = { fableCost: 0, allCost: 0, sessionCost: 0 };

const el = (id) => document.getElementById(id);
const fields = [
  { input: 'fable', eq: 'eq-fable', cost: () => cur.fableCost },
  { input: 'all', eq: 'eq-all', cost: () => cur.allCost },
  { input: 'session', eq: 'eq-session', cost: () => cur.sessionCost },
];

function preview() {
  for (const f of fields) {
    const p = parseFloat(el(f.input).value);
    if (p > 0 && f.cost() > 0) {
      el(f.eq).textContent = '= $' + (f.cost() / (p / 100)).toFixed(0) + ' limit';
    } else {
      el(f.eq).textContent = f.cost() > 0 ? '($' + f.cost().toFixed(0) + ' used)' : '';
    }
  }
}

async function init() {
  try { cur = await api.calGetCurrent(); } catch {}
  preview();
  el('fable').focus();
}

for (const f of fields) el(f.input).addEventListener('input', preview);

el('cancel').addEventListener('click', () => api.calClose());

el('apply').addEventListener('click', async () => {
  const pct = {
    fable: parseFloat(el('fable').value) || 0,
    all: parseFloat(el('all').value) || 0,
    session: parseFloat(el('session').value) || 0,
  };
  if (!pct.fable && !pct.all && !pct.session) {
    el('done').textContent = 'Enter at least one percentage.';
    el('done').style.color = '#ff8a6a';
    return;
  }
  await api.calApply(pct);
  el('done').style.color = '#5cff8f';
  el('done').textContent = '✓ Applied — widget updated';
  setTimeout(() => api.calClose(), 750);
});

// Enter submits, Esc cancels
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('apply').click();
  else if (e.key === 'Escape') api.calClose();
});

init();
