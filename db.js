'use strict';
// SQLite storage for the social layer, in DATA_DIR/pulse.db (Node's built-in node:sqlite, so
// nothing to install). Members and the owner's settings stay in memory for fast boards and are
// written back one row at a time when they change; the feed, kudos, posts, comments, reports and
// uploaded images live only in the database and are read with indexed queries.
//
// On the first start after an upgrade, an existing DATA_DIR/social.json is imported in one
// transaction and renamed to social.json.migrated (kept as a backup, never read again).
const fs = require('fs');
const path = require('path');

let DatabaseSync = null;
function sqlite() {
  if (DatabaseSync) return DatabaseSync;
  // node:sqlite is unflagged from Node 22.13; its "experimental" warning is noise in the logs
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...a) { if (/SQLite/i.test(String(w && w.message || w))) return; return emit.call(process, w, ...a); };
  try { DatabaseSync = require('node:sqlite').DatabaseSync; } finally { process.emitWarning = emit; }
  return DatabaseSync;
}

// Each entry moves the schema one version forward; PRAGMA user_version records how far it got.
const MIGRATIONS = [
  `CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
   CREATE TABLE members (id TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;
   -- the feed: milestones the server writes, the owner's announcements and members' own posts
   CREATE TABLE events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, member TEXT, type TEXT NOT NULL,
     text TEXT NOT NULL DEFAULT '', quote TEXT NOT NULL DEFAULT '', data TEXT, kudos INTEGER NOT NULL DEFAULT 0,
     comments INTEGER NOT NULL DEFAULT 0, edited INTEGER, hidden INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX events_at ON events (at, id);
   CREATE INDEX events_member ON events (member, at);
   CREATE TABLE kudos (event TEXT NOT NULL, member TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (event, member)) WITHOUT ROWID;
   CREATE INDEX kudos_member ON kudos (member);
   CREATE TABLE comments (id TEXT PRIMARY KEY, event TEXT NOT NULL, member TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
   CREATE INDEX comments_event ON comments (event, at);
   CREATE INDEX comments_member ON comments (member, at);
   CREATE TABLE reports (id TEXT PRIMARY KEY, event TEXT, comment TEXT, member TEXT NOT NULL, at INTEGER NOT NULL, why TEXT NOT NULL DEFAULT '',
     open INTEGER NOT NULL DEFAULT 1);
   -- one open report per member per post or comment; after the owner deals with it, a new one can come in
   CREATE UNIQUE INDEX reports_once ON reports (member, ifnull(event, ''), ifnull(comment, '')) WHERE open = 1;
   CREATE INDEX reports_open ON reports (open, at);
   -- uploaded images; the bytes are files in DATA_DIR/media named by id
   CREATE TABLE media (id TEXT PRIMARY KEY, member TEXT NOT NULL, at INTEGER NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
     kind TEXT NOT NULL, ref TEXT);
   CREATE INDEX media_member ON media (member, at);
   CREATE INDEX media_ref ON media (ref, at);`,
];

function open(dataDir) {
  const D = sqlite();
  const file = path.join(dataDir, 'pulse.db');
  const db = new D(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;');
  let ver = db.prepare('PRAGMA user_version').get().user_version;
  for (; ver < MIGRATIONS.length; ver++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[ver]); db.exec('PRAGMA user_version = ' + (ver + 1)); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // prepared once, reused: the same few statements run on every request
  const stmts = new Map();
  const q = sql => { let st = stmts.get(sql); if (!st) { st = db.prepare(sql); stmts.set(sql, st); } return st; };
  let depth = 0, after = []; // a transaction inside another one joins it
  // afterCommit: work outside the database (deleting files) that must only happen once the rows are gone
  const afterCommit = fn => { if (depth) after.push(fn); else fn(); };
  const tx = fn => { if (depth) return fn(); db.exec('BEGIN'); depth++;
    try { const r = fn(); depth--; db.exec('COMMIT'); const a = after; after = []; for (const f of a) try { f(); } catch (e) {} return r; }
    catch (e) { depth = 0; after = []; try { db.exec('ROLLBACK'); } catch (e2) {} throw e; } };
  return { db, file, q, tx, afterCommit, close: () => { try { db.close(); } catch (e) {} } };
}

// The v0.1–v0.5 file: everything in one JSON object. Events (with their kudos lists) move to
// their own tables; every other section becomes a kv row; members become one row each.
function importJson(store, S) {
  const { q, tx } = store;
  const putKv = q('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)');
  const putM = q('INSERT OR REPLACE INTO members (id, data) VALUES (?, ?)');
  const putE = q('INSERT OR IGNORE INTO events (id, at, member, type, text, quote, kudos) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const putK = q('INSERT OR IGNORE INTO kudos (event, member, at) VALUES (?, ?, ?)');
  tx(() => {
    for (const [k, v] of Object.entries(S)) if (k !== 'members' && k !== 'events' && k !== 'v') putKv.run(k, JSON.stringify(v));
    for (const m of Object.values(S.members || {})) if (m && m.id) putM.run(String(m.id), JSON.stringify(m));
    for (const e of Array.isArray(S.events) ? S.events : []) {
      if (!e || !e.id) continue;
      const kudos = Array.isArray(e.kudos) ? e.kudos : [];
      putE.run(String(e.id), +e.at || 0, e.member || null, String(e.type || 'note'), String(e.text || ''), String(e.quote || ''), kudos.length);
      for (const id of kudos) putK.run(String(e.id), String(id), +e.at || 0);
    }
  });
}

module.exports = { open, importJson, MIGRATIONS };
