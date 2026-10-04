'use strict';
// 「品項金額已含稅」規則（plan.md 總額規則補充，Eason 2026-10-04 定案 A）。測試資料全部虛構。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp, PASS, uuid } = require('./helpers');
const { sumCheck } = require('../web/js/rules');
const calc = require('../server/calc');
const { openDb } = require('../server/db');

const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const AI = (o) => JSON.stringify(Object.assign({ vendor: '', date: today(), doc_no: 'T1', lines: [], subtotal: '', tax: '', total: '', handwritten_changes: '' }, o));
const vendorId = (db, name) => db.prepare('SELECT id FROM vendors WHERE brand_id = ? AND name = ?').get('C', name).id;
const itemId = (db, name) => db.prepare('SELECT id FROM items WHERE brand_id = ? AND name = ?').get('C', name).id;

// 10 列加總 35,120（九列 3,500＋一列 3,620）
const TEN = [3500, 3500, 3500, 3500, 3500, 3500, 3500, 3500, 3500, 3620];
const tenLines = () => TEN.map((a, i) => ({ name: `範例品${i + 1}`, qty: '1', unit: '公斤', unit_price: String(a), amount: String(a) }));
const INC = () => AI({ lines: tenLines(), subtotal: '33448', tax: '1672', total: '35120' });

async function start() {
  const queue = [];
  const t = await startApp({ recognize: async () => queue.shift() });
  t.queue = queue;
  t.acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C);
  t.store = await t.login('C01', PASS.SEED_PASS_C01);
  return t;
}
async function recognize(t, ai, vendor_id) {
  t.queue.push(ai);
  const up = await t.upload(t.store, vendor_id === undefined ? {} : { vendor_id });
  assert.strictEqual(up.ok, true, JSON.stringify(up));
  await t.app.worker.drain();
  return up.data.id;
}
const get = async (t, id) => (await t.call('GET', `/slips/${id}`, { token: t.acc })).data;
async function checkAll(t, id) {
  const d = await get(t, id);
  const lines = d.lines.map((l) => ({ id: l.id, raw_name: l.raw_name, unit: l.unit, qty: l.qty, unit_price: l.unit_price, amount: l.amount, item_id: l.item_id, checked: 1 }));
  const p = await t.call('PUT', `/slips/${id}`, { token: t.acc, body: { lines } });
  assert.strictEqual(p.ok, true, JSON.stringify(p));
}
const confirm = (t, id) => t.call('POST', `/slips/${id}/confirm`, { token: t.acc, body: {} });

test('規則：含稅單 35,120／33,448／1,672 勾選後相符、未勾選仍紅；一張單只套一條式子（無 OR）', () => {
  const sum = (arr) => arr;
  assert.strictEqual(sumCheck(sum(TEN), 33448, 1672, 35120, 1).ok, true);
  assert.strictEqual(sumCheck(sum(TEN), 33448, 1672, 35120, 0).ok, false);
  assert.strictEqual(sumCheck(sum(TEN), 33448, 1672, 35120).ok, false);            // 省略參數＝0＝原規則
  // 同一組數字、兩種旗標結果不同（反向）：各列 33,448＋稅 1,672＝35,120 是原規則；已含稅旗標下各列加總≠總額
  const un = [33448];
  assert.strictEqual(sumCheck(un, 33448, 1672, 35120, 0).ok, true);
  assert.strictEqual(sumCheck(un, 33448, 1672, 35120, 1).ok, false);
  // 已含稅：未稅合計＋稅額＝總額才核對；數字不合 → 紅
  assert.strictEqual(sumCheck(sum(TEN), 33000, 1672, 35120, 1).ok, false);
  // 只填稅額不填未稅合計（或相反、或都空白）→ 不核對
  assert.strictEqual(sumCheck(sum(TEN), null, 1672, 35120, 1).ok, true);
  assert.strictEqual(sumCheck(sum(TEN), null, 99999, 35120, 1).ok, false);   // 審查 🟡：稅額 ≥ 總額一律紅（AI 常把總計誤讀進稅額欄）
  assert.strictEqual(sumCheck(sum(TEN), 12345, null, 35120, 1).ok, true);
  assert.strictEqual(sumCheck(sum(TEN), null, null, 35120, 1).ok, true);
  // 缺值仍是紅
  assert.strictEqual(sumCheck(sum(TEN), null, null, null, 1).ok, false);
  assert.strictEqual(sumCheck([], null, null, 100, 1).ok, false);
  assert.strictEqual(sumCheck([100, null], null, null, 100, 1).ok, false);
  // 原規則不變
  assert.strictEqual(sumCheck([4200], 4000, 200, 4400, 0).ok, false);
  assert.strictEqual(sumCheck([4000], 4000, 200, 4200, 0).ok, true);
});

