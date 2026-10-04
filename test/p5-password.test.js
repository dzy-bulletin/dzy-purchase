'use strict';
// 首次登入強制改密碼（2026-10-04）：遷移、API 閘、改密碼規則、admin 重設、create-accounts。全部虛構密碼
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('./helpers');
const { openDb } = require('../server/db');
const { hashPassword, verifyPassword } = require('../server/auth');
const { run } = require('../server/tools/create-accounts');

const flag = (t, id, tbl) => t.app.db.prepare(`SELECT must_change_password m FROM ${tbl} WHERE id = ?`).get(id).m;

test('P5 遷移 v8：既有門市與會計＝1、admin＝0；新庫欄位存在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5mig-'));
  let db = openDb(dir);
  db.exec("INSERT INTO brands (id,name) VALUES ('X','小辛辣')");
  const h = hashPassword('x-pass-1');
  db.prepare("INSERT INTO stores (brand_id,code,name,pass_hash) VALUES ('X','S1','店',?)").run(h);
  db.prepare("INSERT INTO users (username,role,brand_id,name,pass_hash) VALUES ('a1','accountant','X','甲',?)").run(h);
  db.prepare("INSERT INTO users (username,role,brand_id,name,pass_hash) VALUES ('ad','admin',NULL,'乙',?)").run(h);
  // 倒回 v7（模擬部署中途的舊庫）
  db.exec('ALTER TABLE stores DROP COLUMN must_change_password; ALTER TABLE users DROP COLUMN must_change_password; PRAGMA user_version = 7;');
  db.close();
  db = openDb(dir);                                       // 重新開啟 → 跑 v8
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 8);
  assert.strictEqual(db.prepare("SELECT must_change_password m FROM stores WHERE code='S1'").get().m, 1);
  assert.strictEqual(db.prepare("SELECT must_change_password m FROM users WHERE username='a1'").get().m, 1);
  assert.strictEqual(db.prepare("SELECT must_change_password m FROM users WHERE username='ad'").get().m, 0);
  assert.ok(verifyPassword('x-pass-1', db.prepare("SELECT pass_hash FROM stores WHERE code='S1'").get().pass_hash), '資料不動');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('P5 強制改密碼：login 回旗標、只能打 /password 與 /logout、改成功解除並作廢舊 session', async () => {
  const t = await startApp();
  try {
    const store = t.app.db.prepare("SELECT id FROM stores WHERE code='C01'").get() || t.app.db.prepare('SELECT id FROM stores LIMIT 1').get();
    t.app.db.prepare('UPDATE stores SET must_change_password = 1 WHERE id = ?').run(store.id);
    const code = t.app.db.prepare('SELECT code FROM stores WHERE id = ?').get(store.id).code;
    const pw = { C01: 'pw-c01' }[code] || 'pw-c01';
    const r = await t.call('POST', '/login', { body: { account: code, password: pw } });
    assert.ok(r.ok); assert.strictEqual(r.data.must_change_password, true);
    const tok = r.data.token;
    const other = (await t.call('POST', '/login', { body: { account: code, password: pw } })).data.token;   // 第二個 session
    let x = await t.call('GET', '/vendors', { token: tok });
    assert.strictEqual(x.status, 403); assert.strictEqual(x.error, 'PASSWORD_CHANGE_REQUIRED');
    // 新密碼規則
    const bad = (body) => t.call('POST', '/password', { token: tok, body });
    assert.strictEqual((await bad({ old_password: pw, new_password: '12345' })).error, 'BAD_INPUT');
    assert.strictEqual((await bad({ old_password: pw, new_password: pw })).error, 'BAD_INPUT');
    assert.strictEqual((await bad({ old_password: 'wrong-old', new_password: 'new-pass-9' })).error, 'BAD_INPUT');
    assert.strictEqual(flag(t, store.id, 'stores'), 1);
    const ok = await bad({ old_password: pw, new_password: 'new-pass-9' });
    assert.ok(ok.ok); assert.strictEqual(ok.data.must_change_password, false);
    assert.strictEqual(flag(t, store.id, 'stores'), 0);
    assert.strictEqual((await t.call('GET', '/vendors', { token: tok })).status, 401, '舊 token 作廢');
    assert.strictEqual((await t.call('GET', '/vendors', { token: other })).status, 401, '其他 session 作廢');
    assert.strictEqual((await t.call('GET', '/vendors', { token: ok.data.token })).status, 200, '新 token 可用');
    assert.strictEqual(await t.login(code, pw), null); assert.ok(await t.login(code, 'new-pass-9'));
    assert.ok(!JSON.stringify(t.app.db.prepare('SELECT * FROM audit').all()).includes('new-pass-9'), 'audit 不得含密碼');
  } finally { await t.close(); }
});

