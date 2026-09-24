// Rotation Tracker ⇄ DynamoDB sync engine.
//
// The app keeps one big JSON document (what used to live in localStorage under
// 'rotationTrackerV2'). Storing that as a single DynamoDB item would hit the 400 KB
// item limit as soon as a couple of quarterly CSVs are imported, and every tiny edit
// would re-upload megabytes. So the document is split into sections:
//
//   root            everything except `workspaces`, plus __ws: [workspace keys]
//   ws~<key>        one workspace, minus its CSV blobs, plus __blobs: [field names]
//   ws~<key>~<fld>  any workspace field shaped like an import ({ …, rows:[…] })
//
// Only sections whose JSON changed since the last save/load are written. Each
// section is gzip+base64'd and, if still too big, split across chunk items.
//
// `api` is injected (see cloud.js for the AppSync version, test/ for an in-memory one):
//   list()                    -> [{ id, rev, parts }]
//   get(id)                   -> { id, data, parts, rev, updatedBy } | null
//   create(input)             -> throws err.conflict=true if the id already exists
//   update(input, condition)  -> condition = { rev: { eq: n } }; throws err.conflict on mismatch
//   del(id)
//   subscribe(cb)             -> unsubscribe fn; cb({ id, rev, parts, updatedBy })

export function splitDoc(doc) {
  const out = {};
  const root = { ...doc };
  delete root.workspaces;
  const ws = doc.workspaces || {};
  root.__ws = Object.keys(ws);
  out.root = root;
  for (const k of root.__ws) {
    const w = { ...ws[k] };
    const blobs = [];
    for (const f of Object.keys(w)) {
      const v = w[f];
      if (v && typeof v === 'object' && Array.isArray(v.rows)) {
        out[`ws~${k}~${f}`] = v;
        blobs.push(f);
        delete w[f];
      }
    }
    w.__blobs = blobs;
    out[`ws~${k}`] = w;
  }
  return out;
}

export function joinDoc(sections) {
  if (!sections || !sections.root) return null;
  const doc = { ...sections.root };
  const keys = doc.__ws || [];
  delete doc.__ws;
  doc.workspaces = {};
  for (const k of keys) {
    const s = sections[`ws~${k}`];
    if (!s) continue; // not arrived yet (remote write in progress)
    const w = { ...s };
    for (const f of w.__blobs || []) w[f] = sections[`ws~${k}~${f}`] ?? null;
    delete w.__blobs;
    doc.workspaces[k] = w;
  }
  return doc;
}

// children first (blobs, then workspaces, then root) so a reader never sees a
// parent that references a child which doesn't exist yet
const depth = (name) => name.split('~').length;
const writeOrder = (names) => [...names].sort((a, b) => depth(b) - depth(a));

// ---------- gzip + base64 ----------
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
export async function encode(jsonStr) {
  if (typeof CompressionStream === 'undefined') return 'raw:' + jsonStr;
  return 'gz:' + toB64(await pipe(new TextEncoder().encode(jsonStr), new CompressionStream('gzip')));
}
export async function decode(payload) {
  if (payload.startsWith('raw:')) return payload.slice(4);
  if (payload.startsWith('gz:')) return new TextDecoder().decode(await pipe(fromB64(payload.slice(3)), new DecompressionStream('gzip')));
  return payload; // plain JSON
}

