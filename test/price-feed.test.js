'use strict';
// 貨單價格同步 P1：入帳事件 price_feed、遷移回填、GET /svc/price-feed（契約 mala-store-ops docs/price-sync/plan.md C1–C3）。全部虛構金鑰
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp, PASS } = require('./helpers');
const { openDb } = require('../server/db');
const feed = require('../server/price-feed');

const KEY = 'test-svc-key-0123456789';
const sk = (code) => ({ 'X-Store-Key': KEY, 'X-Store-Code': code });
const AI = (o) => JSON.stringify(Object.assign({ vendor: '測試肉品行', date: '2026-10-01', doc_no: 'A1', lines: [{ name: '範例肉末', qty: '2', unit: '包', unit_price: '200', amount: '400' }],
  subtotal: '', tax: '', total: '400', handwritten_changes: '' }, o));

async function reviewSlip(t) {
  const st = await t.login('C01', PASS.SEED_PASS_C01);
  const up = await t.upload(st, { vendor_name: '測試肉品行' });
  assert.ok(up.ok, JSON.stringify(up));
  await t.app.worker.drain();
  return up.data.id;
}
async function confirmSlip(t, acc, id, body) {
  const d = (await t.call('GET', `/slips/${id}`, { token: acc })).data;
  const lines = d.lines.map((l) => ({ id: l.id, raw_name: l.raw_name, qty: l.qty, unit: l.unit, unit_price: l.unit_price, amount: l.amount, checked: 1 }));
  await t.call('PUT', `/slips/${id}`, { token: acc, body: Object.assign({ lines }, body || {}) });
  const r = await t.call('POST', `/slips/${id}/confirm`, { token: acc });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
}

test('taxStatusOf 跟 netRatio 同一組條件', () => {
  assert.strictEqual(feed.taxStatusOf({ tax_included: 0, tax: 20, total: 420 }), 'untaxed');
  assert.strictEqual(feed.taxStatusOf({ tax_included: 1, tax: 20, total: 420 }), 'split');
  for (const s of [{ tax: null, total: 420 }, { tax: 20, total: 0 }, { tax: -1, total: 420 }, { tax: 420, total: 420 }]) {
    assert.strictEqual(feed.taxStatusOf(Object.assign({ tax_included: 1 }, s)), 'unknown', JSON.stringify(s));
  }
});

test('入帳寫一筆 confirm、取消入帳寫一筆 unconfirm；入帳被擋不留事件；內容符合契約', async () => {
  const t = await startApp({ recognize: async () => AI(), cfg: { STORE_SVC_KEY: KEY, PRICE_FEED_STORES: ['C01'] } });
  try {
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C);
    const id = await reviewSlip(t);
    // 還有明細沒打勾 → 入帳被擋，交易回滾，不留事件
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).error, 'CONFLICT');
    assert.strictEqual(t.app.db.prepare('SELECT COUNT(*) c FROM price_feed').get().c, 0);
    await confirmSlip(t, acc, id);
    const r1 = await t.call('GET', '/svc/price-feed', { headers: sk('C01') });
    assert.strictEqual(r1.status, 200, JSON.stringify(r1));
    const f = r1.data;
    assert.match(f.epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.strictEqual(f.events.length, 1); assert.strictEqual(f.has_more, false); assert.strictEqual(f.last_id, f.events[0].id);
    const e = f.events[0];
    assert.deepStrictEqual(Object.keys(e).sort(), ['at', 'doc_date', 'id', 'kind', 'lines', 'photos', 'slip_id', 'tax_status', 'vendor_name'].sort());
    assert.strictEqual(e.kind, 'confirm'); assert.strictEqual(e.slip_id, id); assert.strictEqual(e.doc_date, '2026-10-01');
    assert.strictEqual(e.tax_status, 'untaxed'); assert.deepStrictEqual(e.photos, [1]);
    assert.deepStrictEqual(Object.keys(e.lines[0]).sort(), ['amount', 'base_unit', 'factor', 'item_id', 'item_name', 'net_amount', 'qty', 'raw_name', 'seq', 'unit'].sort());
    assert.strictEqual(e.lines[0].qty, 2); assert.strictEqual(e.lines[0].unit, '包'); assert.strictEqual(e.lines[0].net_amount, 400);
    assert.strictEqual((await t.call('POST', `/slips/${id}/unconfirm`, { token: acc, body: { reason: '單價打錯' } })).ok, true);
    const r2 = (await t.call('GET', `/svc/price-feed?after=${f.last_id}`, { headers: sk('C01') })).data;
    assert.strictEqual(r2.events.length, 1);
    assert.strictEqual(r2.events[0].kind, 'unconfirm'); assert.deepStrictEqual(r2.events[0].lines, []); assert.deepStrictEqual(r2.events[0].photos, []);
    // 空頁：last_id＝傳入的 after
    const r3 = (await t.call('GET', `/svc/price-feed?after=${r2.last_id}`, { headers: sk('C01') })).data;
    assert.deepStrictEqual([r3.events.length, r3.last_id, r3.has_more], [0, r2.last_id, false]);
  } finally { await t.close(); }
});

