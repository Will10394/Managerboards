import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitDoc, joinDoc, encode, decode, createSync } from '../src/sync.js';
import { createFakeBackend, memStorage, tick } from './fake-api.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
function sampleDoc() {
  return {
    version: 2, weekOf: '2026-09-21', statuses: ['PTO', 'Vacation'],
    skillsCatalog: [{ id: 'skc_1', name: 'Forklift', area: 'PIT' }],
    workspaces: {
      speed: { builders: [{ id: 'speed_b0', name: 'Ana', alias: 'ana' }], rotation: { Mon: { Q1: { speed_b0: 'Sort' } } }, quarterly: null },
      fa: {
        builders: [{ id: 'fa_b0', name: 'Ben', alias: 'benx' }], rotation: {},
        faShift: { fileName: 'shift.csv', uploadedAt: 1, headers: ['a', 'b'], rows: [['1', '2'], ['3', '4']] },
        binScan: null,
      },
    },
  };
}
function bigRows(n, seed = 0) { const rows = []; let x = seed + 1; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; rows.push(['SN' + x.toString(36), 'user' + (x % 97), new Date(1.7e12 + x).toISOString()]); } return rows; }

function client(api, opts = {}) {
  const storage = opts.storage || memStorage();
  const statuses = [];
  const s = createSync({ api, clientId: opts.id || 'c' + Math.random(), debounceMs: 5, chunkSize: opts.chunkSize || 150000, storage, onStatus: (x) => statuses.push(x), onConflict: opts.onConflict });
  return { s, storage, statuses };
}
async function settle(s) { for (let i = 0; i < 50; i++) { await tick(10); if (!s.hasPending()) return; } throw new Error('never settled'); }

test('split/join round-trips, blobs split out, null blobs stay inline', () => {
  const d = sampleDoc();
  const secs = splitDoc(d);
  assert.deepEqual(Object.keys(secs).sort(), ['root', 'ws~fa', 'ws~fa~faShift', 'ws~speed']);
  assert.deepEqual(secs['ws~fa'].__blobs, ['faShift']);
  assert.equal(secs['ws~fa'].binScan, null);
  assert.deepEqual(joinDoc(secs), d);
});

test('gzip encode/decode round-trips', async () => {
  const s = JSON.stringify({ rows: bigRows(2000) });
  const e = await encode(s);
  assert.ok(e.startsWith('gz:') && e.length < s.length);
  assert.equal(await decode(e), s);
});

test('empty cloud -> load returns null; seed uploads; second browser loads identical doc', async () => {
  const { api } = createFakeBackend();
  const a = client(api);
  assert.equal((await a.s.load()).doc, null);
  await a.s.seed(sampleDoc());
  const b = client(api);
  assert.deepEqual((await b.s.load()).doc, sampleDoc());
});

test('only changed sections are written', async () => {
  const { api, stats } = createFakeBackend();
  const a = client(api);
  await a.s.load(); await a.s.seed(sampleDoc());
  const before = { ...stats };
  const d = clone(sampleDoc()); d.workspaces.speed.builders[0].name = 'Ana M';
  a.s.save(d); await settle(a.s);
  assert.equal(stats.updates - before.updates, 1, 'one section update');
  assert.equal(stats.creates - before.creates, 0);
});

test('large import is chunked, reads back intact, and old chunks are garbage-collected', async () => {
  const { api, table } = createFakeBackend();
  const a = client(api, { chunkSize: 4000 });
  await a.s.load();
  const d = sampleDoc(); d.workspaces.speed.quarterly = { fileName: 'q.csv', headers: ['sn', 'who', 'ts'], rows: bigRows(3000) };
  await a.s.seed(d);
  const chunks = [...table.keys()].filter((k) => k.includes('#'));
  assert.ok(chunks.length > 3, 'chunked: ' + chunks.length);
  const b = client(api); assert.deepEqual((await b.s.load()).doc, d);
  const d2 = clone(d); d2.workspaces.speed.quarterly.rows = bigRows(3000, 7);
  a.s.save(d2); await settle(a.s); await tick(20);
  const revs = new Set([...table.keys()].filter((k) => k.startsWith('main/ws~speed~quarterly#')).map((k) => k.split('#')[1]));
  assert.equal(revs.size, 1, 'only current rev chunks remain');
  const c = client(api); assert.deepEqual((await c.s.load()).doc, d2);
});

