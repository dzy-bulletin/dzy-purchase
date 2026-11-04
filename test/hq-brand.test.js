'use strict';
// v12：第四個品牌 H 總部（2026-11-04）。遷移可重跑、不動既有品牌；管理者可把門市開在總部品牌底下。
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, MIGRATIONS } = require('../server/db');
const { startApp, PASS } = require('./helpers');

test('全新資料庫自帶 H 總部；既有 v11 資料庫升級後補上 H、其他品牌不變', () => {
  const fresh = openDb(':memory:');
  assert.deepStrictEqual({ ...fresh.prepare("SELECT id, name FROM brands WHERE id = 'H'").get() }, { id: 'H', name: '總部' });
  fresh.close();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-'));
  const raw = new DatabaseSync(path.join(dir, 'purchase.db'));
  MIGRATIONS.slice(0, 11).forEach((m, i) => { raw.exec(m); raw.exec(`PRAGMA user_version = ${i + 1}`); });
  raw.exec("INSERT INTO brands (id, name) VALUES ('X','小辛辣'), ('M','墨竹亭'), ('C','央廚'); INSERT INTO stores (brand_id, code, name, pass_hash) VALUES ('C','CF','中央廚房','x');");
  raw.close();
  const db = openDb(dir);
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.deepStrictEqual(db.prepare('SELECT id, name FROM brands ORDER BY id').all().map((r) => r.id + r.name), ['C央廚', 'H總部', 'M墨竹亭', 'X小辛辣']);
  assert.strictEqual(db.prepare("SELECT brand_id FROM stores WHERE code = 'CF'").get().brand_id, 'C');
  db.close();
  const again = openDb(dir);                                         // 重開：不重跑、不重複
  assert.strictEqual(again.prepare("SELECT COUNT(*) c FROM brands WHERE id = 'H'").get().c, 1);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('已先手動加過 H（名稱不同）：遷移不覆蓋', () => {
  const raw = new DatabaseSync(':memory:');
  MIGRATIONS.slice(0, 11).forEach((m) => raw.exec(m));
  raw.exec("INSERT INTO brands (id, name) VALUES ('H', '鼎兆元總部')");
  raw.exec(MIGRATIONS[11]);
  raw.exec(MIGRATIONS[11]);                                          // 重跑也沒事
  assert.deepStrictEqual(raw.prepare("SELECT id, name FROM brands WHERE id = 'H'").all().map((r) => r.name), ['鼎兆元總部']);
  raw.close();
});

test('管理者在 H 品牌新增鼎兆元總部（帶損益代號），會計需被指派 H 才看得到', async () => {
  const t = await startApp();
  try {
    const admin = await t.login('admin', PASS.SEED_PASS_ADMIN);
    const r = await t.call('POST', '/admin/stores', { token: admin, body: { code: 'DZYHQ', name: '鼎兆元總部', brand_id: 'H', pnl_unit_code: 'S10', password: 'abc123', active: 1 } });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.brand_id, 'H'); assert.strictEqual(r.data.pnl_unit_code, 'S10');
    const accC = await t.login('acc-c', PASS.SEED_PASS_ACC_C);       // 央廚會計：看不到總部門市
    assert.strictEqual((await t.call('POST', '/session/brand', { token: accC, body: { brand_id: 'H' } })).error, 'FORBIDDEN');
    const sts = await t.call('GET', '/stores', { token: accC });
    assert.ok(sts.ok && !sts.data.some((s) => s.code === 'DZYHQ'));
    const li = await t.call('POST', '/login', { body: { account: 'DZYHQ', password: 'abc123' } });   // 門市登入後品牌＝H（首次要改密碼）
    assert.strictEqual(li.ok, true); assert.strictEqual(li.data.brand_id, 'H'); assert.strictEqual(li.data.must_change_password, true);
  } finally { await t.close(); }
});
