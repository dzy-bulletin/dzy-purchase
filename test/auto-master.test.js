'use strict';
// 廠商與品項自動建立（Eason 2026-10-04）：入帳時補建主檔、category NULL＝未分類不推損益、base_unit NULL＝未換算、遷移安全。資料全部虛構。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { startApp, PASS, uuid } = require('./helpers');
const { openDb, MIGRATIONS } = require('../server/db');
const { computeMonth, unmappedReport } = require('../server/pnl-push');
const calc = require('../server/calc');

const storeId = (db, code) => db.prepare('SELECT id FROM stores WHERE code = ?').get(code).id;
let seq = 0;
// 待核對貨單（status=review、各列已打勾），可直接 POST /confirm
function mkReview(db, { brand = 'C', store = 'C01', vendor = null, vendorRaw = null, date = '2026-10-05', lines }) {
  const id = `R${date.replace(/-/g, '')}-${String(++seq).padStart(4, '0')}`;
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  db.prepare("INSERT INTO slips (id, client_id, store_id, brand_id, vendor_id, vendor_name_raw, status, doc_date, tax, total, uploaded_at) VALUES (?,?,?,?,?,?,'review',?,0,?,?)")
    .run(id, uuid(), storeId(db, store), brand, vendor, vendorRaw, date, sum, '2026-10-01T00:00:00Z');
  lines.forEach((l, i) => db.prepare('INSERT INTO slip_lines (slip_id, seq, raw_name, item_id, qty, unit, unit_price, amount, checked) VALUES (?,?,?,?,?,?,?,?,1)')
    .run(id, i + 1, l.raw, l.item || null, l.qty == null ? 1 : l.qty, l.unit === undefined ? '包' : l.unit, l.price == null ? l.amount : l.price, l.amount));
  return id;
}
const L = (raw, amount, extra) => Object.assign({ raw, amount, qty: 1, unit: '包', price: amount }, extra || {});
const vendorsOf = (db, brand) => db.prepare('SELECT * FROM vendors WHERE brand_id = ? AND auto_created = 1').all(brand);
const itemsOf = (db, brand) => db.prepare('SELECT * FROM items WHERE brand_id = ? AND auto_created = 1 ORDER BY id').all(brand);
const audits = (db, a) => db.prepare('SELECT * FROM audit WHERE action = ?').all(a);

test('入帳自動建廠商：同名不重複、全半形空白與大小寫視同、跨品牌不共用、寫 audit', async () => {
  const t = await startApp();
  try {
    const db = t.app.db;
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C), accM = await t.login('acc-m', PASS.SEED_PASS_ACC_M);
    const a = mkReview(db, { vendorRaw: '新來源 食品行', lines: [L('甲貨', 10)] });
    const b = mkReview(db, { vendorRaw: '新來源　食品行', lines: [L('乙貨', 20)] });   // 全形空白
    const c = mkReview(db, { vendorRaw: ' 新來源食品行 ', lines: [L('丙貨', 30)] });          // 前後空白、無空白
    const d = mkReview(db, { vendorRaw: 'ABC Foods', lines: [L('丁貨', 5)] });
    const e = mkReview(db, { vendorRaw: 'abc foods', lines: [L('戊貨', 5)] });
    for (const id of [a, b, c, d, e]) assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).ok, true, id);
    const vs = vendorsOf(db, 'C');
    assert.deepStrictEqual(vs.map((v) => v.name).sort(), ['ABC Foods', '新來源 食品行'].sort());
    assert.strictEqual(new Set([a, b, c].map((id) => db.prepare('SELECT vendor_id v FROM slips WHERE id = ?').get(id).v)).size, 1);
    assert.strictEqual(audits(db, 'auto_vendor').length, 2);
    // 跨品牌：M 品牌同名廠商另建，不共用
    const m = mkReview(db, { brand: 'M', store: 'M01', vendorRaw: '新來源 食品行', lines: [L('甲貨', 10)] });
    assert.strictEqual((await t.call('POST', `/slips/${m}/confirm`, { token: accM })).ok, true);
    const vm = vendorsOf(db, 'M');
    assert.strictEqual(vm.length, 1);
    assert.notStrictEqual(vm[0].id, vs.find((v) => v.name === '新來源 食品行').id);
    // 已有同名手動建立的廠商 → 沿用，不新增
    const seeded = db.prepare("SELECT id FROM vendors WHERE brand_id='C' AND name='測試肉品行'").get().id;
    const f = mkReview(db, { vendorRaw: '測試肉品行', lines: [L('己貨', 1)] });
    await t.call('POST', `/slips/${f}/confirm`, { token: acc });
    assert.strictEqual(db.prepare('SELECT vendor_id v FROM slips WHERE id = ?').get(f).v, seeded);
    assert.strictEqual(vendorsOf(db, 'C').length, 2);
    // GET /vendors?all=1 帶 auto_created
    const list = await t.call('GET', '/vendors?all=1', { token: acc });
    assert.strictEqual(list.data.find((v) => v.name === 'ABC Foods').auto_created, 1);
    assert.strictEqual(list.data.find((v) => v.name === '測試肉品行').auto_created, 0);
  } finally { await t.close(); }
});

