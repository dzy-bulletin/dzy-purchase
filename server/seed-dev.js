#!/usr/bin/env node
'use strict';
// 開發用種子資料：3 品牌、門市 C01／M01／X01、三位會計、一位 admin（管理三品牌）、虛構廠商與品項（含單位換算）。
// 密碼從環境變數讀（SEED_PASS_C01、SEED_PASS_M01、SEED_PASS_X01、SEED_PASS_ACC_C、SEED_PASS_ACC_M、SEED_PASS_ACC_X、SEED_PASS_ADMIN）；
// 沒給就隨機產生並印在終端機（只印新建帳號的；不寫進任何檔案）。可重複執行（已存在的帳號不動，除非有給對應環境變數才重設密碼）。
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { hashPassword } = require('./auth');

// 每品牌 5 個虛構品項：[名稱, 類別, 統一單位, 換算{單位: 係數}]（全是編造的，與任何真實貨單無關）
const ITEMS = [
  ['測試高麗菜', '食材', '公斤', { 箱: 10, 台斤: 0.6 }],
  ['範例雞胸肉', '食材', '公斤', { 箱: 12 }],
  ['示範米粉', '食材', '包', { 箱: 20 }],
  ['模擬紙碗', '包材', '個', { 箱: 500 }],
  ['虛構洗潔精', '雜貨', '瓶', { 箱: 12 }]
];
const VENDORS = ['測試肉品行', '範例蔬果行', '示範乾貨行', '模擬食品商行', '虛構調味行', '樣品雜貨行'];

function seed(db, env) {
  env = env || process.env;
  const printed = [];
  const pass = (key, label) => {
    if (env[key]) return { pw: env[key], given: true };
    const pw = crypto.randomBytes(9).toString('base64url');
    return { pw, given: false, label };
  };
  db.tx(() => {
    for (const [id, name] of [['X', '小辛辣'], ['M', '墨竹亭'], ['C', '央廚']]) {
      db.prepare('INSERT OR IGNORE INTO brands (id, name) VALUES (?,?)').run(id, name);
    }
    const store = (code, brand, name, key) => {
      const ex = db.prepare('SELECT id FROM stores WHERE code = ?').get(code);
      const p = pass(key);
      if (!ex) { db.prepare('INSERT INTO stores (brand_id, code, name, pass_hash) VALUES (?,?,?,?)').run(brand, code, name, hashPassword(p.pw)); if (!p.given) printed.push(`${code}\t${p.pw}`); }
      else if (p.given) db.prepare('UPDATE stores SET pass_hash = ?, fail_count = 0, locked_until = NULL WHERE code = ?').run(hashPassword(p.pw), code);
    };
    store('C01', 'C', '央廚（測試）', 'SEED_PASS_C01');
    store('M01', 'M', '墨竹亭光復（測試）', 'SEED_PASS_M01');
    store('X01', 'X', '小辛辣光復（測試）', 'SEED_PASS_X01');
    const user = (username, role, brand, name, key) => {
      const ex = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      const p = pass(key);
      if (!ex) { db.prepare('INSERT INTO users (username, role, brand_id, name, pass_hash) VALUES (?,?,?,?,?)').run(username, role, brand, name, hashPassword(p.pw)); if (!p.given) printed.push(`${username}\t${p.pw}`); }
      else if (p.given) db.prepare('UPDATE users SET pass_hash = ?, fail_count = 0, locked_until = NULL WHERE username = ?').run(hashPassword(p.pw), username);
    };
    user('acc-c', 'accountant', 'C', '央廚會計（測試）', 'SEED_PASS_ACC_C');
    user('acc-m', 'accountant', 'M', '墨竹亭會計（測試）', 'SEED_PASS_ACC_M');
    user('acc-x', 'accountant', 'X', '小辛辣會計（測試）', 'SEED_PASS_ACC_X');
    user('admin', 'admin', null, '管理者（測試）', 'SEED_PASS_ADMIN');
    for (const b of ['C', 'M', 'X']) for (const n of VENDORS) {
      if (!db.prepare('SELECT 1 FROM vendors WHERE brand_id = ? AND name = ?').get(b, n)) db.prepare('INSERT INTO vendors (brand_id, name) VALUES (?,?)').run(b, n);
    }
    for (const b of ['C', 'M', 'X']) for (const [name, cat, unit, conv] of ITEMS) {
      let it = db.prepare('SELECT id FROM items WHERE brand_id = ? AND name = ?').get(b, name);
      if (!it) it = { id: Number(db.prepare('INSERT INTO items (brand_id, name, category, base_unit) VALUES (?,?,?,?)').run(b, name, cat, unit).lastInsertRowid) };
      for (const [u, f] of Object.entries(conv)) db.prepare('INSERT OR IGNORE INTO unit_conv (item_id, unit, factor_to_base) VALUES (?,?,?)').run(it.id, u, f);
    }
  });
  return printed;
}

if (require.main === module) {
  const cfg = loadConfig();
  const db = openDb(cfg.DATA_DIR);
  const printed = seed(db);
  console.log(`seed 完成：${cfg.DATA_DIR}`);
  if (printed.length) console.log('新建帳號的隨機密碼（只顯示這一次，沒有存檔）：\n' + printed.join('\n'));
  db.close();
}
module.exports = { seed, VENDORS, ITEMS };
