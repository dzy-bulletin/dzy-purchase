'use strict';
// 門市營運系統通道：服務金鑰（X-Store-Key＋X-Store-Code）與 STORE_LOGIN_OFF。全部虛構金鑰
const test = require('node:test');
const assert = require('node:assert');
const { startApp, PASS } = require('./helpers');

const KEY = 'test-svc-key-0123456789';
const MSG = '門市請改用門市營運系統登入';
const sk = (code, key) => ({ 'X-Store-Key': key === undefined ? KEY : key, 'X-Store-Code': code });

async function svcUpload(t, code, key) {
  // 與 helpers.upload 同形，但走金鑰標頭、不帶 token
  const bd = '----svc' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="client_id"\r\n\r\n${require('./helpers').uuid()}\r\n`),
    Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="vendor_name"\r\n\r\n某廠商\r\n`),
    Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="photos[]"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    require('./helpers').FAKE_JPG, Buffer.from(`\r\n--${bd}--\r\n`)]);
  return t.call('POST', '/slips', { raw: body, headers: Object.assign({ 'Content-Type': `multipart/form-data; boundary=${bd}` }, sk(code, key)) });
}

test('通道關閉（未設 STORE_SVC_KEY 或空字串）：金鑰無效 401', async () => {
  for (const cfg of [{}, { STORE_SVC_KEY: '' }]) {
    const t = await startApp({ cfg });
    try {
      assert.strictEqual((await svcUpload(t, 'C01')).status, 401);
      assert.strictEqual((await t.call('GET', '/slips?mine=1', { headers: sk('C01') })).status, 401);
    } finally { await t.close(); }
  }
});

test('錯金鑰 401；缺 X-Store-Code 401；未知／停用門市代號 401', async () => {
  const t = await startApp({ cfg: { STORE_SVC_KEY: KEY } });
  try {
    assert.strictEqual((await svcUpload(t, 'C01', 'wrong-key')).status, 401);
    assert.strictEqual((await svcUpload(t, 'C01', 'x')).status, 401);
    assert.strictEqual((await t.call('GET', '/slips?mine=1', { headers: { 'X-Store-Key': KEY } })).status, 401);
    assert.strictEqual((await svcUpload(t, 'NOPE')).status, 401);
    t.app.db.prepare("UPDATE stores SET active = 0 WHERE code = 'C01'").run();
    assert.strictEqual((await svcUpload(t, 'C01')).status, 401);
    assert.strictEqual((await t.call('GET', '/slips?mine=1', { headers: sk('C01') })).status, 401);
  } finally { await t.close(); }
});

test('正確金鑰：上傳成功、store_id 正確；查 mine=1 只看到自己門市', async () => {
  const t = await startApp({ cfg: { STORE_SVC_KEY: KEY } });
  try {
    const r = await svcUpload(t, 'c01');                 // 代號不分大小寫
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const c01 = t.app.db.prepare("SELECT id FROM stores WHERE code='C01'").get().id;
    const row = t.app.db.prepare('SELECT store_id FROM slips ORDER BY rowid DESC LIMIT 1').get();
    assert.strictEqual(row.store_id, c01);
    const list = await t.call('GET', '/slips?mine=1', { headers: sk('C01') });
    assert.strictEqual(list.status, 200);
    assert.ok(JSON.stringify(list.data).length > 5);
    const other = await t.call('GET', '/slips?mine=1', { headers: sk('M01') });
    assert.strictEqual(other.status, 200);
    assert.ok(!JSON.stringify(other.data).includes(r.data.id || '\u0000none'));
    // 不帶 mine=1 不在放行範圍 → 403
    assert.strictEqual((await t.call('GET', '/slips', { headers: sk('C01') })).status, 403);
  } finally { await t.close(); }
});