test('入帳自動建品項＋alias；下一張同廠商同寫法自動帶入（makeCtx）；同名品項不重複', async () => {
  const t = await startApp();
  try {
    const db = t.app.db;
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C);
    const v = db.prepare("SELECT id FROM vendors WHERE brand_id='C' AND name='範例蔬果行'").get().id;
    const a = mkReview(db, { vendor: v, lines: [L('神秘辣椒粉', 100, { unit: '包' }), L('無單位物', 50, { unit: '' }), L('  ', 1)] });
    // 第三列 raw 空白：不建；但金額規則要過 → 直接把它刪掉
    db.prepare("DELETE FROM slip_lines WHERE slip_id = ? AND seq = 3").run(a);
    db.prepare('UPDATE slips SET total = 150 WHERE id = ?').run(a);
    const r = await t.call('POST', `/slips/${a}/confirm`, { token: acc });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const its = itemsOf(db, 'C');
    assert.deepStrictEqual(its.map((i) => [i.name, i.category, i.base_unit, i.active]), [['神秘辣椒粉', null, '包', 1], ['無單位物', null, null, 1]]);
    assert.strictEqual(audits(db, 'auto_item').length, 2);
    const lines = db.prepare('SELECT * FROM slip_lines WHERE slip_id = ? ORDER BY seq').all(a);
    assert.deepStrictEqual(lines.map((l) => l.item_id), its.map((i) => i.id));
    assert.strictEqual(db.prepare('SELECT item_id i FROM item_aliases WHERE vendor_id = ? AND raw_name = ?').get(v, '神秘辣椒粉').i, its[0].id);
    // 單位空白 → base_unit NULL → 該列標 UNIT_UNCONVERTED（單位有值但統一單位 NULL 也一樣）
    const flags = JSON.parse(lines[1].flags);
    assert.ok(flags.includes('UNIT_UNCONVERTED'), JSON.stringify(flags));
    assert.ok(!JSON.parse(lines[0].flags).includes('UNIT_UNCONVERTED'));
    // 下一張：辨識當下用廠商記憶自動帶品項
    const { makeCtx } = require('../server/slips-common');
    const ctx = makeCtx(db, 'C', v, true);
    assert.strictEqual(ctx.resolveItem({ raw_name: '神秘辣椒粉' }).id, its[0].id);
    // 另一張同名（沒對照 item_id）→ 沿用同一品項，不重複
    const b = mkReview(db, { vendor: v, lines: [L('神秘辣椒粉', 40)] });
    await t.call('POST', `/slips/${b}/confirm`, { token: acc });
    assert.strictEqual(itemsOf(db, 'C').length, 2);
    // 跨品牌不共用
    const accM = await t.login('acc-m', PASS.SEED_PASS_ACC_M);
    const vm = db.prepare("SELECT id FROM vendors WHERE brand_id='M' LIMIT 1").get().id;
    const m = mkReview(db, { brand: 'M', store: 'M01', vendor: vm, lines: [L('神秘辣椒粉', 40)] });
    await t.call('POST', `/slips/${m}/confirm`, { token: accM });
    assert.strictEqual(itemsOf(db, 'M').length, 1);
    // base_unit NULL 的單價比較：unit_cost 為 null（converted=false）
    const cl = calc.confirmedLines(db, { brandId: 'C', slipId: a });
    assert.strictEqual(cl[1].converted, false); assert.strictEqual(cl[1].unit_cost, null);
    assert.strictEqual(cl[0].converted, true);
  } finally { await t.close(); }
});

test('入帳失敗（紅色檢核）整筆回滾，不留自動建的主檔；取消入帳不刪主檔', async () => {
  const t = await startApp();
  try {
    const db = t.app.db;
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C);
    const bad = mkReview(db, { vendorRaw: '回滾商行', lines: [L('回滾品', 100)] });
    db.prepare('UPDATE slips SET total = 999 WHERE id = ?').run(bad);           // 總額對不上 → SUM_MISMATCH 紅
    const r = await t.call('POST', `/slips/${bad}/confirm`, { token: acc });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(vendorsOf(db, 'C').length, 0); assert.strictEqual(itemsOf(db, 'C').length, 0);
    assert.strictEqual(db.prepare('SELECT vendor_id v FROM slips WHERE id = ?').get(bad).v, null);
    assert.strictEqual(audits(db, 'auto_vendor').length, 0);
    const ok = mkReview(db, { vendorRaw: '保留商行', lines: [L('保留品', 100)] });
    assert.strictEqual((await t.call('POST', `/slips/${ok}/confirm`, { token: acc })).ok, true);
    const u = await t.call('POST', `/slips/${ok}/unconfirm`, { token: acc, body: { reason: '測試' } });
    assert.strictEqual(u.ok, true);
    assert.strictEqual(vendorsOf(db, 'C').length, 1); assert.strictEqual(itemsOf(db, 'C').length, 1);
  } finally { await t.close(); }
});

