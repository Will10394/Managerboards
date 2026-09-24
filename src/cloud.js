// Loaded (as dist/cloud.js) before the Rotation Tracker's bundler starts.
// 1. signs the user in (Cognito), 2. pulls the shared dataset from DynamoDB,
// 3. exposes window.RTCloud, which the tracker's loadData()/save() hooks use.
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/api';
import {
  signIn, confirmSignIn, signOut, getCurrentUser, fetchUserAttributes,
  resetPassword, confirmResetPassword,
} from 'aws-amplify/auth';
import outputs from '../amplify_outputs.json';
import { createSync } from './sync.js';

Amplify.configure(outputs);
const gql = generateClient({ authMode: 'userPool' });

const APP_KEY = 'rotationTrackerV2'; // the tracker's own localStorage key
const CLIENT_ID = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
const FIELDS = 'id rev parts updatedBy updatedByUser';

// ---------------------------------------------------------------- AppSync adapter
function wrapErr(e) {
  const errs = (e && e.errors) || [];
  const conflict = errs.some((x) => /ConditionalCheckFailed/i.test((x.errorType || '') + ' ' + (x.message || '')));
  const err = new Error(errs.map((x) => x.message).join('; ') || (e && e.message) || String(e));
  err.conflict = conflict;
  err.raw = e;
  return err;
}
async function run(query, variables) {
  try { return (await gql.graphql({ query, variables })).data; } catch (e) { throw wrapErr(e); }
}
const api = {
  async list() {
    const out = []; let nextToken = null;
    do {
      const d = await run(`query L($t:String){ listTrackerDocs(limit:1000,nextToken:$t){ items{ id rev parts } nextToken } }`, { t: nextToken });
      out.push(...d.listTrackerDocs.items.filter(Boolean));
      nextToken = d.listTrackerDocs.nextToken;
    } while (nextToken);
    return out;
  },
  async get(id) {
    const d = await run(`query G($id:ID!){ getTrackerDoc(id:$id){ ${FIELDS} data } }`, { id });
    return d.getTrackerDoc;
  },
  async create(input) {
    return (await run(`mutation C($i:CreateTrackerDocInput!){ createTrackerDoc(input:$i){ ${FIELDS} } }`, { i: input })).createTrackerDoc;
  },
  async update(input, condition) {
    return (await run(`mutation U($i:UpdateTrackerDocInput!,$c:ModelTrackerDocConditionInput){ updateTrackerDoc(input:$i,condition:$c){ ${FIELDS} } }`, { i: input, c: condition || null })).updateTrackerDoc;
  },
  async del(id) {
    await run(`mutation D($i:DeleteTrackerDocInput!){ deleteTrackerDoc(input:$i){ id } }`, { i: { id } });
  },
  subscribe(cb) {
    const subs = [];
    const start = () => {
      for (const [op, key] of [['onCreateTrackerDoc', 'onCreateTrackerDoc'], ['onUpdateTrackerDoc', 'onUpdateTrackerDoc']]) {
        const sub = gql.graphql({ query: `subscription { ${op} { ${FIELDS} } }` }).subscribe({
          next: ({ data }) => cb(data && data[key]),
          error: () => { setPill('live', 'Live updates paused — reconnecting'); setTimeout(() => { stop(); start(); }, 5000); },
        });
        subs.push(sub);
      }
    };
    const stop = () => { while (subs.length) { try { subs.pop().unsubscribe(); } catch (e) {} } };
    start();
    return stop;
  },
};

