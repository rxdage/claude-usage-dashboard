// Guided official-usage setup. Polls main for credential/state and drives the
// three steps: find CLI -> sign in -> verify SERVER.
const api = window.electronAPI;
const $ = (id) => document.getElementById(id);
const setStatus = (msg, cls) => { const s = $('status'); s.textContent = msg || ''; s.className = 'status' + (cls ? ' ' + cls : ''); };
const setStep = (id, state, sub) => {
  const el = $(id);
  el.classList.toggle('done', state === 'done');
  el.classList.toggle('active', state === 'active');
  el.querySelector('.dot').textContent = state === 'done' ? '✓' : id.slice(2, 3);
  if (sub != null) el.querySelector('.sub').textContent = sub;
};

let loggingIn = false;
let done = false;
let verifying = false;     // an enable+probe is in flight
let lastVerifyAt = 0;      // throttle re-verify so the 2s poll can't hammer the endpoint
const VERIFY_COOLDOWN_MS = 20000;

async function refresh() {
  if (done) return;
  let st;
  try { st = await api.setupState(); } catch { return; }

  // step 1: CLI
  setStep('s-cli', st.cliFound ? 'done' : 'active',
    st.cliFound ? (st.proxy ? 'found · proxy detected' : 'found') : 'not found');

  // fully connected already?
  if (st.server) {
    setStep('s-login', 'done', st.subscriptionType ? `signed in · ${st.subscriptionType}` : 'signed in');
    setStep('s-verify', 'done', 'official data live');
    setStatus('✓ Connected — the widget now shows SERVER numbers.', 'ok');
    $('primary').textContent = 'Done';
    $('primary').disabled = false;
    done = true;
    return;
  }

  // An expired ACCESS token is fine — the backend auto-refreshes it from the
  // refresh token. Only block verify when the REFRESH token is also expired
  // (then a real re-login is needed). Requiring !accessExpired here used to
  // strand the wizard on "waiting for sign-in" after an overnight sleep.
  const readyToVerify = st.loggedIn && st.hasProfileScope && !st.refreshExpired;

  // step 2: login
  if (st.loggedIn && st.hasProfileScope) {
    setStep('s-login', 'done', st.subscriptionType ? `signed in · ${st.subscriptionType}` : 'signed in');
  } else if (loggingIn) {
    setStep('s-login', 'active', 'waiting for browser authorization…');
  } else if (st.loggedIn && !st.hasProfileScope) {
    setStep('s-login', 'active', 'signed in, but missing usage scope — sign in again');
  } else {
    setStep('s-login', st.cliFound ? 'active' : '', 'not signed in');
  }

  // step 3: verify — enable+probe. Throttled: the 2s poll must not fire a fresh
  // network request every tick (that would hammer the usage endpoint into 429).
  if (readyToVerify) {
    if (!verifying && Date.now() - lastVerifyAt >= VERIFY_COOLDOWN_MS) {
      verifying = true;
      setStep('s-verify', 'active', 'enabling…');
      let r;
      try { r = await api.setupEnable(); } finally { verifying = false; lastVerifyAt = Date.now(); }
      if (r && r.kind === 'official') { done = false; return refresh(); }
      const kind = r && r.kind;
      setStep('s-verify', 'active', kind === 'estimate' ? 'could not reach server — will retry' : (kind || 'error'));
      setStatus(kind === 'estimate' ? 'Signed in, but the usage request failed (network/proxy). Retrying…' : '', 'warn');
    }
  } else if (st.refreshExpired) {
    setStep('s-verify', '', 'session expired — sign in again');
  } else {
    setStep('s-verify', '', 'waiting for sign-in');
  }

  // primary button
  const btn = $('primary');
  if (st.cliFound) {
    btn.disabled = false;
    btn.textContent = (st.loggedIn && st.hasProfileScope) ? 'Re-sign in' : 'Sign in';
  } else {
    btn.disabled = true;
    btn.textContent = 'Sign in';
    setStatus('Claude Code CLI not found. Install Claude Code or the Claude desktop app first.', 'err');
  }
}

$('primary').addEventListener('click', async () => {
  if (done) { api.setupClose(); return; }
  loggingIn = true;
  setStatus('A terminal opened — approve the sign-in in your browser. '
    + 'If asked to paste a code there: the paste is invisible (read like a '
    + 'password) — right-click to paste, then press Enter.', '');
  setStep('s-login', 'active', 'waiting for browser authorization…');
  const r = await api.setupLogin();
  if (!r.ok) { setStatus('Could not launch sign-in: ' + r.error, 'err'); loggingIn = false; }
});
$('close').addEventListener('click', () => api.setupClose());

refresh();
setInterval(refresh, 2000); // poll so login completion is picked up automatically