test('API：PUT tax_included 勾選前紅、勾選後相符、取消又紅；非 0/1 → BAD_INPUT；詳情回傳旗標', async () => {
  const t = await start();
  try {
    const id = await recognize(t, INC());
    let d = await get(t, id);
    assert.strictEqual(d.tax_included, 0);
    assert.ok(d.flags.includes('SUM_MISMATCH'));
    let p = await t.call('PUT', `/slips/${id}`, { token: t.acc, body: { tax_included: 1 } });
    assert.strictEqual(p.data.tax_included, 1);
    assert.ok(!p.data.flags.includes('SUM_MISMATCH'));
    p = await t.call('PUT', `/slips/${id}`, { token: t.acc, body: { tax_included: 0 } });
    assert.ok(p.data.flags.includes('SUM_MISMATCH'));
    assert.strictEqual((await t.call('PUT', `/slips/${id}`, { token: t.acc, body: { tax_included: 2 } })).error, 'BAD_INPUT');
    assert.strictEqual((await t.call('PUT', `/slips/${id}`, { token: t.acc, body: { tax_included: 'yes' } })).error, 'BAD_INPUT');
    // 已含稅、只填稅額不填未稅合計 → 不核對
    p = await t.call('PUT', `/slips/${id}`, { token: t.acc, body: { tax_included: 1, subtotal: null } });
    assert.ok(!p.data.flags.includes('SUM_MISMATCH'));
    // 已含稅、未稅合計＋稅額 ≠ 總額 → 紅
    p = await t.call('PUT', `/slips/${id}`, { token: t.acc, body: { subtotal: 30000 } });
    assert.ok(p.data.flags.includes('SUM_MISMATCH'));
  } finally { await t.close(); }
});

test('廠商記憶：入帳寫回 vendors；同廠商新單預設帶入、別家廠商不受影響、會計可改、再入帳可改回', async () => {
  const t = await start();
  try {
    const db = t.app.db;
    const vA = vendorId(db, '測試肉品行'), vB = vendorId(db, '範例蔬果行');
    assert.strictEqual(db.prepare('SELECT tax_included t FROM vendors WHERE id = ?').get(vA).t, 0);   // 預設 0
    const id1 = await recognize(t, INC(), vA);
    assert.strictEqual((await get(t, id1)).tax_included, 0);                                             // 辨識當下廠商還是 0
    await t.call('PUT', `/slips/${id1}`, { token: t.acc, body: { tax_included: 1 } });
    await checkAll(t, id1);
    const c = await confirm(t, id1);
    assert.strictEqual(c.ok, true, JSON.stringify(c));
    assert.strictEqual(db.prepare('SELECT tax_included t FROM vendors WHERE id = ?').get(vA).t, 1);
    assert.strictEqual(db.prepare('SELECT tax_included t FROM vendors WHERE id = ?').get(vB).t, 0);
    // 新單（廠商 A）：預設已含稅、同樣的單直接相符；廠商 B：預設 0
    const id2 = await recognize(t, INC(), vA);
    const d2 = await get(t, id2);
    assert.strictEqual(d2.tax_included, 1); assert.ok(!d2.flags.includes('SUM_MISMATCH'));
    const id3 = await recognize(t, INC(), vB);
    assert.strictEqual((await get(t, id3)).tax_included, 0);
    // 沒選廠商、AI 讀到廠商名比對到 A → 一樣帶預設
    const id4 = await recognize(t, AI({ vendor: '測試肉品行', lines: tenLines(), subtotal: '33448', tax: '1672', total: '35120' }));
    assert.strictEqual((await get(t, id4)).tax_included, 1);
    // 會計改成未勾（單上是未稅金額）並入帳 → 記憶改回 0
    t.queue.push(AI({ lines: [{ name: '範例品', qty: '1', unit: '公斤', unit_price: '1000', amount: '1000' }], subtotal: '1000', tax: '50', total: '1050' }));
    const up = await t.upload(t.store, { vendor_id: vA }); await t.app.worker.drain();
    const id5 = up.data.id;
    assert.strictEqual((await get(t, id5)).tax_included, 1);
    assert.ok((await get(t, id5)).flags.includes('SUM_MISMATCH'));                                     // 預設 1 但這張其實未稅 → 紅
    await t.call('PUT', `/slips/${id5}`, { token: t.acc, body: { tax_included: 0 } });
    await checkAll(t, id5);
    assert.strictEqual((await confirm(t, id5)).ok, true);
    assert.strictEqual(db.prepare('SELECT tax_included t FROM vendors WHERE id = ?').get(vA).t, 0);
  } finally { await t.close(); }
});

