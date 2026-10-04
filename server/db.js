'use strict';
// SQLite 資料層：建表＋以 PRAGMA user_version 做版本遷移（重啟不重建、不掉資料）
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const MIGRATIONS = [
  // v1：spec 第 5 節 14 張表（另加幾個必要欄位，見 README／回報）
  `
  CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT, brand_id TEXT NOT NULL REFERENCES brands(id), code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, pnl_unit_code TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT);
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('accountant','admin')),
    brand_id TEXT REFERENCES brands(id), name TEXT NOT NULL, pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    fail_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, who TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, brand_id TEXT NOT NULL REFERENCES brands(id), name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, brand_id TEXT NOT NULL REFERENCES brands(id), name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '食材', base_unit TEXT NOT NULL DEFAULT '');
  CREATE TABLE item_aliases (
    vendor_id INTEGER NOT NULL, raw_name TEXT NOT NULL, item_id INTEGER NOT NULL, PRIMARY KEY (vendor_id, raw_name));
  CREATE TABLE unit_conv (item_id INTEGER NOT NULL, unit TEXT NOT NULL, factor_to_base REAL NOT NULL, PRIMARY KEY (item_id, unit));
  CREATE TABLE slips (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, store_id INTEGER NOT NULL REFERENCES stores(id),
    brand_id TEXT NOT NULL, vendor_id INTEGER REFERENCES vendors(id), vendor_name_raw TEXT,
    status TEXT NOT NULL CHECK (status IN ('uploaded','queued','recognizing','review','confirmed','failed','returned')),
    doc_date TEXT, doc_no TEXT, subtotal REAL, tax REAL, total REAL, total_handwritten INTEGER NOT NULL DEFAULT 0,
    handwritten_note TEXT, flags TEXT NOT NULL DEFAULT '[]', uploaded_at TEXT NOT NULL, confirmed_at TEXT, confirmed_by TEXT,
    ai_raw TEXT, ai_model TEXT, ai_seconds REAL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, return_reason TEXT);
  CREATE INDEX idx_slips_brand_status ON slips(brand_id, status);
  CREATE INDEX idx_slips_store ON slips(store_id, uploaded_at);
  CREATE INDEX idx_slips_status ON slips(status, uploaded_at);
  CREATE TABLE slip_photos (slip_id TEXT NOT NULL REFERENCES slips(id), seq INTEGER NOT NULL, path TEXT NOT NULL, sha256 TEXT, PRIMARY KEY (slip_id, seq));
  CREATE TABLE slip_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slip_id TEXT NOT NULL REFERENCES slips(id), seq INTEGER NOT NULL, raw_name TEXT NOT NULL DEFAULT '',
    item_id INTEGER, qty REAL, unit TEXT, unit_price REAL, amount REAL, flags TEXT NOT NULL DEFAULT '[]',
    checked INTEGER NOT NULL DEFAULT 0, edited_by_human INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX idx_lines_slip ON slip_lines(slip_id, seq);
  CREATE TABLE price_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, line_id INTEGER, item_id INTEGER, vendor_id INTEGER, store_id INTEGER,
    prev_price REAL, new_price REAL, pct REAL, direction TEXT CHECK (direction IN ('up','down')), created_at TEXT, notified_at TEXT);
  CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, slip_id TEXT, before TEXT, after TEXT);
  CREATE TABLE jobs_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, job TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT);
  `,
  `ALTER TABLE slips ADD COLUMN date_note TEXT;`,
  // v3（P2）：品名表可停用、報表與提醒用的索引
  `ALTER TABLE items ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
   CREATE INDEX idx_lines_item ON slip_lines(item_id);
   CREATE INDEX idx_alerts_line ON price_alerts(line_id);`,
  // v4（P3）：損益科目對照、損益推送 outbox（同店同月合併一筆；ver 用來判斷「送出期間又被改過」）、曾推過的科目（歸 0 要送）
  `CREATE TABLE pnl_map (
     brand_id TEXT NOT NULL REFERENCES brands(id), vendor_id INTEGER NOT NULL REFERENCES vendors(id), category TEXT NOT NULL, acc_id TEXT NOT NULL,
     PRIMARY KEY (vendor_id, category));
   CREATE TABLE pnl_outbox (
     store_id INTEGER NOT NULL, month TEXT NOT NULL, dirty_at TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 1,
     attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT, first_fail_at TEXT, last_error TEXT, PRIMARY KEY (store_id, month));
   CREATE TABLE pnl_pushed (store_id INTEGER NOT NULL, month TEXT NOT NULL, acc_id TEXT NOT NULL, PRIMARY KEY (store_id, month, acc_id));`,
  // v5（P3 審查 #2）：門市換／清空損益代號時，舊代號在損益端的機器列要先推 0 撤回——每個（店、月、舊代號）一筆待撤回工作，帶著當時推過的科目清單；成功才刪
  `CREATE TABLE pnl_retire (
     store_id INTEGER NOT NULL, month TEXT NOT NULL, unit_code TEXT NOT NULL, accs TEXT NOT NULL, created_at TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT, first_fail_at TEXT, last_error TEXT, PRIMARY KEY (store_id, month, unit_code));`,
  // v6（P3 定案規則 #2 #3，Eason 2026-10-03）：
  //  - outbox／retire 加終態：state＝'locked'（該月已定稿）或 'rejected'（BAD_INPUT）→ 不再自動重試，/health 黃燈帶 reason；新的入帳／取消入帳／手動重推會清掉終態重新排入
  //  - pnl_pushed 記下每個科目最後一次成功推送的金額（分），定稿遲到時算「有新進貨 N 元未入損益」
  //  - pnl_inactive：損益端回報「科目已停用」的 店×月×科目；這些金額歸入待補對照（原因「科目已停用」）
  `ALTER TABLE pnl_outbox ADD COLUMN state TEXT;
   ALTER TABLE pnl_outbox ADD COLUMN reason TEXT;
   ALTER TABLE pnl_retire ADD COLUMN state TEXT;
   ALTER TABLE pnl_retire ADD COLUMN reason TEXT;
   ALTER TABLE pnl_pushed ADD COLUMN cents INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE pnl_inactive (store_id INTEGER NOT NULL, month TEXT NOT NULL, acc_id TEXT NOT NULL, PRIMARY KEY (store_id, month, acc_id));`,
  // v7（P4 契約補充）：會計可管多個品牌。user_brands＝會計有權的品牌；users.brand_id 保留為預設品牌；sessions.brand_id＝這次登入「目前品牌」
  `CREATE TABLE user_brands (user_id INTEGER NOT NULL REFERENCES users(id), brand_id TEXT NOT NULL REFERENCES brands(id), PRIMARY KEY (user_id, brand_id));
   ALTER TABLE sessions ADD COLUMN brand_id TEXT;
   INSERT INTO user_brands (user_id, brand_id) SELECT id, brand_id FROM users WHERE role = 'accountant' AND brand_id IS NOT NULL;`,
  // v8（首次登入強制改密碼，Eason 2026-10-04）：帳號由管理者開、密碼由使用者自己設。既有門市與會計＝1、admin＝0
  `ALTER TABLE stores ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
   UPDATE stores SET must_change_password = 1;
   UPDATE users SET must_change_password = CASE WHEN role = 'admin' THEN 0 ELSE 1 END;`,
  // v9（品項金額已含稅，Eason 2026-10-04）：slips.tax_included＝這張單各列金額是否已含稅；vendors.tax_included＝廠商記憶（新單預設值）。既有資料一律 0＝原規則
  `ALTER TABLE slips ADD COLUMN tax_included INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE vendors ADD COLUMN tax_included INTEGER NOT NULL DEFAULT 0;`
];

function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'purchase.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  let ver = db.prepare('PRAGMA user_version').get().user_version;
  while (ver < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[ver]);
      db.exec(`PRAGMA user_version = ${ver + 1}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    ver++;
  }
  let depth = 0;
  db.tx = (fn) => {                                   // 交易（可巢狀：內層直接沿用外層）
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE'); depth++;
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ } throw e; }
    finally { depth--; }
  };
  return db;
}

const nowIso = () => new Date().toISOString();
function audit(db, who, action, slipId, before, after) {
  db.prepare('INSERT INTO audit (at, who, action, slip_id, before, after) VALUES (?,?,?,?,?,?)')
    .run(nowIso(), who, action, slipId || null, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after));
}
function jobLog(db, job, ok, detail) {
  db.prepare('INSERT INTO jobs_log (at, job, ok, detail) VALUES (?,?,?,?)').run(nowIso(), job, ok ? 1 : 0, String(detail || '').slice(0, 2000));
}
module.exports = { openDb, audit, jobLog, nowIso, SCHEMA_VERSION: MIGRATIONS.length };
