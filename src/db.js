import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_event_id TEXT,          -- Ticket Attendant / POS event id
  ta_event_id TEXT,                -- Ticket Attendant internal guid
  sh_event_id TEXT,                -- StubHub event id
  name TEXT,
  venue TEXT,
  venue_id TEXT,
  event_date TEXT,
  event_time TEXT,
  stubhub_url TEXT,
  source TEXT NOT NULL DEFAULT 'link',   -- 'link' (added by StubHub link) | 'sync' (imported from marketplace)
  enabled INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sh ON events(sh_event_id) WHERE sh_event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL,        -- marketplace / POS listing id
  ta_inventory_id TEXT,
  ticket_group_id TEXT,
  sh_listing_id TEXT,
  item_id TEXT,
  section TEXT,
  row TEXT,
  seats TEXT,
  quantity INTEGER,
  cost REAL,
  current_price REAL,
  net_price REAL,
  status TEXT NOT NULL DEFAULT 'active',   -- active | paused | gone
  floor_price REAL,
  ceiling_price REAL,
  undercut_amount REAL,
  last_market_low REAL,
  competitor_count INTEGER,
  is_lowest INTEGER,
  last_reason TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  gone_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_id, listing_id)
);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  old_price REAL,
  new_price REAL,
  market_low REAL,
  reason TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  event_id INTEGER,
  listing_id INTEGER,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_snapshots (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
`;

const EVENT_COLUMNS = [
  'external_event_id', 'ta_event_id', 'sh_event_id', 'name', 'venue', 'venue_id', 'event_date', 'event_time',
  'stubhub_url', 'source', 'enabled', 'last_synced_at', 'last_error',
];
const LISTING_COLUMNS = [
  'event_id', 'listing_id', 'ta_inventory_id', 'ticket_group_id', 'sh_listing_id', 'item_id', 'section', 'row', 'seats',
  'quantity', 'cost', 'current_price', 'net_price', 'status', 'floor_price', 'ceiling_price', 'undercut_amount',
  'last_market_low', 'competitor_count', 'is_lowest', 'last_reason', 'last_checked_at', 'last_error', 'gone_since',
];

const now = () => new Date().toISOString();

function pick(obj, cols) {
  const out = {};
  for (const c of cols) if (obj[c] !== undefined) out[c] = obj[c] === undefined ? null : obj[c];
  return out;
}

function toRow(o) {
  if (!o) return o;
  return { ...o };
}

export function openDb(file, defaultSettings = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const api = {
    raw: db,
    close() {
      db.close();
    },

    // ---------- settings ----------
    getSettings() {
      const rows = db.prepare('SELECT key, value FROM settings').all();
      const out = { ...defaultSettings };
      for (const r of rows) {
        if (!(r.key in defaultSettings)) continue; // internal keys are read with getInternal()
        try {
          out[r.key] = JSON.parse(r.value);
        } catch {
          out[r.key] = r.value;
        }
      }
      return out;
    },
    setSettings(patch) {
      const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of Object.entries(patch || {})) {
        if (!(k in defaultSettings)) continue;
        stmt.run(k, JSON.stringify(v));
      }
      return api.getSettings();
    },
    /** Internal key/value storage (session cookies etc.). Never returned by getSettings(). */
    getInternal(key) {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(`__${key}`);
      if (!r) return null;
      try {
        return JSON.parse(r.value);
      } catch {
        return r.value;
      }
    },
    setInternal(key, value) {
      db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`__${key}`, JSON.stringify(value));
    },

    // ---------- events ----------
    listEvents({ enabledOnly = false } = {}) {
      const sql = enabledOnly
        ? 'SELECT * FROM events WHERE enabled = 1 ORDER BY event_date, id'
        : 'SELECT * FROM events ORDER BY enabled DESC, event_date, id';
      return db.prepare(sql).all().map(toRow);
    },
    getEvent(id) {
      return toRow(db.prepare('SELECT * FROM events WHERE id = ?').get(id));
    },
    getEventBySHId(shEventId) {
      if (!shEventId) return undefined;
      return toRow(db.prepare('SELECT * FROM events WHERE sh_event_id = ?').get(String(shEventId)));
    },
    getEventByExternalId(externalId) {
      if (!externalId) return undefined;
      return toRow(db.prepare('SELECT * FROM events WHERE external_event_id = ?').get(String(externalId)));
    },
    insertEvent(data) {
      const row = { source: 'link', enabled: 1, ...pick(data, EVENT_COLUMNS) };
      const cols = Object.keys(row);
      const ts = now();
      const res = db
        .prepare(`INSERT INTO events (${cols.join(',')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`)
        .run(...cols.map((c) => row[c]), ts, ts);
      return api.getEvent(Number(res.lastInsertRowid));
    },
    updateEvent(id, patch) {
      const row = pick(patch, EVENT_COLUMNS);
      const cols = Object.keys(row);
      if (!cols.length) return api.getEvent(id);
      db.prepare(`UPDATE events SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...cols.map((c) => row[c]),
        now(),
        id,
      );
      return api.getEvent(id);
    },
    deleteEvent(id) {
      db.prepare('DELETE FROM events WHERE id = ?').run(id);
    },

    // ---------- listings ----------
    listListings(eventId, { includeGone = false } = {}) {
      const where = ['event_id = ?'];
      if (!includeGone) where.push("status != 'gone'");
      return db
        .prepare(`SELECT * FROM listings WHERE ${where.join(' AND ')} ORDER BY section, row, id`)
        .all(eventId)
        .map(toRow);
    },
    listAllListings({ includeGone = false } = {}) {
      const sql = includeGone ? 'SELECT * FROM listings ORDER BY event_id, section, row, id' : "SELECT * FROM listings WHERE status != 'gone' ORDER BY event_id, section, row, id";
      return db.prepare(sql).all().map(toRow);
    },
    getListing(id) {
      return toRow(db.prepare('SELECT * FROM listings WHERE id = ?').get(id));
    },
    getListingByExternal(eventId, listingId) {
      return toRow(db.prepare('SELECT * FROM listings WHERE event_id = ? AND listing_id = ?').get(eventId, String(listingId)));
    },
    insertListing(data) {
      const row = { status: 'active', ...pick(data, LISTING_COLUMNS) };
      row.listing_id = String(row.listing_id);
      const cols = Object.keys(row);
      const ts = now();
      const res = db
        .prepare(`INSERT INTO listings (${cols.join(',')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`)
        .run(...cols.map((c) => row[c]), ts, ts);
      return api.getListing(Number(res.lastInsertRowid));
    },
    updateListing(id, patch) {
      const row = pick(patch, LISTING_COLUMNS);
      const cols = Object.keys(row);
      if (!cols.length) return api.getListing(id);
      db.prepare(`UPDATE listings SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...cols.map((c) => row[c]),
        now(),
        id,
      );
      return api.getListing(id);
    },
    deleteListing(id) {
      db.prepare('DELETE FROM listings WHERE id = ?').run(id);
    },

    // ---------- history / log ----------
    addHistory({ listingId, oldPrice, newPrice, marketLow, reason, dryRun }) {
      db.prepare(
        'INSERT INTO price_history (listing_id, old_price, new_price, market_low, reason, dry_run, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(listingId, oldPrice ?? null, newPrice ?? null, marketLow ?? null, reason ?? null, dryRun ? 1 : 0, now());
    },
    listHistory(listingId, limit = 100) {
      return db
        .prepare('SELECT * FROM price_history WHERE listing_id = ? ORDER BY id DESC LIMIT ?')
        .all(listingId, limit)
        .map(toRow);
    },
    log(level, message, { eventId = null, listingId = null } = {}) {
      db.prepare('INSERT INTO activity_log (level, event_id, listing_id, message, created_at) VALUES (?,?,?,?,?)').run(
        level,
        eventId,
        listingId,
        String(message),
        now(),
      );
      // keep the table bounded
      db.prepare('DELETE FROM activity_log WHERE id < (SELECT MAX(id) FROM activity_log) - 5000').run();
    },
    recentLog(limit = 200) {
      return db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?').all(limit).map(toRow);
    },

    // ---------- market snapshots ----------
    saveSnapshot(eventId, payload) {
      db.prepare(
        'INSERT INTO market_snapshots (event_id, fetched_at, payload) VALUES (?,?,?) ON CONFLICT(event_id) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload',
      ).run(eventId, now(), JSON.stringify(payload));
    },
    getSnapshot(eventId) {
      const r = db.prepare('SELECT * FROM market_snapshots WHERE event_id = ?').get(eventId);
      if (!r) return null;
      return { fetchedAt: r.fetched_at, listings: JSON.parse(r.payload) };
    },
  };

  return api;
}