test('含稅單：稅額拆得開 → split 且 net_amount 已扣稅；稅額空白 → unknown', async () => {
  const t = await startApp({ recognize: async () => AI({ lines: [{ name: '範例肉末', qty: '1', unit: '包', unit_price: '420', amount: '420' }], total: '420' }), cfg: { STORE_SVC_KEY: KEY, PRICE_FEED_STORES: ['C01'] } });
  try {
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C);
    const a = await reviewSlip(t);
    await confirmSlip(t, acc, a, { tax_included: 1, tax: 20, total: 420 });
    const b = await reviewSlip(t);
    await confirmSlip(t, acc, b, { tax_included: 1, tax: null, total: 420 });
    const ev = (await t.call('GET', '/svc/price-feed', { headers: sk('C01') })).data.events;
    assert.strictEqual(ev[0].tax_status, 'split'); assert.strictEqual(ev[0].lines[0].net_amount, 400);
    assert.strictEqual(ev[1].tax_status, 'unknown'); assert.strictEqual(ev[1].lines[0].net_amount, 420);
  } finally { await t.close(); }
});

test('分頁：450 筆分三頁不漏不重；limit 上限 200', async () => {
  const t = await startApp({ cfg: { STORE_SVC_KEY: KEY, PRICE_FEED_STORES: ['C01'] } });
  try {
    const db = t.app.db;
    const c01 = db.prepare("SELECT id FROM stores WHERE code='C01'").get().id;
    const ins = db.prepare('INSERT INTO price_feed (store_id, slip_id, kind, at, payload) VALUES (?,?,?,?,?)');
    const pl = JSON.stringify({ doc_date: '2026-10-01', vendor_name: 'x', tax_status: 'untaxed', photos: [], lines: [] });
    db.tx(() => { for (let i = 0; i < 450; i++) ins.run(c01, 'S' + i, 'confirm', '2026-10-01T00:00:' + String(i).padStart(5, '0'), pl); });
    const seen = []; let after = 0, pages = 0, more = true;
    while (more) {
      const d = (await t.call('GET', `/svc/price-feed?after=${after}&limit=999`, { headers: sk('C01') })).data;
      assert.ok(d.events.length <= 200);
      seen.push(...d.events.map((e) => e.id)); after = d.last_id; more = d.has_more; pages++;
    }
    assert.strictEqual(pages, 3); assert.strictEqual(seen.length, 450); assert.strictEqual(new Set(seen).size, 450);
    assert.deepStrictEqual(seen, seen.slice().sort((x, y) => x - y));
  } finally { await t.close(); }
});