// ---------------------------------------------------------------- UI
const ACCENT = '#ff9425';
const css = `
#rtc-login{position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;
  background:#0f1216;color:#e8ecf1;font:15px/1.45 'Barlow',system-ui,-apple-system,sans-serif}
#rtc-login .card{width:min(380px,92vw);background:#171b21;border:1px solid #262c35;border-radius:14px;padding:28px 26px 22px;
  box-shadow:0 20px 60px rgba(0,0,0,.45);border-top:3px solid ${ACCENT}}
#rtc-login h1{font:700 26px/1.1 'Barlow Condensed','Barlow',system-ui,sans-serif;letter-spacing:.02em;text-transform:uppercase;margin:0 0 4px}
#rtc-login .sub{color:#8a94a3;font-size:13px;margin-bottom:20px}
#rtc-login label{display:block;font-size:12px;color:#8a94a3;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 5px}
#rtc-login input{width:100%;box-sizing:border-box;background:#0f1216;border:1px solid #2c333d;border-radius:8px;color:#e8ecf1;
  padding:10px 12px;font:inherit;outline:none}
#rtc-login input:focus{border-color:${ACCENT}}
#rtc-login button.primary{width:100%;margin-top:18px;background:${ACCENT};color:#16100a;border:0;border-radius:8px;padding:11px;
  font:700 15px 'Barlow Condensed','Barlow',system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
#rtc-login button.primary:disabled{opacity:.6;cursor:default}
#rtc-login .link{background:none;border:0;color:#8a94a3;font:inherit;font-size:13px;cursor:pointer;margin-top:14px;padding:0;text-decoration:underline}
#rtc-login .err{color:#ff8a80;font-size:13px;margin-top:12px;min-height:1em}
#rtc-login .msg{color:#34d17a;font-size:13px;margin-top:12px}
#rtc-login .spin{display:flex;gap:10px;align-items:center;color:#8a94a3}
#rtc-login .spin i{width:14px;height:14px;border:2px solid #2c333d;border-top-color:${ACCENT};border-radius:50%;animation:rtcs .8s linear infinite}
@keyframes rtcs{to{transform:rotate(360deg)}}
#rtc-pill{position:fixed;left:12px;bottom:12px;z-index:9000;display:flex;gap:8px;align-items:center;
  background:rgba(23,27,33,.92);border:1px solid #262c35;border-radius:999px;padding:5px 12px;color:#aab3c0;
  font:600 12px/1 'Barlow Condensed','Barlow',system-ui,sans-serif;letter-spacing:.04em;backdrop-filter:blur(4px)}
#rtc-pill .dot{width:8px;height:8px;border-radius:50%;background:#34d17a}
#rtc-pill[data-s=saving] .dot,#rtc-pill[data-s=pending] .dot{background:${ACCENT}}
#rtc-pill[data-s=error] .dot,#rtc-pill[data-s=live] .dot{background:#ff5b5b}
#rtc-pill button{background:none;border:0;color:#6f7986;font:inherit;cursor:pointer;padding:0 0 0 6px;border-left:1px solid #313843}
#rtc-pill button:hover{color:#e8ecf1}
`;
function injectCss(doc = document) {
  if (doc.getElementById('rtc-css')) return;
  const s = doc.createElement('style'); s.id = 'rtc-css'; s.textContent = css;
  (doc.head || doc.documentElement).appendChild(s);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let overlay;
function screen(html) {
  injectCss();
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'rtc-login'; document.body.appendChild(overlay); }
  overlay.innerHTML = `<div class="card"><h1>Rotation Tracker</h1>${html}</div>`;
  return overlay;
}
function hideScreen() { if (overlay) { overlay.remove(); overlay = null; } }
function busy(text) { screen(`<div class="sub">&nbsp;</div><div class="spin"><i></i>${esc(text)}</div>`); }

function form(html, onSubmit) {
  const el = screen(`<form novalidate>${html}<div class="err"></div></form>`);
  const f = el.querySelector('form');
  const errEl = f.querySelector('.err');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = f.querySelector('button.primary');
    btn.disabled = true; errEl.textContent = '';
    try { await onSubmit(Object.fromEntries(new FormData(f)), f); }
    catch (e) { errEl.textContent = (e && e.message) || String(e); btn.disabled = false; }
  });
  const first = f.querySelector('input'); if (first) setTimeout(() => first.focus(), 0);
  return f;
}