test('成本：tax_included=1 時成本＝總額、稅額不再分攤；報表／legacy／損益推送同一份結果', async () => {
  const t = await start();
  try {
    const db = t.app.db;
    const hb = itemId(db, '測試高麗菜');
    const id = await recognize(t, INC(), vendorId(db, '測試肉品行'));
    await t.call('PUT', `/slips/${id}`, { token: t.acc, body: { tax_included: 1 } });
    await checkAll(t, id);
    assert.strictEqual((await confirm(t, id)).ok, true);
    const month = today().slice(0, 7);
    const s = calc.slipCosts(db, { brandId: 'C' })[0];
    assert.strictEqual(s.total_cents, 3512000);
    assert.strictEqual(s.cats['未分類'], 3512000);                                                      // 沒對品名 → 全在未分類，沒有多出稅額
    const r = await t.call('GET', `/reports/cost?month=${month}`, { token: t.acc });
    assert.strictEqual(r.data.total, 35120);
    assert.strictEqual(r.data.by_vendor[0].amount, 35120);
    // 同一張改成「未勾、稅外加」的對照：同樣各列金額、稅 1672 → 成本 35120 + 1672
    db.prepare('UPDATE slips SET tax_included = 0, total = 36792 WHERE id = ?').run(id);
    assert.strictEqual(calc.slipCosts(db, { brandId: 'C' })[0].total_cents, 3679200);
    void hb;
  } finally { await t.close(); }
});