test('正確金鑰打其他路由一律 403（含會計路由、門市原本能用的路由、登出）', async () => {
  const t = await startApp({ cfg: { STORE_SVC_KEY: KEY } });
  try {
    for (const [m, p] of [['GET', '/review'], ['GET', '/vendors'], ['GET', '/slips/abc'], ['PUT', '/slips/abc'], ['POST', '/slips/abc/confirm'], ['POST', '/password'], ['POST', '/logout'], ['GET', '/photos/abc/1']]) {
      const r = await t.call(m, p, { headers: sk('C01'), body: m === 'GET' ? undefined : {} });
      assert.strictEqual(r.status, 403, `${m} ${p} → ${r.status}`);
      assert.strictEqual(r.error, 'FORBIDDEN');
    }
    // 錯金鑰打其他路由是 401（先驗金鑰）
    assert.strictEqual((await t.call('GET', '/review', { headers: sk('C01', 'bad') })).status, 401);
  } finally { await t.close(); }
});

test('STORE_LOGIN_OFF=1：門市登入 403＋訊息；會計／admin 登入正常；舊門市 session 失效', async () => {
  const t = await startApp({});
  try {
    const old = await t.login('C01', PASS.SEED_PASS_C01);
    assert.ok(old);
    assert.strictEqual((await t.call('GET', '/slips?mine=1', { token: old })).status, 200);
    t.app.cfg.STORE_LOGIN_OFF = true;
    const r = await t.call('POST', '/login', { body: { account: 'C01', password: PASS.SEED_PASS_C01 } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.message, MSG);
    const r2 = await t.call('POST', '/login', { body: { account: 'c01', password: 'wrong' } });
    assert.strictEqual(r2.status, 403);
    const old2 = await t.call('GET', '/slips?mine=1', { token: old });
    assert.ok(old2.status === 401 || old2.status === 403);
    assert.strictEqual(old2.message, MSG);
  } finally { await t.close(); }
});

test('STORE_LOGIN_OFF：會計與管理者登入完全不受影響', async () => {
  const t = await startApp({});
  try {
    const accUser = t.app.db.prepare("SELECT username FROM users WHERE role='accountant' LIMIT 1").get().username;
    const adm = t.app.db.prepare("SELECT username FROM users WHERE role='admin' LIMIT 1").get().username;
    t.app.cfg.STORE_LOGIN_OFF = true;
    const accTok = await t.login(accUser, PASS.SEED_PASS_ACC_C) || await t.login(accUser, PASS.SEED_PASS_ACC_M) || await t.login(accUser, PASS.SEED_PASS_ACC_X);
    assert.ok(accTok, '會計登入應成功');
    assert.strictEqual((await t.call('GET', '/review', { token: accTok })).status, 200);
    assert.ok(await t.login(adm, PASS.SEED_PASS_ADMIN), '管理者登入應成功');
  } finally { await t.close(); }
});

test('STORE_LOGIN_OFF 未設：門市登入與 session 照舊；金鑰通道不受 LOGIN_OFF 影響', async () => {
  const t = await startApp({ cfg: { STORE_SVC_KEY: KEY } });
  try {
    const tok = await t.login('C01', PASS.SEED_PASS_C01);
    assert.ok(tok);
    assert.strictEqual((await t.call('GET', '/slips?mine=1', { token: tok })).status, 200);
    t.app.cfg.STORE_LOGIN_OFF = true;
    assert.strictEqual((await t.call('GET', '/slips?mine=1', { headers: sk('C01') })).status, 200);
  } finally { await t.close(); }
});

test('config：STORE_LOGIN_OFF 只有 "1" 才開；STORE_SVC_KEY 讀環境變數', () => {
  const { loadConfig } = require('../server/config');
  assert.strictEqual(loadConfig({ PURCHASE_NO_DOTENV: '1' }).STORE_LOGIN_OFF, false);
  assert.strictEqual(loadConfig({ STORE_LOGIN_OFF: '0' }).STORE_LOGIN_OFF, false);
  assert.strictEqual(loadConfig({ STORE_LOGIN_OFF: '1' }).STORE_LOGIN_OFF, true);
  assert.strictEqual(loadConfig({}).STORE_SVC_KEY, '');
  assert.strictEqual(loadConfig({ STORE_SVC_KEY: 'k' }).STORE_SVC_KEY, 'k');
});