test('clearing an import does not resurrect it on reload', async () => {
  const { api } = createFakeBackend();
  const a = client(api); await a.s.load(); await a.s.seed(sampleDoc());
  const d = clone(sampleDoc()); d.workspaces.fa.faShift = null;
  a.s.save(d); await settle(a.s);
  const b = client(api); assert.equal((await b.s.load()).doc.workspaces.fa.faShift, null);
});

test('live: another browser sees edits, including a brand-new import, without echo writes', async () => {
  const { api, stats } = createFakeBackend();
  const a = client(api, { id: 'A' }), b = client(api, { id: 'B' });
  api.subscribe((e) => a.s.handleEvent(e)); api.subscribe((e) => b.s.handleEvent(e));
  await a.s.load(); await a.s.seed(sampleDoc()); await b.s.load();
  const seen = []; b.s.onRemote((doc) => seen.push(doc));
  const d = clone(sampleDoc());
  d.workspaces.speed.rotation.Mon.Q1.speed_b0 = 'Receive';
  d.workspaces.fa.binScan = { fileName: 'bins.csv', headers: ['x'], rows: [['1']] };
  const writesBefore = stats.creates + stats.updates;
  a.s.save(d); await settle(a.s); await tick(50);
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen.at(-1), d);
  await tick(50);
  assert.equal(b.s.hasPending(), false, 'B has nothing to echo back');
  assert.equal(stats.creates + stats.updates - writesBefore, 3, 'A wrote binScan, ws~fa, ws~speed; B echoed nothing');
});

test('concurrent edits to the same workspace: both writes land, later one wins, revs stay monotonic', async () => {
  const { api, table } = createFakeBackend();
  const conflicts = [];
  const a = client(api, { id: 'A' }), b = client(api, { id: 'B', onConflict: (n) => conflicts.push(n) });
  await a.s.load(); await a.s.seed(sampleDoc()); await b.s.load();
  const da = clone(sampleDoc()); da.workspaces.speed.builders[0].name = 'From A';
  const db = clone(sampleDoc()); db.workspaces.speed.builders[0].name = 'From B';
  a.s.save(da); await settle(a.s);
  b.s.save(db); await settle(b.s);
  assert.deepEqual(conflicts, ['ws~speed']);
  const c = client(api); assert.equal((await c.s.load()).doc.workspaces.speed.builders[0].name, 'From B');
  assert.equal(table.get('main/ws~speed').rev, 3);
});

test('unsynced local edits (tab closed mid-save) are recovered on next load', async () => {
  const { api } = createFakeBackend();
  const a = client(api); await a.s.load(); await a.s.seed(sampleDoc());
  const storage = memStorage();
  const b1 = client(api, { storage }); await b1.s.load();
  const local = clone(sampleDoc()); local.weekOf = '2026-09-28';
  storage.setItem('rtCloudDirty', '1'); // simulate: save() called, flush never happened
  const b2 = client(api, { storage });
  const { doc, recovered } = await b2.s.load({ localDoc: local });
  assert.equal(recovered, true); assert.equal(doc.weekOf, '2026-09-28');
  await settle(b2.s);
  const c = client(api); assert.equal((await c.s.load()).doc.weekOf, '2026-09-28');
});

test('stale localStorage without the dirty flag never overrides the cloud', async () => {
  const { api } = createFakeBackend();
  const a = client(api); await a.s.load(); await a.s.seed(sampleDoc());
  const stale = clone(sampleDoc()); stale.weekOf = 'old';
  const b = client(api); const { doc } = await b.s.load({ localDoc: stale });
  assert.equal(doc.weekOf, '2026-09-21');
});