function mkSlip(db, { vendor, date, tax, total, taxIncluded, lines }) {
  const id = `S${date.replace(/-/g, '')}-${uuid().slice(0, 6)}`;
  db.prepare('INSERT INTO slips (id, client_id, store_id, brand_id, vendor_id, status, doc_date, tax, total, tax_included, uploaded_at, confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, uuid(), db.prepare("SELECT id FROM stores WHERE code='C01'").get().id, 'C', vendor, 'confirmed', date, tax, total, taxIncluded, '2026-10-01T00:00:00Z', `${date}T12:00:00.000Z`);
  lines.forEach((l, i) => db.prepare('INSERT INTO slip_lines (slip_id, seq, raw_name, item_id, qty, unit, unit_price, amount, checked) VALUES (?,?,?,?,?,?,?,?,1)')
    .run(id, i + 1, 'x', l.item, l.qty, l.unit, l.price, l.amount));
  return id;
}

test('未稅單價：含稅廠商與未稅廠商同品項不產生假漲跌；加權平均用未稅金額；稅額空白／總額 0 → 1:1', async () => {
  const t = await start();
  try {
    const db = t.app.db;
    const hb = itemId(db, '測試高麗菜'), vA = vendorId(db, '測試肉品行'), vB = vendorId(db, '範例蔬果行');
    // 廠商 A（未稅）：10 公斤、金額 1000、稅 50、總額 1050 → 每公斤 100
    const s1 = mkSlip(db, { vendor: vA, date: '2026-10-01', tax: 50, total: 1050, taxIncluded: 0, lines: [{ item: hb, qty: 10, unit: '公斤', price: 100, amount: 1000 }] });
    // 廠商 B（含稅）：10 公斤、金額 1050（含稅）、稅 50、總額 1050 → 未稅 1050×1000/1050＝1000 → 每公斤 100
    const s2 = mkSlip(db, { vendor: vB, date: '2026-10-02', tax: 50, total: 1050, taxIncluded: 1, lines: [{ item: hb, qty: 10, unit: '公斤', price: 105, amount: 1050 }] });
    const ls = calc.confirmedLines(db, { brandId: 'C', itemId: hb });
    assert.deepStrictEqual(ls.map((l) => l.unit_cost), [100, 100]);
    assert.strictEqual(ls[1].amount, 1050);                                                            // 原始金額不動
    assert.strictEqual(calc.generatePriceAlerts(db, s2, '2026-10-02T00:00:00Z'), 0);                    // 假漲跌：沒有
    assert.strictEqual(calc.avgFor(db, 'C', hb, '2026-10', 1), 100);
    void s1;
    // 稅額空白 → 1:1（用含稅金額）；總額 0 → 1:1
    mkSlip(db, { vendor: vB, date: '2026-10-03', tax: null, total: 1100, taxIncluded: 1, lines: [{ item: hb, qty: 10, unit: '公斤', price: 110, amount: 1100 }] });
    mkSlip(db, { vendor: vB, date: '2026-10-04', tax: 50, total: 0, taxIncluded: 1, lines: [{ item: hb, qty: 10, unit: '公斤', price: 120, amount: 1200 }] });
    assert.deepStrictEqual(calc.confirmedLines(db, { brandId: 'C', itemId: hb }).map((l) => l.unit_cost), [100, 100, 110, 120]);
    assert.strictEqual(calc.avgFor(db, 'C', hb, '2026-10', 1), 107.5);                                  // (1000+1000+1100+1200)/40
    // 真的漲價仍會提醒：含稅廠商未稅 1500 → 每公斤 150
    const s5 = mkSlip(db, { vendor: vB, date: '2026-10-05', tax: 75, total: 1575, taxIncluded: 1, lines: [{ item: hb, qty: 10, unit: '公斤', price: 157.5, amount: 1575 }] });
    assert.strictEqual(calc.generatePriceAlerts(db, s5, '2026-10-05T00:00:00Z'), 1);
    const a = db.prepare('SELECT prev_price, new_price FROM price_alerts').get();
    assert.deepStrictEqual([a.prev_price, a.new_price], [120, 150]);
    // 每日明細 API：amount 是單上金額、unit_cost 是未稅單價
    const r = await t.call('GET', '/reports/daily?from=2026-10-02&to=2026-10-02', { token: t.acc });
    assert.deepStrictEqual([r.data[0].amount, r.data[0].unit_cost], [1050, 100]);
  } finally { await t.close(); }
});

test('遷移 v9：既有 v8 資料庫安全升級，既有貨單與廠商 tax_included＝0，資料不動；重開不重跑', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxmig-'));
  let db = openDb(dir);
  db.exec("INSERT INTO brands (id,name) VALUES ('X','小辛辣')");
  db.exec("INSERT INTO stores (brand_id,code,name,pass_hash) VALUES ('X','S1','店','h')");
  db.exec("INSERT INTO vendors (brand_id,name) VALUES ('X','舊廠商')");
  db.exec("INSERT INTO slips (id,client_id,store_id,brand_id,status,doc_date,tax,total,uploaded_at) VALUES ('S1','c1',1,'X','confirmed','2026-09-01',50,1050,'2026-09-01T00:00:00Z')");
  db.exec('ALTER TABLE slips DROP COLUMN tax_included; ALTER TABLE vendors DROP COLUMN tax_included; ALTER TABLE vendors DROP COLUMN auto_created; PRAGMA user_version = 8;');   // 倒回 v8
  db.close();
  db = openDb(dir);
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.strictEqual(db.prepare("SELECT tax_included t, total FROM slips WHERE id='S1'").get().t, 0);
  assert.strictEqual(db.prepare("SELECT total FROM slips WHERE id='S1'").get().total, 1050);
  assert.strictEqual(db.prepare("SELECT tax_included t FROM vendors WHERE name='舊廠商'").get().t, 0);
  db.close();
  db = openDb(dir);
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 10);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('審查 🟡：含稅單稅額 ≥ 總額或為負 → 不相符；未稅比例退回 1:1（不產生 0 或負單價）', () => {
  const Rules = require('../web/js/rules.js');
  const calc = require('../server/calc.js');
  assert.strictEqual(Rules.sumCheck([1000], null, 2000, 1000, true).ok, false);
  assert.strictEqual(Rules.sumCheck([1000], null, 1000, 1000, true).ok, false);
  assert.strictEqual(Rules.sumCheck([1000], null, -5, 1000, true).ok, false);
  assert.strictEqual(Rules.sumCheck([1050], null, 50, 1050, true).ok, true);
  if (typeof calc.netRatio === 'function') {
    assert.strictEqual(calc.netRatio({ tax_included: 1, tax: 2000, total: 1000 }), 1);
  }
});
