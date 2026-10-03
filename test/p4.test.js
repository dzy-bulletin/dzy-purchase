'use strict';
// P4：會計多品牌（user_brands、session 目前品牌、POST /session/brand）、門市代號放寬（全部測試資料虛構）
const test = require('node:test');
const assert = require('node:assert');
const { startApp, PASS } = require('./helpers');

async function mkMulti(t) {
  const admin = await t.login('admin', PASS.SEED_PASS_ADMIN);
  const r = await t.call('POST', '/admin/users', { token: admin, body: { username: 'acc-cx', name: '多品牌會計（測試）', role: 'accountant', brand_ids: ['C', 'X'], brand_id: 'C', password: 'pw-acccx' } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { admin, id: r.data.id, row: r.data };
}

test('P4 admin 建立多品牌會計：brand_ids 存 user_brands、預設品牌在清單內；舊的只給 brand_id 仍可用', async () => {
  const t = await startApp();
  try {
    const { row, admin } = await mkMulti(t);
    assert.deepStrictEqual(row.brand_ids, ['C', 'X']); assert.strictEqual(row.brand_id, 'C');
    const old = await t.call('POST', '/admin/users', { token: admin, body: { username: 'acc-old', name: 'x', role: 'accountant', brand_id: 'M', password: 'pw-accold' } });
    assert.deepStrictEqual(old.data.brand_ids, ['M']);
    // 預設品牌不在清單 → 改成清單第一個；空清單／不存在品牌 → BAD_INPUT
    const r2 = await t.call('POST', '/admin/users', { token: admin, body: { username: 'acc-two', name: 'x', role: 'accountant', brand_ids: ['X', 'M'], brand_id: 'C', password: 'pw-acctwo' } });
    assert.strictEqual(r2.data.brand_id, 'X');
    assert.strictEqual((await t.call('POST', '/admin/users', { token: admin, body: { username: 'acc-bad', name: 'x', role: 'accountant', brand_ids: [], password: 'pw-accbad' } })).error, 'BAD_INPUT');
    assert.strictEqual((await t.call('POST', '/admin/users', { token: admin, body: { username: 'acc-bad', name: 'x', role: 'accountant', brand_ids: ['Z'], password: 'pw-accbad' } })).error, 'BAD_INPUT');
    // 改成 admin → 清掉 user_brands；PUT 只給 brand_ids 可增減
    const up = await t.call('PUT', `/admin/users/${row.id}`, { token: admin, body: { brand_ids: ['C', 'M', 'X'] } });
    assert.deepStrictEqual(up.data.brand_ids, ['C', 'M', 'X']);
    const up2 = await t.call('PUT', `/admin/users/${row.id}`, { token: admin, body: { brand_ids: ['M'] } });
    assert.deepStrictEqual(up2.data.brand_ids, ['M']); assert.strictEqual(up2.data.brand_id, 'M');
  } finally { await t.close(); }
});

test('P4 A 會計（C+X）：登入帶 brands；預設 C；切 X 看 X 資料、切回 C 看 C；切 M 回 403；切換不影響他人', async () => {
  const t = await startApp();
  try {
    await mkMulti(t);
    const lg = await t.call('POST', '/login', { body: { account: 'acc-cx', password: 'pw-acccx' } });
    assert.strictEqual(lg.ok, true);
    assert.deepStrictEqual(lg.data.brands.map((b) => b.id), ['C', 'X']); assert.strictEqual(lg.data.brand_id, 'C');
    assert.strictEqual(lg.data.brands[0].name, '央廚');
    const tk = lg.data.token;
    const brandsOf = async () => [...new Set((await t.call('GET', '/vendors', { token: tk })).data.map((v) => 'brand_id' in v ? v.brand_id : '?'))];
    // 本品牌的廠商：用管理員在 C、X 各加一個不同名廠商，看目前品牌過濾
    const admin = await t.login('admin', PASS.SEED_PASS_ADMIN);
    await t.call('POST', '/vendors', { token: admin, body: { name: '只在央廚的廠商', brand_id: 'C' } });
    await t.call('POST', '/vendors', { token: admin, body: { name: '只在小辛辣的廠商', brand_id: 'X' } });
    const names = async () => (await t.call('GET', '/vendors?all=1', { token: tk })).data;
    let v = await names();
    assert.ok(v.some((x) => x.name === '只在央廚的廠商') && !v.some((x) => x.name === '只在小辛辣的廠商') && v.every((x) => x.brand_id === 'C'));
    // 會計操作另一品牌的資料（沒切過去）→ 403
    assert.strictEqual((await t.call('GET', '/vendors?brand_id=X', { token: tk })).error, 'FORBIDDEN');
    let sw = await t.call('POST', '/session/brand', { token: tk, body: { brand_id: 'X' } });
    assert.strictEqual(sw.ok, true); assert.strictEqual(sw.data.brand_id, 'X');
    v = await names();
    assert.ok(v.some((x) => x.name === '只在小辛辣的廠商') && !v.some((x) => x.name === '只在央廚的廠商') && v.every((x) => x.brand_id === 'X'));
    assert.deepStrictEqual((await t.call('GET', '/stores', { token: tk })).data.map((s) => s.brand_id), ['X']);
    const add = await t.call('POST', '/vendors', { token: tk, body: { name: '切到X後新增' } });
    assert.strictEqual(add.data.brand_id, 'X');
    // 切 M：不在 user_brands → 403，目前品牌不變
    sw = await t.call('POST', '/session/brand', { token: tk, body: { brand_id: 'M' } });
    assert.strictEqual(sw.status, 403); assert.strictEqual(sw.error, 'FORBIDDEN');
    assert.strictEqual((await t.call('POST', '/session/brand', { token: tk, body: { brand_id: 'ZZ' } })).status, 403);
    assert.strictEqual((await t.call('POST', '/session/brand', { token: tk, body: {} })).status, 403);
    assert.ok((await names()).every((x) => x.brand_id === 'X'));
    // 另一個 session 不受影響（預設 C）；切回 C 看 C
    const tk2 = (await t.call('POST', '/login', { body: { account: 'acc-cx', password: 'pw-acccx' } })).data.token;
    assert.ok((await t.call('GET', '/vendors?all=1', { token: tk2 })).data.every((x) => x.brand_id === 'C'));
    assert.strictEqual((await t.call('POST', '/session/brand', { token: tk, body: { brand_id: 'C' } })).ok, true);
    assert.ok((await names()).every((x) => x.brand_id === 'C'));
    // 貨單隔離：C 的貨單在 X 品牌下看不到
    const cstore = t.app.db.prepare("SELECT id FROM stores WHERE code='C01'").get().id;
    t.app.db.prepare("INSERT INTO slips (id, client_id, store_id, brand_id, status, uploaded_at, flags) VALUES ('S20261004-0001','11111111-1111-4111-8111-111111111111',?,'C','review','2026-10-04T01:00:00Z','[]')").run(cstore);
    assert.strictEqual((await t.call('GET', '/review', { token: tk })).data.length, 1);
    assert.strictEqual((await t.call('GET', '/slips/S20261004-0001', { token: tk })).ok, true);
    await t.call('POST', '/session/brand', { token: tk, body: { brand_id: 'X' } });
    assert.strictEqual((await t.call('GET', '/review', { token: tk })).data.length, 0);
    assert.strictEqual((await t.call('GET', '/slips/S20261004-0001', { token: tk })).status, 403);
  } finally { await t.close(); }
});

test('P4 單品牌會計 brands 只有一個；門市／admin 不能切換；admin 收回品牌後 session 自動退回仍有權的品牌', async () => {
  const t = await startApp();
  try {
    const single = await t.call('POST', '/login', { body: { account: 'acc-x', password: PASS.SEED_PASS_ACC_X } });
    assert.deepStrictEqual(single.data.brands.map((b) => b.id), ['X']);
    assert.strictEqual((await t.call('POST', '/session/brand', { token: single.data.token, body: { brand_id: 'X' } })).ok, true);
    assert.strictEqual((await t.call('POST', '/session/brand', { token: single.data.token, body: { brand_id: 'C' } })).status, 403);
    const st = await t.login('X01', PASS.SEED_PASS_X01);
    assert.strictEqual((await t.call('POST', '/session/brand', { token: st, body: { brand_id: 'X' } })).status, 403);
    const admin = await t.login('admin', PASS.SEED_PASS_ADMIN);
    assert.strictEqual((await t.call('POST', '/session/brand', { token: admin, body: { brand_id: 'X' } })).status, 403);
    assert.strictEqual((await t.call('POST', '/session/brand', {})).status, 401);
    const { id } = await mkMulti(t);
    const tk = (await t.call('POST', '/login', { body: { account: 'acc-cx', password: 'pw-acccx' } })).data.token;
    await t.call('POST', '/session/brand', { token: tk, body: { brand_id: 'X' } });
    await t.call('PUT', `/admin/users/${id}`, { token: admin, body: { brand_ids: ['C'] } });
    assert.ok((await t.call('GET', '/vendors?all=1', { token: tk })).data.every((x) => x.brand_id === 'C'), '被收回 X 後不能再看 X');
    assert.strictEqual((await t.call('POST', '/session/brand', { token: tk, body: { brand_id: 'X' } })).status, 403);
  } finally { await t.close(); }
});

test('P4 門市代號：實際代號登入、帳號名稱不可與門市代號相同、門市代號不可與帳號相同', async () => {
  const t = await startApp();
  try {
    const admin = await t.login('admin', PASS.SEED_PASS_ADMIN);
    for (const [code, brand] of [['CF', 'C'], ['MDGF', 'X'], ['MZTGF', 'M'], ['MZTZS', 'M'], ['MZTLZL', 'M']]) {
      const r = await t.call('POST', '/admin/stores', { token: admin, body: { code, name: `${code}（測試）`, brand_id: brand, password: 'pw-store1' } });
      assert.strictEqual(r.ok, true, code);
      const lg = await t.call('POST', '/login', { body: { account: code, password: 'pw-store1' } });
      assert.strictEqual(lg.data.brand_id, brand); assert.strictEqual(lg.data.store.code, code);
    }
    assert.strictEqual((await t.call('POST', '/admin/users', { token: admin, body: { username: 'mdgf', name: 'x', role: 'accountant', brand_id: 'X', password: 'pw-accxx' } })).error, 'BAD_INPUT');
    assert.strictEqual((await t.call('POST', '/admin/stores', { token: admin, body: { code: 'ADMIN', name: 'x', brand_id: 'X', password: 'pw-store1' } })).error, 'CONFLICT');
    assert.ok(await t.login('admin', PASS.SEED_PASS_ADMIN), 'admin 帳號仍可登入（長得像門市代號但不是門市）');
  } finally { await t.close(); }
});

// 前端 config.js：本機預設 8794、佈署佔位字串、?api= 只在本機生效（用 vm 在假 location 下執行）
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'config.js'), 'utf8');
function cfgFor(hostname, search, src) {
  const ctx = { location: { hostname, search }, URLSearchParams };
  vm.createContext(ctx); vm.runInContext(src || CONFIG_SRC, ctx); return vm.runInContext('CFG', ctx);
}
test('P4 前端 config.js：本機預設 localhost:8794；正式網址佔位字串未換＝UNCONFIGURED；換成 Funnel 網址後生效；?api= 只在本機', () => {
  assert.strictEqual(cfgFor('localhost', '').API_BASE, 'http://localhost:8794/purchase/api');
  assert.strictEqual(cfgFor('127.0.0.1', '').API_BASE, 'http://localhost:8794/purchase/api');
  const raw = cfgFor('dzy-bulletin.github.io', '');
  assert.strictEqual(raw.UNCONFIGURED, true); assert.strictEqual(raw.API_BASE, '');
  assert.strictEqual((CONFIG_SRC.match(/__FUNNEL__/g) || []).length, 1, '佔位字串只在 DEPLOY_BASE 那一行出現一次（註解不得出現，免得取代時被改到）');
  const deployed = CONFIG_SRC.replace("var DEPLOY_BASE = '__FUNNEL__", "var DEPLOY_BASE = 'https://example-host.ts.net");   // DEPLOY.md 第 9 步的 sed 取代（同一個樣式）
  assert.ok(!/__FUNNEL__/.test(deployed), '取代後不剩佔位字串');
  const ok = cfgFor('dzy-bulletin.github.io', '', deployed);
  assert.strictEqual(ok.UNCONFIGURED, false); assert.strictEqual(ok.API_BASE, 'https://example-host.ts.net/purchase/api');
  // ?api= 只收本機位址，而且只在本機開頁時
  assert.strictEqual(cfgFor('localhost', '?api=http://localhost:9999/purchase/api').API_BASE, 'http://localhost:9999/purchase/api');
  assert.strictEqual(cfgFor('dzy-bulletin.github.io', '?api=http://localhost:9999/purchase/api', deployed).API_BASE, 'https://example-host.ts.net/purchase/api');
  assert.strictEqual(cfgFor('localhost', '?api=https://evil.example/purchase/api').API_BASE, 'http://localhost:8794/purchase/api');
});