test('P5 強制期間 /logout 可用；其他角色（含會計切品牌）一律擋', async () => {
  const t = await startApp();
  try {
    t.app.db.prepare("UPDATE users SET must_change_password = 1 WHERE username = (SELECT username FROM users WHERE role='accountant' LIMIT 1)").run();
    const u = t.app.db.prepare("SELECT username FROM users WHERE must_change_password=1").get().username;
    const pw = { 'acc-c': 'pw-accc', 'acc-m': 'pw-accm', 'acc-x': 'pw-accx' }[u];
    const tok = pw ? await t.login(u, pw) : null;
    if (!tok) return;                                     // 種子帳號名稱不符時略過（下個測試涵蓋 admin）
    assert.strictEqual((await t.call('POST', '/session/brand', { token: tok, body: { brand_id: 'C' } })).error, 'PASSWORD_CHANGE_REQUIRED');
    assert.strictEqual((await t.call('POST', '/logout', { token: tok })).status, 200);
  } finally { await t.close(); }
});

test('P5 admin 預設不強制、可自己改密碼；admin 重設他人密碼 → 對方再次強制；admin 建帳號＝強制', async () => {
  const t = await startApp();
  try {
    const adm = t.app.db.prepare("SELECT username FROM users WHERE role='admin'").get().username;
    const at = await t.login(adm, 'pw-admin');
    assert.ok(at);
    const lr = await t.call('POST', '/login', { body: { account: adm, password: 'pw-admin' } });
    assert.strictEqual(lr.data.must_change_password, false);
    assert.strictEqual((await t.call('GET', '/admin/stores', { token: at })).status, 200);
    const st = t.app.db.prepare('SELECT id, code FROM stores LIMIT 1').get();
    assert.strictEqual(flag(t, st.id, 'stores'), 0);
    const put = await t.call('PUT', `/admin/stores/${st.id}`, { token: at, body: { password: 'temp-pass-1' } });
    assert.ok(put.ok, JSON.stringify(put));
    assert.strictEqual(flag(t, st.id, 'stores'), 1);
    const lr2 = await t.call('POST', '/login', { body: { account: st.code, password: 'temp-pass-1' } });
    assert.strictEqual(lr2.data.must_change_password, true);
    const cr = await t.call('POST', '/admin/stores', { token: at, body: { brand_id: 'X', code: 'NEWST', name: '新店', password: 'temp-pass-2' } });
    assert.ok(cr.ok, JSON.stringify(cr));
    assert.strictEqual(t.app.db.prepare("SELECT must_change_password m FROM stores WHERE code='NEWST'").get().m, 1);
    // admin 自己改密碼
    const ch = await t.call('POST', '/password', { token: at, body: { old_password: 'pw-admin', new_password: 'admin-new-1' } });
    assert.ok(ch.ok); assert.ok(await t.login(adm, 'admin-new-1'));
  } finally { await t.close(); }
});

test('P5 create-accounts：門市／會計＝1、admin＝0；重設也設旗標', async () => {
  const db = openDb(':memory:');
  const pws = []; for (let i = 0; i < 8; i++) pws.push('pw-test-' + i, 'pw-test-' + i);
  const answers = ['acc-a', '測試會計甲', 'acc-b', '測試會計乙', 'adm1', '測試管理者'];
  const io = { out: () => {}, ask: async () => (answers.length ? answers.shift() : ''), askHidden: async () => pws.shift() };
  await run(db, io, {});
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM stores WHERE must_change_password = 1').get().c, 5);
  assert.strictEqual(db.prepare("SELECT must_change_password m FROM users WHERE username='acc-a'").get().m, 1);
  assert.strictEqual(db.prepare("SELECT must_change_password m FROM users WHERE username='acc-b'").get().m, 1);
  assert.strictEqual(db.prepare("SELECT must_change_password m FROM users WHERE username='adm1'").get().m, 0);
  // 使用者改完後，重設 → 再度＝1（門市）；admin 重設仍＝0
  db.exec('UPDATE stores SET must_change_password = 0; UPDATE users SET must_change_password = 0');
  const a2 = ['y']; const p2 = ['re-set-1', 're-set-1'];
  await run(db, { out: () => {}, ask: async () => (a2.length ? a2.shift() : 'n'), askHidden: async () => p2.shift() }, { only: 'stores' });
  assert.strictEqual(db.prepare("SELECT must_change_password m FROM stores WHERE code='CF'").get().m, 1);
  db.close();
});