// ---------- engine ----------
export function createSync({
  api,
  clientId,
  userLabel = '',
  prefix = 'main/',
  chunkSize = 150_000, // chars per item; keeps AppSync payloads well under limits
  debounceMs = 800,
  storage = null,      // localStorage-like, used for the "unsynced changes" flag
  dirtyKey = 'rtCloudDirty',
  onStatus = () => {},
  onConflict = () => {},
}) {
  const heads = {};      // section -> { rev, parts } as last written/read by us
  const lastJson = {};   // section -> JSON string last known to be in the cloud
  let cache = {};        // section -> value (last known, incl. not-yet-referenced children)
  let current = null;    // full doc as the app currently has it
  const listeners = new Set();
  let timer = null, flushing = null, again = false, retryTimer = null;
  let loaded = false;
  const buffered = [];
  let remoteChain = Promise.resolve();

  const headId = (name) => prefix + name;
  const chunkId = (name, rev, i) => `${prefix}${name}#${rev}#${i}`;
  const status = (s, extra) => { try { onStatus(s, extra); } catch (e) {} };
  const setDirty = (on) => { try { on ? storage && storage.setItem(dirtyKey, '1') : storage && storage.removeItem(dirtyKey); } catch (e) {} };
  const isDirty = () => { try { return !!(storage && storage.getItem(dirtyKey)); } catch (e) { return false; } };

  async function readSection(name) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await api.get(headId(name));
      if (!head) return null;
      let payload;
      if ((head.parts || 1) <= 1) payload = head.data;
      else {
        const items = await Promise.all(Array.from({ length: head.parts }, (_, i) => api.get(chunkId(name, head.rev, i))));
        if (items.some((x) => !x)) continue; // head moved on mid-read; try again
        payload = items.map((x) => x.data).join('');
      }
      if (payload == null) return null;
      return { str: await decode(payload), rev: head.rev || 0, parts: head.parts || 1 };
    }
    throw new Error('Could not read section ' + name + ' (kept changing while reading)');
  }

  async function upsertChunk(input) {
    try { await api.create(input); }
    catch (e) { if (!e.conflict) throw e; await api.update(input); }
  }

  async function writeSection(name, json) {
    const payload = await encode(json);
    const parts = [];
    for (let i = 0; i < payload.length; i += chunkSize) parts.push(payload.slice(i, i + chunkSize));
    if (!parts.length) parts.push('');
    const prev = heads[name];

    const attempt = async (baseRev, exists) => {
      const rev = baseRev + 1;
      if (parts.length > 1) {
        await Promise.all(parts.map((p, i) => upsertChunk({ id: chunkId(name, rev, i), data: p, parts: 0, rev, updatedBy: clientId })));
      }
      const input = {
        id: headId(name), data: parts.length === 1 ? parts[0] : null, parts: parts.length,
        rev, updatedBy: clientId, updatedByUser: userLabel,
      };
      if (exists) await api.update(input, { rev: { eq: baseRev } });
      else await api.create(input);
      return rev;
    };

    let rev;
    try {
      rev = await attempt(prev ? prev.rev : 0, !!prev);
    } catch (e) {
      if (!e.conflict) throw e;
      // Someone else saved this section since we last saw it. Ours is the newer
      // edit, so write on top of theirs (they'll receive it live).
      const firstRev = (prev ? prev.rev : 0) + 1;
      if (parts.length > 1) gc(name, firstRev, parts.length); // chunks from the failed attempt
      const cur = await api.get(headId(name));
      onConflict(name, cur && cur.updatedByUser);
      rev = await attempt(cur ? cur.rev : 0, !!cur);
      if (cur && cur.parts > 1) gc(name, cur.rev, cur.parts); // their chunks, now superseded
    }
    if (prev && prev.parts > 1) gc(name, prev.rev, prev.parts);
    heads[name] = { rev, parts: parts.length };
  }

  function gc(name, rev, n) {
    for (let i = 0; i < n; i++) Promise.resolve(api.del(chunkId(name, rev, i))).catch(() => {});
  }

  function pendingSections() {
    if (!current) return [];
    const secs = splitDoc(current);
    return writeOrder(Object.keys(secs)).filter((n) => JSON.stringify(secs[n]) !== lastJson[n]).map((n) => [n, secs[n]]);
  }

  async function doFlush() {
    status('saving');
    do {
      again = false;
      for (const [name, value] of pendingSections()) {
        const json = JSON.stringify(value);
        await writeSection(name, json);
        lastJson[name] = json;
        cache[name] = value;
      }
    } while (again);
    setDirty(false);
    status('saved');
  }

  function flush() {
    clearTimeout(timer); timer = null;
    if (flushing) { again = true; return flushing; }
    flushing = doFlush()
      .catch((e) => {
        status('error', e);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, 5000);
      })
      .finally(() => { flushing = null; });
    return flushing;
  }

  function save(doc) {
    current = doc;
    setDirty(true);
    status('pending');
    if (!loaded) return;
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  async function load({ localDoc = null } = {}) {
    const items = await api.list();
    const names = items.filter((x) => x.id.startsWith(prefix) && !x.id.includes('#')).map((x) => x.id.slice(prefix.length));
    const secs = {};
    const readInto = async (list) => {
      await Promise.all(list.map(async (n) => {
        const r = await readSection(n);
        if (!r) return;
        heads[n] = { rev: r.rev, parts: r.parts };
        lastJson[n] = r.str;
        secs[n] = JSON.parse(r.str);
      }));
    };
    if (names.includes('root')) {
      await readInto(['root']);
      const wsNames = (secs.root.__ws || []).map((k) => `ws~${k}`).filter((n) => names.includes(n));
      await readInto(wsNames);
      const blobNames = [];
      for (const n of wsNames) for (const f of (secs[n] && secs[n].__blobs) || []) if (names.includes(`${n}~${f}`)) blobNames.push(`${n}~${f}`);
      await readInto(blobNames);
    }
    cache = { ...secs };
    let doc = joinDoc(secs);

    // This browser has edits that never reached the cloud (closed mid-save,
    // offline…): lay them over the cloud copy and push them.
    let recovered = false;
    if (doc && localDoc && isDirty()) {
      const local = splitDoc(localDoc);
      for (const n of Object.keys(local)) {
        if (JSON.stringify(local[n]) !== lastJson[n]) { secs[n] = local[n]; recovered = true; }
      }
      if (recovered) doc = joinDoc(secs);
    }
    if (!doc) setDirty(false);
    current = doc;
    loaded = true;
    for (const evt of buffered.splice(0)) handleEvent(evt);
    if (recovered) flush();
    return { doc, recovered };
  }

  // When the cloud was empty and the caller decides to upload a doc (migration).
  function seed(doc) {
    current = doc;
    setDirty(true);
    return flush();
  }

  function handleEvent(evt) {
    if (!evt || typeof evt.id !== 'string') return;
    if (!evt.id.startsWith(prefix) || evt.id.includes('#')) return;
    if (evt.updatedBy === clientId) return;
    if (!loaded) { buffered.push(evt); return; }
    remoteChain = remoteChain.then(() => applyRemote(evt.id.slice(prefix.length), evt)).catch((e) => status('error', e));
    return remoteChain;
  }

  async function applyRemote(name, evt) {
    if (heads[name] && heads[name].rev >= (evt.rev || 0)) return;
    const mine = current ? splitDoc(current) : {};
    // We have an unsaved edit to this very section: keep ours; the conditional
    // write will notice the conflict and land on top.
    if (name in mine && JSON.stringify(mine[name]) !== lastJson[name]) return;
    const r = await readSection(name);
    if (!r) return;
    heads[name] = { rev: r.rev, parts: r.parts };
    lastJson[name] = r.str;
    const value = JSON.parse(r.str);
    cache = { ...cache, ...mine, [name]: value };
    // fetch any referenced child we've never seen (e.g. a missed event)
    const missing = [];
    const root = cache.root;
    if (root) for (const k of root.__ws || []) {
      const wn = `ws~${k}`;
      if (!cache[wn]) missing.push(wn);
      else for (const f of cache[wn].__blobs || []) if (!cache[`${wn}~${f}`]) missing.push(`${wn}~${f}`);
    }
    for (const m of missing) {
      const mr = await readSection(m);
      if (mr) { heads[m] = { rev: mr.rev, parts: mr.parts }; lastJson[m] = mr.str; cache[m] = JSON.parse(mr.str); }
    }
    const doc = joinDoc(cache);
    if (!doc) return;
    current = doc;
    const copy = JSON.parse(JSON.stringify(doc));
    for (const fn of listeners) { try { fn(copy, name); } catch (e) { console.error(e); } }
  }

  function onRemote(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  const hasPending = () => !!timer || !!flushing || (loaded && pendingSections().length > 0);

  const setUserLabel = (v) => { userLabel = v || ''; };
  return { load, save, seed, flush, handleEvent, onRemote, hasPending, setUserLabel, _debug: { heads, lastJson } };
}