test('範圍：不在 PRICE_FEED_STORES、名單空、一般登入、錯金鑰都讀不到；只回自己門市的事件', async () => {
  const t = await startApp({ cfg: { STORE_SVC_KEY: KEY, PRICE_FEED_STORES: ['C01'] } });
  try {
    const db = t.app.db;
    const id = (c) => db.prepare('SELECT id FROM stores WHERE code=?').get(c).id;
    const pl = JSON.stringify({ doc_date: null, vendor_name: null, tax_status: 'untaxed', photos: [], lines: [] });
    db.prepare('INSERT INTO price_feed (store_id, slip_id, kind, at, payload) VALUES (?,?,?,?,?)').run(id('M01'), 'SM', 'confirm', 'a', pl);
    db.prepare('INSERT INTO price_feed (store_id, slip_id, kind, at, payload) VALUES (?,?,?,?,?)').run(id('C01'), 'SC', 'confirm', 'b', pl);
    const mine = (await t.call('GET', '/svc/price-feed', { headers: sk('C01') })).data.events;
    assert.deepStrictEqual(mine.map((e) => e.slip_id), ['SC']);
    assert.strictEqual((await t.call('GET', '/svc/price-feed', { headers: sk('M01') })).error, 'FORBIDDEN');
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    assert.strictEqual((await t.call('GET', '/svc/price-feed', { token: st })).error, 'FORBIDDEN');
    assert.strictEqual((await t.call('GET', '/svc/price-feed', { headers: { 'X-Store-Key': 'wrong', 'X-Store-Code': 'C01' } })).status, 401);
  } finally { await t.close(); }
  const t2 = await startApp({ cfg: { STORE_SVC_KEY: KEY } });
  try { assert.strictEqual((await t2.call('GET', '/svc/price-feed', { headers: sk('C01') })).error, 'FORBIDDEN'); } finally { await t2.close(); }
});

test('遷移 v13：依入帳先後回填既有已入帳單；重開不重複；epoch 固定、resetEpoch 會換', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-feed-mig-'));
  try {
    let db = openDb(dir);
    db.prepare("INSERT OR IGNORE INTO brands (id, name) VALUES ('C','央廚')").run();
    db.prepare("INSERT INTO stores (brand_id, code, name, pass_hash) VALUES ('C','X1','測試店','x')").run();
    const sid = db.prepare("SELECT id FROM stores WHERE code='X1'").get().id;
    const ins = db.prepare("INSERT INTO slips (id, client_id, store_id, brand_id, status, doc_date, total, uploaded_at, confirmed_at) VALUES (?,?,?,?,?,?,?,?,?)");
    ins.run('B', 'cb', sid, 'C', 'confirmed', '2026-10-02', 100, 'u', '2026-11-05T02:00:00Z');
    ins.run('A', 'ca', sid, 'C', 'confirmed', '2026-10-05', 100, 'u', '2026-11-05T01:00:00Z');
    ins.run('R', 'cr', sid, 'C', 'review', '2026-10-06', 100, 'u', null);
    db.prepare("INSERT INTO slip_lines (slip_id, seq, raw_name, qty, unit, unit_price, amount) VALUES ('A',1,'某品',1,'包',100,100)").run();
    // 模擬 v12 的舊庫：拿掉 v13 的表、版本退回 12
    db.exec('DROP TABLE price_feed; DROP TABLE settings; PRAGMA user_version = 12;');
    db.close();
    db = openDb(dir);
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 13);
    const rows = db.prepare('SELECT slip_id, kind, at FROM price_feed ORDER BY id').all();
    assert.deepStrictEqual(rows.map((r) => r.slip_id), ['A', 'B']);
    assert.strictEqual(rows[0].at, '2026-11-05T01:00:00Z');
    assert.strictEqual(JSON.parse(db.prepare("SELECT payload FROM price_feed WHERE slip_id='A'").get().payload).lines.length, 1);
    const ep = feed.epochOf(db);
    db.close();
    db = openDb(dir);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM price_feed').get().c, 2);
    assert.strictEqual(feed.epochOf(db), ep);
    assert.notStrictEqual(feed.resetEpoch(db), ep);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
