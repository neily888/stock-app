// Stock app API for Cloudflare Pages Functions, backed by a D1 database bound as DB.
//
//   GET  /api/state       -> { version, state }   (state is null until first save)
//   PUT  /api/state       -> { version }          body: { baseVersion, state, force?, label? }
//   GET  /api/snapshots   -> { snapshots: [{ id, ts, label, items, units }] }
//   POST /api/restore     -> { version, state }   body: { id }
//
// The whole inventory is one JSON document with a version number. A save only
// succeeds if the sender's baseVersion matches, otherwise the current state is
// returned with a 409 so the app can reload it. The first save on each day
// keeps the previous state as an automatic copy; the newest 30 copies are kept.

const MAX_BODY = 1_000_000;
const MAX_ITEMS = 5000;
const KEEP_SNAPSHOTS = 30;
const TZ = 'Europe/London';

let ready = false;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare(
      'CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT, label TEXT NOT NULL, data TEXT NOT NULL)'
    ),
  ]);
  ready = true;
}

function count(v, max = 99999) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

// Rebuild the state from known fields only, so nothing unexpected is stored.
function clean(s) {
  if (!s || !Array.isArray(s.items) || s.items.length > MAX_ITEMS) return null;
  const items = [];
  const seen = new Set();
  for (const r of s.items) {
    if (!r || typeof r.name !== 'string' || typeof r.group !== 'string') return null;
    const id = Math.floor(Number(r.id));
    if (!Number.isFinite(id) || id < 1 || seen.has(id)) return null;
    seen.add(id);
    const name = r.name.trim().slice(0, 200);
    const group = r.group.trim().slice(0, 100);
    if (!name || !group) return null;
    items.push({
      id,
      name,
      group,
      low: count(r.low),
      paused: !!r.paused,
      m: count(r.m),
      b: count(r.b),
    });
  }
  const counted = { m: {}, b: {} };
  for (const l of ['m', 'b']) {
    const src = s.counted && s.counted[l];
    if (src && typeof src === 'object') {
      for (const k of Object.keys(src)) if (seen.has(Number(k)) && src[k]) counted[l][k] = true;
    }
  }
  const maxId = items.reduce((a, i) => Math.max(a, i.id), 0);
  return { items, counted, nextId: Math.max(count(s.nextId), maxId + 1) };
}

function londonDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now); // YYYY-MM-DD
}
function londonLabel(now = new Date()) {
  return 'Start of ' + now.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
}

async function pruneSnapshots(db) {
  await db
    .prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY ts DESC LIMIT ?)')
    .bind(KEEP_SNAPSHOTS)
    .run();
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: 'Too large' };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: 'Invalid JSON' };
  }
}

async function getState(db) {
  const cur = await db.prepare('SELECT version, data FROM app_state WHERE id = 1').first();
  if (!cur) return json({ version: 0, state: null });
  return json({ version: cur.version, state: JSON.parse(cur.data) });
}

async function putState(db, request) {
  const { body, error } = await readBody(request);
  if (error) return json({ error }, 400);
  const state = clean(body && body.state);
  if (!state) return json({ error: 'Invalid state' }, 400);
  const baseVersion = Number(body.baseVersion) || 0;
  const force = body.force === true;
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';

  const cur = await db.prepare('SELECT version, data FROM app_state WHERE id = 1').first();
  const curVersion = cur ? cur.version : 0;
  if (!force && baseVersion !== curVersion) {
    return json({ version: curVersion, state: cur ? JSON.parse(cur.data) : null }, 409);
  }

  const now = Date.now();
  if (cur) {
    if (force && label) {
      await db
        .prepare('INSERT INTO snapshots (id, ts, day, label, data) VALUES (?, ?, NULL, ?, ?)')
        .bind('x-' + now, now, label, cur.data)
        .run();
    } else {
      const day = londonDay();
      const has = await db.prepare('SELECT 1 AS x FROM snapshots WHERE day = ?').bind(day).first();
      if (!has) {
        await db
          .prepare('INSERT INTO snapshots (id, ts, day, label, data) VALUES (?, ?, ?, ?, ?)')
          .bind('d-' + day, now, day, londonLabel(), cur.data)
          .run();
      }
    }
  }

  const data = JSON.stringify(state);
  const next = curVersion + 1;
  if (cur) {
    const res = await db
      .prepare('UPDATE app_state SET version = ?, data = ?, updated_at = ? WHERE id = 1 AND version = ?')
      .bind(next, data, now, curVersion)
      .run();
    if (!res.meta || res.meta.changes !== 1) {
      const again = await db.prepare('SELECT version, data FROM app_state WHERE id = 1').first();
      return json({ version: again.version, state: JSON.parse(again.data) }, 409);
    }
  } else {
    try {
      await db
        .prepare('INSERT INTO app_state (id, version, data, updated_at) VALUES (1, ?, ?, ?)')
        .bind(next, data, now)
        .run();
    } catch {
      const again = await db.prepare('SELECT version, data FROM app_state WHERE id = 1').first();
      if (again) return json({ version: again.version, state: JSON.parse(again.data) }, 409);
      throw new Error('insert failed');
    }
  }
  await pruneSnapshots(db);
  return json({ version: next });
}

async function listSnapshots(db) {
  const { results } = await db.prepare('SELECT id, ts, label, data FROM snapshots ORDER BY ts DESC LIMIT ?').bind(KEEP_SNAPSHOTS).all();
  const snapshots = results.map((r) => {
    let items = 0;
    let units = 0;
    try {
      const s = JSON.parse(r.data);
      items = s.items.length;
      units = s.items.reduce((a, i) => a + i.m + i.b, 0);
    } catch {}
    return { id: r.id, ts: r.ts, label: r.label, items, units };
  });
  return json({ snapshots });
}

async function restore(db, request) {
  const { body, error } = await readBody(request);
  if (error) return json({ error }, 400);
  const id = body && typeof body.id === 'string' ? body.id : '';
  const snap = await db.prepare('SELECT data FROM snapshots WHERE id = ?').bind(id).first();
  if (!snap) return json({ error: 'Copy not found' }, 404);
  const cur = await db.prepare('SELECT version, data FROM app_state WHERE id = 1').first();
  const now = Date.now();
  if (cur) {
    await db
      .prepare('INSERT INTO snapshots (id, ts, day, label, data) VALUES (?, ?, NULL, ?, ?)')
      .bind('r-' + now, now, 'Before restore, ' + new Date(now).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), cur.data)
      .run();
    await db
      .prepare('UPDATE app_state SET version = ?, data = ?, updated_at = ? WHERE id = 1')
      .bind(cur.version + 1, snap.data, now)
      .run();
  } else {
    await db.prepare('INSERT INTO app_state (id, version, data, updated_at) VALUES (1, 1, ?, ?)').bind(snap.data, now).run();
  }
  await pruneSnapshots(db);
  const fresh = await db.prepare('SELECT version, data FROM app_state WHERE id = 1').first();
  return json({ version: fresh.version, state: JSON.parse(fresh.data) });
}

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) {
    return json({ error: 'Database not connected. Bind a D1 database named DB to this project.' }, 500);
  }
  const route = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '');
  const method = request.method;
  try {
    await init(db);
    if (route === 'state' && method === 'GET') return await getState(db);
    if (route === 'state' && method === 'PUT') return await putState(db, request);
    if (route === 'snapshots' && method === 'GET') return await listSnapshots(db);
    if (route === 'restore' && method === 'POST') return await restore(db, request);
    if (['state', 'snapshots', 'restore'].includes(route)) return json({ error: 'Method not allowed' }, 405);
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: 'Server error' }, 500);
  }
}