test('category NULL：成本歸未分類、不推損益（歸待補對照）；補分類後該月重排推送且成本歸位', async () => {
  const t = await startApp();
  try {
    const db = t.app.db;
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C);
    db.prepare("UPDATE stores SET pnl_unit_code = 'U-C01' WHERE code = 'C01'").run();
    const v = db.prepare("SELECT id FROM vendors WHERE brand_id='C' AND name='測試肉品行'").get().id;
    db.prepare("INSERT INTO pnl_map (brand_id, vendor_id, category, acc_id) VALUES ('C', ?, '食材', '5101')").run(v);
    const a = mkReview(db, { vendor: v, date: '2026-10-05', lines: [L('全新食材X', 300)] });
    assert.strictEqual((await t.call('POST', `/slips/${a}/confirm`, { token: acc })).ok, true);
    const sid = storeId(db, 'C01');
    let cm = computeMonth(db, sid, '2026-10');
    assert.deepStrictEqual(cm.entries, {}); assert.strictEqual(cm.unmapped, 30000);
    assert.strictEqual(calc.costReport(db, { brandId: 'C', month: '2026-10' }).by_category['未分類'], 300);
    const ur = unmappedReport(db, { brandId: 'C' });
    assert.ok(ur.rows.some((r) => r.category === '未分類' && r.amount === 300));
    // GET /items：NULL 排最前、帶 auto_created；?needs_category=1 只回待補
    const list = await t.call('GET', '/items', { token: acc });
    assert.strictEqual(list.data[0].name, '全新食材X'); assert.strictEqual(list.data[0].auto_created, 1); assert.strictEqual(list.data[0].category, null);
    const only = await t.call('GET', '/items?needs_category=1', { token: acc });
    assert.deepStrictEqual(only.data.map((i) => i.name), ['全新食材X']);
    // 補分類 + 統一單位 → 重推排程、成本歸位
    db.prepare('DELETE FROM pnl_outbox').run();
    const itm = list.data[0];
    const put = await t.call('PUT', `/items/${itm.id}`, { token: acc, body: { category: '食材' } });
    assert.strictEqual(put.ok, true, JSON.stringify(put));
    assert.strictEqual(put.data.category, '食材');
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM pnl_outbox WHERE store_id = ? AND month = '2026-10'").get(sid).c, 1);
    cm = computeMonth(db, sid, '2026-10');
    assert.deepStrictEqual(cm.entries, { 5101: 30000 }); assert.strictEqual(cm.unmapped, 0);
    assert.strictEqual(calc.costReport(db, { brandId: 'C', month: '2026-10' }).by_category['食材'], 300);
    // 補 base_unit 也會排重推（先清掉 outbox 驗證）
    db.prepare('DELETE FROM pnl_outbox').run();
    const it2 = db.prepare("SELECT id FROM items WHERE name = '全新食材X'").get().id;
    const pu = await t.call('PUT', `/items/${it2}`, { token: acc, body: { base_unit: '斤' } });
    assert.strictEqual(pu.ok, true);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM pnl_outbox').get().c, 1);
  } finally { await t.close(); }
});

