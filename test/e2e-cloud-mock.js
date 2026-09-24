// E2E stand-in for src/cloud.js: same window.RTCloud contract, no Cognito, and an
// HTTP "table" that the Playwright runner serves (shared between browser tabs).
import { createSync } from '../src/sync.js';
const call = async (op, body) => {
  const r = await fetch('http://fake.local/api/' + op, { method: 'POST', body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error); e.conflict = !!j.conflict; throw e; }
  return j.result;
};
const api = {
  list: () => call('list'), get: (id) => call('get', { id }),
  create: (input) => call('create', { input }), update: (input, condition) => call('update', { input, condition }),
  del: (id) => call('del', { id }),
  subscribe(cb) { let since = 0; const t = setInterval(async () => { for (const e of await call('events', { since })) { since = e.seq; cb(e); } }, 150); return () => clearInterval(t); },
};
const sync = createSync({ api, clientId: String(Math.random()), storage: localStorage, debounceMs: 200, onStatus: (s) => { window.__rtStatus = s; } });
const RTCloud = window.RTCloud = { initialData: null, save: (d) => sync.save(d), onRemote: (fn) => sync.onRemote(fn), flush: () => sync.flush(), hasPending: () => sync.hasPending() };
RTCloud.ready = (async () => {
  api.subscribe((e) => sync.handleEvent(e));
  let local = null; try { local = JSON.parse(localStorage.getItem('rotationTrackerV2')); } catch (e) {}
  const { doc } = await sync.load({ localDoc: local });
  if (doc) RTCloud.initialData = doc;
  else if (local && local.workspaces && confirm('upload local?')) { RTCloud.initialData = local; await sync.seed(local); }
})();
