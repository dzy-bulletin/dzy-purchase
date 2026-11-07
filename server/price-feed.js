'use strict';
// 入帳事件（給門市營運系統更新庫存商品價格；契約 mala-store-ops docs/price-sync/plan.md C1–C3）
// 入帳／取消入帳在同一交易寫一筆 price_feed；營運系統用 GET /svc/price-feed?after=<id> 依 id 往下讀，不會漏、不會重複。
const crypto = require('crypto');
const calc = require('./calc');

const LIMIT_MAX = 200;

const { ApiError } = require('./http-util');
const taxStatusOf = calc.taxStatusOf;

// 一張單的事件內容（不含 id）。kind=unconfirm 時明細與照片為空
function buildPayload(db, slipId, kind, conv) {
  const s = db.prepare(`SELECT s.id, s.store_id, s.doc_date, s.tax, s.total, s.tax_included, s.vendor_name_raw, v.name vendor
    FROM slips s LEFT JOIN vendors v ON v.id = s.vendor_id WHERE s.id = ?`).get(slipId);
  if (!s) return null;
  const out = { kind, slip_id: s.id, doc_date: s.doc_date || null, vendor_name: s.vendor || s.vendor_name_raw || null, tax_status: taxStatusOf(s), photos: [], lines: [] };
  if (kind !== 'confirm') return out;
  out.photos = db.prepare('SELECT seq FROM slip_photos WHERE slip_id = ? ORDER BY seq').all(slipId).map((r) => r.seq);
  const cv = conv || calc.convMap(db);
  const rows = db.prepare(`SELECT l.seq, l.item_id, l.raw_name, l.unit, l.qty, l.amount, i.name item_name, i.base_unit
    FROM slip_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.slip_id = ? ORDER BY l.seq`).all(slipId);
  out.lines = rows.map((r) => ({
    seq: r.seq, item_id: r.item_id == null ? null : r.item_id, item_name: r.item_name || null, raw_name: r.raw_name || '',
    unit: r.unit || null, qty: r.qty == null ? null : r.qty, amount: r.amount == null ? null : r.amount,
    net_amount: r.amount == null ? null : r.amount * calc.netRatio(s),   // 不捨入，跟 calc.withBase 同一個數；捨入留給最後算價格的一方
    base_unit: r.base_unit || null,
    factor: r.item_id == null ? null : calc.factorOf(cv, r.item_id, r.unit, r.base_unit),
  }));
  return out;
}

// 寫一筆事件（呼叫端負責交易）。at 由呼叫端給，回填時用 confirmed_at
function record(db, slipId, kind, at, conv) {
  const p = buildPayload(db, slipId, kind, conv);
  if (!p) return null;
  const st = db.prepare('SELECT store_id FROM slips WHERE id = ?').get(slipId);
  try {
    return Number(db.prepare('INSERT INTO price_feed (store_id, slip_id, kind, at, payload) VALUES (?,?,?,?,?)')
      .run(st.store_id, slipId, kind, at, JSON.stringify(p)).lastInsertRowid);
  } catch (e) {
    if (/UNIQUE/.test(String(e && e.message))) throw new ApiError('CONFLICT', '這張貨單剛剛才改過狀態，請稍等一秒再試');   // 同一毫秒內同一張單重複入帳／取消
    throw e;
  }
}

// 遷移 v13 用：建表、產 epoch、依入帳先後回填既有已入帳單（在 openDb 的遷移交易內，開始收 HTTP 之前跑完）
function migrate(db) {
  db.exec(`CREATE TABLE price_feed (id INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER NOT NULL, slip_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('confirm','unconfirm')), at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE (slip_id, kind, at));
    CREATE INDEX idx_price_feed_store ON price_feed(store_id, id);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare("INSERT INTO settings (key, value) VALUES ('feed_epoch', ?)").run(crypto.randomUUID());
  const conv = calc.convMap(db);
  for (const r of db.prepare("SELECT id, confirmed_at FROM slips WHERE status = 'confirmed' ORDER BY confirmed_at, id").all()) {
    record(db, r.id, 'confirm', r.confirmed_at || new Date(0).toISOString(), conv);
  }
}

function epochOf(db) { const r = db.prepare("SELECT value FROM settings WHERE key = 'feed_epoch'").get(); return r ? r.value : null; }

// 資料庫從備份還原後要重產（還原手冊的一步）；營運系統看到 epoch 變了會停同步、等人重建
function resetEpoch(db) { db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('feed_epoch', ?)").run(crypto.randomUUID()); return epochOf(db); }

// 讀一頁：依 id 由小到大；last_id＝本頁最後一筆，空頁＝after
function page(db, storeId, after, limit) {
  const a = Number.isInteger(after) && after >= 0 ? after : 0;
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, LIMIT_MAX) : LIMIT_MAX;
  const rows = db.prepare('SELECT id, kind, slip_id, at, payload FROM price_feed WHERE store_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(storeId, a, n + 1);
  const more = rows.length > n;
  const list = rows.slice(0, n).map((r) => { const p = JSON.parse(r.payload); return Object.assign({ id: r.id, kind: r.kind, slip_id: r.slip_id, at: r.at }, { doc_date: p.doc_date, vendor_name: p.vendor_name, tax_status: p.tax_status, photos: p.photos, lines: p.lines }); });
  return { epoch: epochOf(db), last_id: list.length ? list[list.length - 1].id : a, has_more: more, events: list };
}

module.exports = { taxStatusOf, buildPayload, record, migrate, epochOf, resetEpoch, page, LIMIT_MAX };