test('遷移 v10：既有 v9 資料庫（含已入帳資料、既有品項）安全重建 items、冪等；NULL 可寫入；舊程式寫法仍可用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v10mig-'));
  const raw = new DatabaseSync(path.join(dir, 'purchase.db'));
  raw.exec('PRAGMA foreign_keys = ON;');
  MIGRATIONS.slice(0, 9).forEach((m, i) => { raw.exec(m); raw.exec(`PRAGMA user_version = ${i + 1}`); });
  raw.exec(`INSERT INTO brands (id,name) VALUES ('C','央廚');
    INSERT INTO stores (brand_id, code, name, pass_hash) VALUES ('C','C01','店','x');
    INSERT INTO vendors (brand_id, name) VALUES ('C','舊廠商');
    INSERT INTO items (brand_id, name, category, base_unit, active) VALUES ('C','舊品項A','食材','公斤',1), ('C','舊品項B','包材','',0);
    INSERT INTO unit_conv (item_id, unit, factor_to_base) VALUES (1,'箱',10);
    INSERT INTO item_aliases (vendor_id, raw_name, item_id) VALUES (1,'舊A',1);
    INSERT INTO slips (id, client_id, store_id, brand_id, vendor_id, status, doc_date, total, uploaded_at, confirmed_at) VALUES ('S1','c1',1,'C',1,'confirmed','2026-09-01',100,'t','t');
    INSERT INTO slip_lines (slip_id, seq, raw_name, item_id, qty, unit, unit_price, amount, checked) VALUES ('S1',1,'舊A',1,10,'公斤',10,100,1);`);
  raw.close();
  let db = openDb(dir);
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 10);
  const items = db.prepare('SELECT * FROM items ORDER BY id').all();
  assert.deepStrictEqual(items.map((i) => [i.id, i.name, i.category, i.base_unit, i.active, i.auto_created]), [[1, '舊品項A', '食材', '公斤', 1, 0], [2, '舊品項B', '包材', '', 0, 0]]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM unit_conv').get().c, 1);
  assert.strictEqual(db.prepare('SELECT item_id i FROM item_aliases').get().i, 1);
  assert.strictEqual(db.prepare('SELECT auto_created a FROM vendors').get().a, 0);
  assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.strictEqual(calc.costReport(db, { brandId: 'C', month: '2026-09' }).by_category['食材'], 100);   // 既有報表照舊
  // 可寫 NULL；AUTOINCREMENT 續號
  const id = Number(db.prepare("INSERT INTO items (brand_id, name, category, base_unit, auto_created) VALUES ('C','新',NULL,NULL,1)").run().lastInsertRowid);
  assert.strictEqual(id, 3);
  // 舊程式寫法（只給舊欄位）仍可用
  db.prepare("INSERT INTO items (brand_id, name, category, base_unit) VALUES ('C','舊程式寫入','食材','個')").run();
  db.close();
  db = openDb(dir);                                                // 冪等：再開一次不重跑、資料不變
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM items').get().c, 4);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('nameKey：全形空白、括號、全半形視同；自動建立門檻', () => {
  const { nameKey, okAutoItemName, okAutoVendorName } = require('../server/slips-common');
  assert.strictEqual(nameKey('新 品'), nameKey('新品'));
  assert.strictEqual(nameKey('新　品'), nameKey('新品'));
  assert.strictEqual(nameKey('新來源(食品)'), nameKey('新來源（食品）'));
  assert.strictEqual(nameKey('ＡＢＣ［甲］・乙'), nameKey('abc甲乙'));
  for (const bad of ['甲', '', '123', '1,200.5', '- -', '合計', '小計金額', '運費', 'x'.repeat(61)]) assert.strictEqual(okAutoItemName(bad), false, bad);
  assert.strictEqual(okAutoItemName('高麗菜'), true);
  assert.strictEqual(okAutoVendorName('12'), false); assert.strictEqual(okAutoVendorName('合計行'), true); assert.strictEqual(okAutoVendorName('x'.repeat(60)), true);
});

test('入帳：門檻不合的品項不建（item_id NULL）、括號全形比對沿用既有、廠商不合格不建', async () => {
  const t = await startApp();
  try {
    const db = t.app.db;
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C);
    db.prepare("INSERT INTO items (brand_id, name, category, base_unit) VALUES ('C','新來源（食品）','食材','包')").run();
    const id = mkReview(db, { vendorRaw: '88', lines: [L('新來源(食品)', 10), L('合計', 5), L('甲', 5), L('300', 5), L('新　品', 5), L('新品', 5)] });
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).ok, true);
    const ls = db.prepare('SELECT raw_name, item_id FROM slip_lines WHERE slip_id = ? ORDER BY seq').all(id);
    assert.deepStrictEqual(ls.map((l) => l.item_id == null), [false, true, true, true, false, false]);
    assert.strictEqual(ls[4].item_id, ls[5].item_id);
    assert.strictEqual(itemsOf(db, 'C').length, 1);
    assert.strictEqual(db.prepare('SELECT vendor_id v FROM slips WHERE id = ?').get(id).v, null);
    assert.strictEqual(vendorsOf(db, 'C').length, 0);
  } finally { await t.close(); }
});

test('開庫冪等修正 sqlite_sequence：seq 不小於 MAX(id)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-'));
  let db = openDb(dir);
  db.prepare("INSERT OR IGNORE INTO brands (id,name) VALUES ('C','央廚')").run();
  db.prepare("INSERT INTO items (brand_id, name, category, base_unit) VALUES ('C','a','食材','個')").run();
  db.prepare("INSERT INTO items (brand_id, name, category, base_unit) VALUES ('C','b','食材','個')").run();
  db.prepare("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'items'").run();
  db.close(); db = openDb(dir);
  assert.strictEqual(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='items'").get().seq, 2);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