function loginFlow() {
  return new Promise((resolve) => {
    const showSignIn = (note) => {
      const f = form(`
        <div class="sub">Sign in with your work email</div>
        <label>Email</label><input name="email" type="email" autocomplete="username" required>
        <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
        <button class="primary" type="submit">Sign in</button>
        ${note ? `<div class="msg">${esc(note)}</div>` : ''}
        <button class="link" type="button" data-forgot>Forgot password?</button>`,
      async ({ email, password }) => {
        const r = await signIn({ username: email.trim(), password });
        if (r.isSignedIn) return resolve();
        if (r.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return showNewPassword();
        if (r.nextStep.signInStep === 'RESET_PASSWORD') return showReset(email.trim());
        throw new Error('Unsupported sign-in step: ' + r.nextStep.signInStep);
      });
      f.querySelector('[data-forgot]').onclick = () => showForgot(f.email.value.trim());
    };
    const showNewPassword = () => form(`
        <div class="sub">First sign-in — choose your own password (8+ characters, upper, lower, number, symbol)</div>
        <label>New password</label><input name="pw" type="password" autocomplete="new-password" required>
        <label>Confirm</label><input name="pw2" type="password" autocomplete="new-password" required>
        <button class="primary" type="submit">Set password</button>`,
      async ({ pw, pw2 }) => {
        if (pw !== pw2) throw new Error("Passwords don't match");
        const r = await confirmSignIn({ challengeResponse: pw });
        if (r.isSignedIn) return resolve();
        throw new Error('Unexpected step: ' + r.nextStep.signInStep);
      });
    const showForgot = (email) => {
      const f = form(`
        <div class="sub">We'll email you a reset code</div>
        <label>Email</label><input name="email" type="email" required value="${esc(email || '')}">
        <button class="primary" type="submit">Send code</button>
        <button class="link" type="button" data-back>Back to sign in</button>`,
      async ({ email }) => { await resetPassword({ username: email.trim() }); showReset(email.trim()); });
      f.querySelector('[data-back]').onclick = () => showSignIn();
    };
    const showReset = (email) => {
      const f = form(`
        <div class="sub">Enter the code sent to ${esc(email)}</div>
        <label>Code</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required>
        <label>New password</label><input name="pw" type="password" autocomplete="new-password" required>
        <button class="primary" type="submit">Reset password</button>
        <button class="link" type="button" data-back>Back to sign in</button>`,
      async ({ code, pw }) => {
        await confirmResetPassword({ username: email, confirmationCode: code.trim(), newPassword: pw });
        showSignIn('Password updated — sign in with your new password.');
      });
      f.querySelector('[data-back]').onclick = () => showSignIn();
    };
    showSignIn();
  });
}

// ---------------------------------------------------------------- status pill
let pill, pillState = 'saved', pillText = 'Synced', userEmail = '';
function setPill(s, text) {
  pillState = s; pillText = text;
  if (!pill || !pill.isConnected) return;
  pill.dataset.s = s;
  pill.querySelector('span').textContent = text;
}
function mountPill() {
  if (pill && pill.isConnected) return;
  injectCss();
  pill = document.createElement('div'); pill.id = 'rtc-pill';
  pill.innerHTML = `<i class="dot"></i><span></span><button type="button" title="${esc(userEmail)}">Sign out</button>`;
  pill.querySelector('button').onclick = async () => {
    if (sync.hasPending()) { await sync.flush(); }
    await signOut(); location.reload();
  };
  document.body.appendChild(pill);
  setPill(pillState, pillText);
}
const STATUS_TEXT = { pending: 'Saving…', saving: 'Saving…', saved: 'Synced' };

// ---------------------------------------------------------------- boot
const sync = createSync({
  api,
  clientId: CLIENT_ID,
  storage: localStorage,
  onStatus: (s, e) => {
    if (s === 'error') { console.error('[RTCloud] save failed', e); setPill('error', 'Save failed — retrying'); }
    else setPill(s, STATUS_TEXT[s] || s);
  },
  onConflict: (section, who) => console.warn(`[RTCloud] ${section} was also changed by ${who || 'someone'}; your edit was saved on top.`),
});

function readLocal() {
  try { const s = localStorage.getItem(APP_KEY); const d = s && JSON.parse(s); return d && d.workspaces ? d : null; } catch (e) { return null; }
}

async function boot() {
  try { await getCurrentUser(); } catch (e) { await loginFlow(); }
  try { userEmail = (await fetchUserAttributes()).email || ''; } catch (e) {}
  sync.setUserLabel(userEmail);
  api.subscribe((evt) => sync.handleEvent(evt));

  for (;;) {
    busy('Loading shared data…');
    try {
      const localDoc = readLocal();
      const { doc } = await sync.load({ localDoc });
      if (doc) {
        RTCloud.initialData = doc;
      } else if (localDoc && confirm(
        'The cloud tracker is empty.\n\nUpload the Rotation Tracker data saved in THIS browser so everyone shares it?\n\n' +
        'OK = upload this browser\'s data\nCancel = start from the sample data')) {
        RTCloud.initialData = localDoc;
        busy('Uploading…');
        await sync.seed(localDoc);
      }
      break;
    } catch (e) {
      console.error(e);
      await new Promise((res) => {
        const f = form(`<div class="sub">Couldn't reach the server.</div><div class="err">${esc(e.message || e)}</div>
          <button class="primary" type="submit">Retry</button>`, async () => res());
        return f;
      });
    }
  }
  hideScreen();
}

window.addEventListener('beforeunload', (e) => {
  if (sync.hasPending()) { sync.flush(); e.preventDefault(); e.returnValue = ''; }
});

const RTCloud = {
  initialData: null,
  ready: null,
  save: (doc) => sync.save(doc),
  onRemote: (fn) => { mountPill(); return sync.onRemote(fn); },
  flush: () => sync.flush(),
  get user() { return userEmail; },
};
window.RTCloud = RTCloud;
RTCloud.ready = new Promise((res) => {
  const go = () => boot().then(res, (e) => { console.error(e); screen(`<div class="err">${esc(e.message || e)}</div>`); });
  if (document.body) go(); else document.addEventListener('DOMContentLoaded', go, { once: true });
});
