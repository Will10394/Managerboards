// In-memory stand-in for the AppSync/DynamoDB API, with the same conditional-write
// semantics (create fails if the id exists; update with condition fails on rev mismatch)
// and a shared subscription bus so several "browsers" can talk to one "table".
export function createFakeBackend() {
  const table = new Map();
  const subs = new Set();
  const stats = { creates: 0, updates: 0, deletes: 0, gets: 0 };
  const conflict = () => Object.assign(new Error('ConditionalCheckFailedException'), { conflict: true });
  const publish = (item) => {
    const evt = { id: item.id, rev: item.rev, parts: item.parts, updatedBy: item.updatedBy };
    for (const cb of subs) setTimeout(() => cb(evt), 0);
  };
  const api = {
    async list() { return [...table.values()].map(({ id, rev, parts }) => ({ id, rev, parts })); },
    async get(id) { stats.gets++; const v = table.get(id); return v ? { ...v } : null; },
    async create(input) { stats.creates++; if (table.has(input.id)) throw conflict(); table.set(input.id, { ...input }); publish(input); return { ...input }; },
    async update(input, condition) {
      stats.updates++;
      const cur = table.get(input.id);
      if (!cur) throw conflict();
      if (condition && condition.rev && cur.rev !== condition.rev.eq) throw conflict();
      const next = { ...cur, ...input }; table.set(input.id, next); publish(next); return next;
    },
    async del(id) { stats.deletes++; table.delete(id); },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
  return { api, table, stats };
}
export function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
