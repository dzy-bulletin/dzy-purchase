'use strict';
// 會計從鼎兆元管理系統嵌入（dzy docs/purchase-fin/spec.md §4）：平台客戶端解析、/sso、/sso/counts、嵌入 session 重查、ACCT_LOGIN_UNTIL、dzy_sub。
// 假平台＝本檔的 node http server；身分、編號、姓名全是虛構。
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { startApp, PASS } = require('./helpers');
const { loadConfig } = require('../server/config');
const { clientIp } = require('../server/sso');
const D = require('../server/dzy');

const SVC = 'fake-svc-for-tests';
const tk = () => crypto.randomBytes(32).toString('hex');

// 假平台：tickets（一次性）→ sub；idents[sub] → 身分；down＝回 HTTP 502
async function fakePlatform() {
  const st = { tickets: new Map(), idents: {}, down: false, calls: [] };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (st.down) { res.writeHead(502); return res.end('bad gateway'); }
      st.calls.push({ raw: true });
      if (st.garbage === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><p>maintenance</p>'); }
      if (st.garbage === 'biz') return send({ ok: false, error: '輸入不正確', code: 'bad_input' });
      if (st.garbage === 'shape') return send({ ok: true, data: { sub: 'DZY904', active: true } });
      let j; try { j = JSON.parse(b); } catch (e) { return send({ ok: false, code: 'bad_input' }); }
      st.calls.push({ action: j.action, ctype: req.headers['content-type'], payload: j.payload });
      const p = j.payload || {};
      if (p.svc_key !== SVC) return send({ ok: false, code: 'unauthorized' });
      const ident = (sub) => st.idents[sub] || { sub, active: false };
      if (j.action === 'svcPurchaseRedeem') {
        if (p.aud !== 'purchase') return send({ ok: false, code: 'bad_aud' });
        const sub = st.tickets.get(p.ticket);
        if (!sub) return send({ ok: false, code: 'ticket_invalid' });
        st.tickets.delete(p.ticket);
        return send({ ok: true, data: ident(sub) });
      }
      if (j.action === 'svcPurchaseWho') return send({ ok: true, data: ident(p.sub) });
      return send({ ok: false, code: 'bad_input' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  st.url = `http://127.0.0.1:${srv.address().port}/api`;
  st.ticket = (sub) => { const t = tk(); st.tickets.set(t, sub); return t; };
  st.person = (sub, o) => { st.idents[sub] = Object.assign({ sub, active: true, allowed: true, name: '測試同仁' + sub.slice(-3), emp_no: /^DZY/.test(sub) ? sub : '', token_after: 0 }, o || {}); };
  st.close = () => new Promise((r) => srv.close(r));
  return st;
}

async function setup(extraCfg) {
  const fp = await fakePlatform();
  let t = Date.parse('2026-11-02T02:00:00Z');
  const clock = { now: () => new Date(t), add: (ms) => { t += ms; } };
  const ctx = await startApp({ cfg: Object.assign({ DZY_PLATFORM_URL: fp.url, DZY_PURCHASE_SVC_KEY: SVC }, extraCfg || {}), now: clock.now });
  const admin = await ctx.login('admin', PASS.SEED_PASS_ADMIN);
  const users = async () => (await ctx.call('GET', '/admin/users', { token: admin })).data;
  const uid = async (username) => (await users()).find((u) => u.username === username).id;
  const done = async () => { await ctx.close(); await fp.close(); };
  return Object.assign(ctx, { fp, clock, admin, users, uid, done });
}

// ---------- 客戶端解析 ----------
test('dzy 客戶端：parseIdent 只收契約形狀', () => {
  assert.deepStrictEqual(D.parseIdent({ sub: 'DZY001', active: false, extra: 1 }), { sub: 'DZY001', active: false });
  assert.deepStrictEqual(D.parseIdent({ sub: 'U:abc_1', active: true, allowed: false, name: ' 測試甲 ', emp_no: '', token_after: 5, x: 1 }),
    { sub: 'U:abc_1', active: true, allowed: false, name: '測試甲', emp_no: '', token_after: 5 });
  for (const bad of [null, [], { sub: 'X1', active: false }, { sub: 'DZY1', active: false }, { sub: 'DZY001', active: 'yes' },
    { sub: 'DZY001', active: true, name: '甲', emp_no: 'DZY001', token_after: 0 },                               // 少 allowed
    { sub: 'DZY001', active: true, allowed: true, name: '', emp_no: 'DZY001', token_after: 0 },
    { sub: 'DZY001', active: true, allowed: true, name: '甲', emp_no: 'A1', token_after: 0 },
    { sub: 'DZY001', active: true, allowed: true, name: '甲', emp_no: 'DZY001', token_after: -1 },
    { sub: 'DZY001', active: true, allowed: true, name: '甲', emp_no: 'DZY001', token_after: 1.5 }]) assert.strictEqual(D.parseIdent(bad), null, JSON.stringify(bad));
});

test('dzy 客戶端：外層格式、型別化結果（ok／denied／inactive／unreachable／rejected）', async () => {
  const seen = [];
  let reply = null;
  const fetch = async (url, o) => { seen.push({ url, o }); return reply(); };
  const ok = (data) => () => ({ status: 200, text: async () => JSON.stringify(data) });
  const c = D.create({ DZY_PLATFORM_URL: 'http://127.0.0.1:9/api', DZY_PURCHASE_SVC_KEY: 'k-test' }, { fetch, log: () => {} });
  assert.ok(c.enabled());
  assert.ok(!D.create({ DZY_PLATFORM_URL: 'http://x' }).enabled());
  const t = tk();
  reply = ok({ ok: true, data: { sub: 'DZY901', active: true, allowed: true, name: '測試甲', emp_no: 'DZY901', token_after: 3 } });
  let r = await c.redeem(t);
  assert.strictEqual(r.kind, 'ok'); assert.strictEqual(r.ident.token_after, 3);
  assert.strictEqual(seen[0].o.method, 'POST');
  assert.match(seen[0].o.headers['Content-Type'], /^text\/plain/);
  assert.deepStrictEqual(JSON.parse(seen[0].o.body), { action: 'svcPurchaseRedeem', payload: { svc_key: 'k-test', ticket: t, aud: 'purchase' } });
  reply = ok({ ok: true, data: { sub: 'DZY901', active: true, allowed: false, name: '測試甲', emp_no: 'DZY901', token_after: 3 } });
  assert.strictEqual((await c.who('DZY901')).kind, 'denied');
  assert.deepStrictEqual(JSON.parse(seen[1].o.body), { action: 'svcPurchaseWho', payload: { svc_key: 'k-test', sub: 'DZY901' } });
  reply = ok({ ok: true, data: { sub: 'DZY901', active: false } });
  assert.strictEqual((await c.who('DZY901')).kind, 'inactive');
  reply = ok({ ok: true, data: { sub: 'DZY902', active: false } });
  assert.deepStrictEqual(await c.who('DZY901'), { kind: 'rejected', error: 'SUB_MISMATCH' });
  for (const code of ['busy', 'internal', 'INTERNAL', 'something_new']) { reply = ok({ ok: false, code }); assert.strictEqual((await c.who('DZY901')).kind, 'unreachable', code); }
  for (const code of ['unauthorized', 'ticket_invalid', 'bad_aud', 'no_perm', 'bad_input']) { reply = ok({ ok: false, error: code }); assert.deepStrictEqual(await c.redeem(t), { kind: 'rejected', error: code }); }
  reply = () => ({ status: 500, text: async () => '' });
  assert.strictEqual((await c.redeem(t)).kind, 'unreachable');
  reply = () => { throw new Error('ECONNREFUSED'); };
  assert.strictEqual((await c.redeem(t)).kind, 'unreachable');
  reply = () => ({ status: 200, text: async () => 'not json' });
  assert.deepStrictEqual(await c.redeem(t), { kind: 'rejected', error: 'BAD_JSON' });
  reply = ok({ ok: true, data: { sub: 'DZY901', active: true } });
  assert.deepStrictEqual(await c.redeem(t), { kind: 'rejected', error: 'BAD_SCHEMA' });
  const n = seen.length;
  assert.deepStrictEqual(await c.redeem('XYZ'), { kind: 'rejected', error: 'ticket_invalid' });     // 格式不對不送出
  assert.deepStrictEqual(await c.who('bad sub'), { kind: 'rejected', error: 'bad_input' });
  assert.strictEqual(seen.length, n);
});

// ---------- /sso ----------
test('/sso：沒設平台網址或金鑰＝FORBIDDEN', async () => {
  const ctx = await startApp();
  const r = await ctx.call('POST', '/sso', { body: { ticket: tk() } });
  assert.strictEqual(r.status, 403); assert.strictEqual(r.error, 'FORBIDDEN');
  const c = await ctx.call('POST', '/sso/counts', { body: { ticket: tk() } });
  assert.strictEqual(c.status, 403);
  await ctx.close();
});

test('/sso：已綁同仁編號的會計 → 發嵌入 session（形狀同 /login＋embed）；券一次性；嵌入 session 不受首次改密碼限制', async () => {
  const c = await setup();
  const id = await c.uid('acc-x');
  assert.strictEqual((await c.call('PUT', '/admin/users/' + id, { token: c.admin, body: { dzy_sub: 'DZY901' } })).status, 200);
  c.app.db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(id);
  c.fp.person('DZY901', { token_after: 7 });
  const t = c.fp.ticket('DZY901');
  const r = await c.call('POST', '/sso', { body: { ticket: t } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.data.embed, true); assert.strictEqual(r.data.role, 'accountant'); assert.strictEqual(r.data.brand_id, 'X');
  assert.strictEqual(r.data.must_change_password, false); assert.match(r.data.token, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(r.data.brands) && r.data.brands[0].id === 'X');
  const s = c.app.db.prepare('SELECT * FROM sessions WHERE sub = ?').get('DZY901');
  assert.strictEqual(s.token_after, 7); assert.strictEqual(s.who, 'user:' + id);
  assert.strictEqual(Date.parse(s.expires_at) - Date.parse(s.created_at), 12 * 3600e3);
  assert.strictEqual((await c.call('GET', '/review', { token: r.data.token })).status, 200);
  const again = await c.call('POST', '/sso', { body: { ticket: t } });
  assert.strictEqual(again.status, 401); assert.strictEqual(again.error, 'AUTH');
  assert.strictEqual((await c.call('POST', '/sso', { body: {} })).status, 400);
  const au = c.app.db.prepare("SELECT * FROM audit WHERE action = 'sso_login'").all();
  assert.strictEqual(au.length, 1); assert.strictEqual(au[0].who, 'user:' + id);
  assert.strictEqual((await c.call('POST', '/logout', { token: r.data.token })).status, 200);
  assert.strictEqual(c.app.db.prepare('SELECT COUNT(*) n FROM sessions WHERE sub = ?').get('DZY901').n, 0);
  await c.done();
});

test('/sso：沒綁過的人自動建會計帳號（無品牌、不能用密碼登入）；admin 帳號頁看得到', async () => {
  const c = await setup();
  c.fp.person('U:abc-01', { name: '測試主管乙' });
  const r = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('U:abc-01') } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.data.role, 'accountant'); assert.strictEqual(r.data.brand_id, null); assert.deepStrictEqual(r.data.brands, []);
  const u = (await c.users()).find((x) => x.dzy_sub === 'U:abc-01');
  assert.strictEqual(u.username, 'dzy-U-abc-01'); assert.strictEqual(u.name, '測試主管乙'); assert.strictEqual(u.sso_only, 1); assert.deepStrictEqual(u.brand_ids, []);
  assert.strictEqual(c.app.db.prepare('SELECT must_change_password m FROM users WHERE id = ?').get(u.id).m, 0);
  assert.deepStrictEqual((await c.call('GET', '/review', { token: r.data.token })).data, []);      // 沒品牌：API 照舊不給資料
  const pw = await c.call('POST', '/login', { body: { account: 'dzy-U-abc-01', password: '!sso' } });
  assert.strictEqual(pw.status, 401);
  assert.strictEqual(c.app.db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'sso_user_create'").get().n, 1);
  // 第二次進來：同一個帳號，不重建
  const r2 = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('U:abc-01') } });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual((await c.users()).filter((x) => x.dzy_sub === 'U:abc-01').length, 1);
  // admin 指派品牌後就看得到資料
  assert.strictEqual((await c.call('PUT', '/admin/users/' + u.id, { token: c.admin, body: { brand_ids: ['M'] } })).status, 200);
  const r3 = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('U:abc-01') } });
  assert.strictEqual(r3.data.brand_id, 'M');
  await c.done();
});

test('/sso：貨單帳號停用、管理系統停用、沒有貨單核對權限 → FORBIDDEN，既有嵌入 session 刪除', async () => {
  const c = await setup();
  c.fp.person('DZY902');
  const first = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY902') } });
  assert.strictEqual(first.status, 200);
  const count = () => c.app.db.prepare('SELECT COUNT(*) n FROM sessions WHERE sub = ?').get('DZY902').n;
  assert.strictEqual(count(), 1);
  // allowed false
  c.fp.person('DZY902', { allowed: false });
  let r = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY902') } });
  assert.strictEqual(r.status, 403); assert.match(r.message, /貨單核對/); assert.strictEqual(count(), 0);
  // 管理系統停用
  c.fp.person('DZY902');
  assert.strictEqual((await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY902') } })).status, 200);
  c.fp.person('DZY902', { active: false }); c.fp.idents.DZY902 = { sub: 'DZY902', active: false };
  r = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY902') } });
  assert.strictEqual(r.status, 403); assert.strictEqual(count(), 0);
  // 貨單帳號停用
  c.fp.person('DZY902');
  assert.strictEqual((await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY902') } })).status, 200);
  const u = (await c.users()).find((x) => x.dzy_sub === 'DZY902');
  c.app.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
  r = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY902') } });
  assert.strictEqual(r.status, 403); assert.match(r.message, /停用/); assert.strictEqual(count(), 0);
  // 平台連不上 → 503
  c.fp.down = true;
  r = await c.call('POST', '/sso', { body: { ticket: tk() } });
  assert.strictEqual(r.status, 503); assert.strictEqual(r.error, 'UPSTREAM');
  await c.done();
});

// ---------- 重查 ----------
test('嵌入 session 重查：5 分鐘內不打平台；過期重查成功續用；inactive／沒權限／token_after 變大 → 401', async () => {
  const c = await setup();
  c.fp.person('DZY903', { token_after: 10 });
  const enter = async () => (await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY903') } })).data.token;
  const who = () => c.fp.calls.filter((x) => x.action === 'svcPurchaseWho').length;
  let tok = await enter();
  c.clock.add(4 * 60e3);
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
  assert.strictEqual(who(), 0);
  c.clock.add(2 * 60e3);                                        // 6 分鐘：重查
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
  assert.strictEqual(who(), 1);
  const s = c.app.db.prepare('SELECT verified_at FROM sessions WHERE sub = ?').get('DZY903');
  assert.strictEqual(s.verified_at, c.clock.now().toISOString());
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
  assert.strictEqual(who(), 1);                                 // 剛確認過，不再打
  // inactive
  c.fp.idents.DZY903 = { sub: 'DZY903', active: false };
  c.clock.add(6 * 60e3);
  let r = await c.call('GET', '/review', { token: tok });
  assert.strictEqual(r.status, 401); assert.match(r.message, /權限已變更/);
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 401);
  // allowed false
  c.fp.person('DZY903', { token_after: 10 }); tok = await enter();
  c.fp.person('DZY903', { token_after: 10, allowed: false });
  c.clock.add(6 * 60e3);
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 401);
  // token_after 變大（在管理系統登出全部裝置／改密碼）
  c.fp.person('DZY903', { token_after: 10 }); tok = await enter();
  c.fp.person('DZY903', { token_after: 11 });
  c.clock.add(6 * 60e3);
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 401);
  assert.strictEqual(c.app.db.prepare('SELECT COUNT(*) n FROM sessions WHERE sub = ?').get('DZY903').n, 0);
  // admin 清掉同仁編號 → 立即 401（不必等 5 分鐘）
  tok = await enter();
  const u = (await c.users()).find((x) => x.dzy_sub === 'DZY903');
  assert.strictEqual((await c.call('PUT', '/admin/users/' + u.id, { token: c.admin, body: { dzy_sub: '' } })).status, 200);
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 401);
  await c.done();
});

test('嵌入 session 重查：連不上管理系統 → 從上次確認起 30 分鐘內放行，超過回 503；恢復後續用', async () => {
  const c = await setup();
  c.fp.person('DZY904');
  const tok = (await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY904') } })).data.token;
  c.fp.down = true;
  c.clock.add(6 * 60e3);
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
  const tried = c.app.db.prepare('SELECT tried_at, verified_at FROM sessions WHERE sub = ?').get('DZY904');
  assert.ok(tried.tried_at > tried.verified_at);
  c.clock.add(10e3);                                            // 30 秒內不再重試
  const before = c.fp.calls.length;
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
  assert.strictEqual(c.fp.calls.length, before);
  c.clock.add(23 * 60e3);                                       // 約 29 分
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
  c.clock.add(2 * 60e3);                                        // 31 分
  const r = await c.call('GET', '/review', { token: tok });
  assert.strictEqual(r.status, 503); assert.strictEqual(r.error, 'UPSTREAM');
  c.fp.down = false;
  c.clock.add(31e3);
  assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
  await c.done();
});

// ---------- /sso/counts ----------
test('/sso/counts：會計＝自己全部品牌加總、admin＝全部；不自動建帳、不發 session', async () => {
  const c = await setup();
  const db = c.app.db;
  const store = (code) => db.prepare('SELECT id, brand_id FROM stores WHERE code = ?').get(code);
  let i = 0;
  const slip = (code, status) => { const s = store(code); i++; db.prepare("INSERT INTO slips (id, client_id, store_id, brand_id, status, uploaded_at) VALUES (?,?,?,?,?,'2026-11-01T00:00:00Z')").run('S20261101-' + String(i).padStart(4, '0'), 'c' + i, s.id, s.brand_id, status); };
  slip('X01', 'review'); slip('X01', 'review'); slip('X01', 'failed'); slip('M01', 'review'); slip('M01', 'failed'); slip('C01', 'review'); slip('C01', 'confirmed');
  const accX = await c.uid('acc-x');
  db.prepare("INSERT INTO user_brands (user_id, brand_id) VALUES (?, 'M')").run(accX);
  await c.call('PUT', '/admin/users/' + accX, { token: c.admin, body: { dzy_sub: 'DZY905' } });
  await c.call('PUT', '/admin/users/' + (await c.uid('admin')), { token: c.admin, body: { dzy_sub: 'U:boss-01' } });
  c.fp.person('DZY905'); c.fp.person('U:boss-01'); c.fp.person('DZY906');
  const sessions = () => db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  const users = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const s0 = sessions(), u0 = users();
  let r = await c.call('POST', '/sso/counts', { body: { ticket: c.fp.ticket('DZY905') } });
  assert.deepStrictEqual(r.data, { review: 3, failed: 2 });
  r = await c.call('POST', '/sso/counts', { body: { ticket: c.fp.ticket('U:boss-01') } });
  assert.deepStrictEqual(r.data, { review: 4, failed: 2 });
  r = await c.call('POST', '/sso/counts', { body: { ticket: c.fp.ticket('DZY906') } });
  assert.deepStrictEqual(r.data, { review: 0, failed: 0 });
  assert.strictEqual(sessions(), s0); assert.strictEqual(users(), u0);
  c.fp.person('DZY905', { allowed: false });
  assert.strictEqual((await c.call('POST', '/sso/counts', { body: { ticket: c.fp.ticket('DZY905') } })).status, 403);
  assert.strictEqual((await c.call('POST', '/sso/counts', { body: { ticket: tk() } })).status, 401);
  // 從管理系統頁面直接呼叫：CORS 依 ALLOW_ORIGIN
  const pre = await fetch(c.base + '/sso/counts', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8777' } });
  assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'http://localhost:8777');
  await c.done();
});

// ---------- ACCT_LOGIN_UNTIL ----------
test('ACCT_LOGIN_UNTIL：台北時間該日結束後擋會計密碼登入（含既有密碼 session），admin 不擋', async () => {
  assert.strictEqual(loadConfig({ ACCT_LOGIN_UNTIL: '2026-11-07' }).ACCT_LOGIN_UNTIL, Date.parse('2026-11-07T16:00:00Z'));
  assert.strictEqual(loadConfig({}).ACCT_LOGIN_UNTIL, null);
  const err = console.error; console.error = () => {};
  assert.strictEqual(loadConfig({ ACCT_LOGIN_UNTIL: '2026-13-40' }).ACCT_LOGIN_UNTIL, null);
  console.error = err;
  let t = Date.parse('2026-11-07T15:59:58Z');                       // 台北 23:59:58
  const ctx = await startApp({ cfg: { ACCT_LOGIN_UNTIL: Date.parse('2026-11-07T16:00:00Z') }, now: () => new Date(t) });
  const before = await ctx.login('acc-x', PASS.SEED_PASS_ACC_X);
  assert.ok(before);
  assert.strictEqual((await ctx.call('GET', '/review', { token: before })).status, 200);
  t = Date.parse('2026-11-07T16:00:01Z');                            // 台北 11/08 00:00:01
  const r = await ctx.call('POST', '/login', { body: { account: 'acc-x', password: PASS.SEED_PASS_ACC_X } });
  assert.strictEqual(r.status, 403); assert.match(r.message, /管理系統/);
  const wrong = await ctx.call('POST', '/login', { body: { account: 'acc-x', password: 'wrong-pass' } });
  assert.strictEqual(wrong.status, 401);                              // 密碼錯仍是一般錯誤，不洩漏
  assert.strictEqual((await ctx.call('GET', '/review', { token: before })).status, 401);
  assert.ok(await ctx.login('admin', PASS.SEED_PASS_ADMIN));
  assert.ok(await ctx.login('X01', PASS.SEED_PASS_X01));
  await ctx.close();
});

// ---------- dzy_sub ----------
test('帳號頁 dzy_sub：格式驗證、大小寫整理、唯一衝突回 BAD_INPUT 中文、可清空、新增帳號可帶', async () => {
  const c = await setup();
  const accX = await c.uid('acc-x'), accM = await c.uid('acc-m');
  let r = await c.call('PUT', '/admin/users/' + accX, { token: c.admin, body: { dzy_sub: 'dzy007' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.dzy_sub, 'DZY007');
  r = await c.call('PUT', '/admin/users/' + accM, { token: c.admin, body: { dzy_sub: 'DZY007' } });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.error, 'BAD_INPUT'); assert.match(r.message, /已經綁在帳號「acc-x」/);
  for (const bad of ['DZY1', 'ABC123', 'U:', 'U:有中文', 'U:' + 'a'.repeat(65)]) {
    r = await c.call('PUT', '/admin/users/' + accM, { token: c.admin, body: { dzy_sub: bad } });
    assert.strictEqual(r.status, 400, bad); assert.match(r.message, /格式不對/);
  }
  r = await c.call('PUT', '/admin/users/' + accM, { token: c.admin, body: { dzy_sub: 'u:acct_m-2' } });
  assert.strictEqual(r.data.dzy_sub, 'U:acct_m-2');
  r = await c.call('PUT', '/admin/users/' + accX, { token: c.admin, body: { dzy_sub: '' } });
  assert.strictEqual(r.data.dzy_sub, '');
  assert.strictEqual(c.app.db.prepare('SELECT dzy_sub FROM users WHERE id = ?').get(accX).dzy_sub, null);
  r = await c.call('PUT', '/admin/users/' + (await c.uid('acc-c')), { token: c.admin, body: { dzy_sub: 'DZY007' } });   // 清掉後可給別人
  assert.strictEqual(r.status, 200);
  r = await c.call('POST', '/admin/users', { token: c.admin, body: { username: 'acc-new', name: '測試會計丁', role: 'accountant', brand_ids: ['X'], password: 'pw-new-1', dzy_sub: 'U:acct_m-2' } });
  assert.strictEqual(r.status, 400);
  r = await c.call('POST', '/admin/users', { token: c.admin, body: { username: 'acc-new', name: '測試會計丁', role: 'accountant', brand_ids: ['X'], password: 'pw-new-1', dzy_sub: 'DZY908' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.dzy_sub, 'DZY908'); assert.strictEqual(r.data.sso_only, 0);
  const au = c.app.db.prepare("SELECT before, after FROM audit WHERE action = 'admin_user_update' ORDER BY id").all();
  assert.ok(au.some((a) => JSON.parse(a.after).dzy_sub === 'DZY007' && JSON.parse(a.before).dzy_sub === ''));
  // DB 層也擋重複
  assert.throws(() => c.app.db.prepare('UPDATE users SET dzy_sub = ? WHERE id = ?').run('DZY908', accM));
  await c.done();
});

// ---------- 對抗審查補強 ----------
test('/sso＋/sso/counts 限流：同一來源每分鐘合計 20 次，超過 429 不打平台；格式不對的券 BAD_INPUT 不打平台也算一次', async () => {
  const c = await setup();
  const raw = () => c.fp.calls.filter((x) => x.raw).length;
  for (let i = 0; i < 10; i++) {
    const r = await c.call('POST', i % 2 ? '/sso' : '/sso/counts', { body: { ticket: 'NOT-A-TICKET-' + i } });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.error, 'BAD_INPUT');
  }
  assert.strictEqual((await c.call('POST', '/sso', { body: { ticket: tk().toUpperCase() } })).status, 400);       // 大寫十六進位也不收
  assert.strictEqual(raw(), 0);
  for (let i = 0; i < 9; i++) assert.strictEqual((await c.call('POST', '/sso', { body: { ticket: tk() } })).status, 401);   // 隨機券：格式對，打平台
  assert.strictEqual(raw(), 9);
  let r = await c.call('POST', '/sso/counts', { body: { ticket: tk() } });                                         // 第 21 次
  assert.strictEqual(r.status, 429); assert.strictEqual(r.error, 'TOO_MANY'); assert.strictEqual(r.message, '嘗試太頻繁，請稍後再試');
  c.fp.person('DZY907');
  r = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY907') } });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(raw(), 9);
  // 從 loopback 進來（Funnel）：依 X-Forwarded-For 最後一段分開計
  r = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY907') }, headers: { 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' } });
  assert.strictEqual(r.status, 200);
  // 一分鐘後恢復
  c.clock.add(61e3);
  r = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY907') } });
  assert.strictEqual(r.status, 200);
  await c.done();
});

test('clientIp：只有 peer 是 loopback 才信 X-Forwarded-For 最後一段', () => {
  const mk = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  assert.strictEqual(clientIp(mk('127.0.0.1', '1.1.1.1, 2.2.2.2')), '2.2.2.2');
  assert.strictEqual(clientIp(mk('::1', '3.3.3.3')), '3.3.3.3');
  assert.strictEqual(clientIp(mk('::ffff:127.0.0.1', '4.4.4.4')), '4.4.4.4');
  assert.strictEqual(clientIp(mk('127.0.0.1')), '127.0.0.1');
  assert.strictEqual(clientIp(mk('192.0.2.5', '9.9.9.9')), '192.0.2.5');
});

test('嵌入 session 重查：平台回 200 但不是 JSON／形狀不對 → 當連不上（30 分鐘內放行、之後 503），不刪 session', async () => {
  const c = await setup();
  const err = console.error; console.error = () => {};
  try {
    c.fp.person('DZY904');
    const tok = (await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY904') } })).data.token;
    c.fp.garbage = 'html';
    c.clock.add(6 * 60e3);
    assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
    c.fp.garbage = 'shape';
    c.clock.add(60e3);
    assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
    assert.strictEqual(c.app.db.prepare('SELECT COUNT(*) n FROM sessions WHERE sub = ?').get('DZY904').n, 1);
    c.clock.add(25 * 60e3);                                       // 距上次確認 32 分
    const r = await c.call('GET', '/review', { token: tok });
    assert.strictEqual(r.status, 503);
    c.fp.garbage = null;
    c.clock.add(31e3);
    assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 200);
    // 契約內的業務錯誤（bad_input）才刪 session
    c.fp.garbage = 'biz';
    c.clock.add(6 * 60e3);
    assert.strictEqual((await c.call('GET', '/review', { token: tok })).status, 401);
    assert.strictEqual(c.app.db.prepare('SELECT COUNT(*) n FROM sessions WHERE sub = ?').get('DZY904').n, 0);
  } finally { console.error = err; }
  await c.done();
});

// ---------- 2026-10-26：admin 改角色／品牌 → 這個帳號的 session 作廢（嵌入頁會自動重要入場券） ----------
test('帳號頁改角色或品牌清單 → 該帳號 session（嵌入＋密碼）全部作廢；只改姓名／預設品牌不作廢；admin 改自己不會被登出', async () => {
  const c = await setup();
  const id = await c.uid('acc-x');
  assert.strictEqual((await c.call('PUT', '/admin/users/' + id, { token: c.admin, body: { dzy_sub: 'DZY911' } })).status, 200);
  c.fp.person('DZY911');
  const embed = async () => { const r = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY911') } }); assert.strictEqual(r.status, 200, JSON.stringify(r)); return r.data.token; };
  const alive = async (tok) => (await c.call('GET', '/review', { token: tok })).status;
  const put = async (body) => { const r = await c.call('PUT', '/admin/users/' + id, { token: c.admin, body }); assert.strictEqual(r.status, 200, JSON.stringify(r)); return r.data; };
  const resets = () => c.app.db.prepare("SELECT after FROM audit WHERE action = 'admin_user_update'").all().filter((a) => JSON.parse(a.after).sessions_reset).length;

  // 只改姓名：不作廢
  let e1 = await embed();
  const pw = await c.login('acc-x', PASS.SEED_PASS_ACC_X);
  await put({ name: '測試會計改名' });
  assert.strictEqual(await alive(e1), 200); assert.strictEqual(await alive(pw), 200);
  // 給同樣的品牌清單（沒變）：不作廢
  await put({ brand_ids: ['X'] });
  assert.strictEqual(await alive(e1), 200);
  assert.strictEqual(resets(), 0);

  // 品牌清單變了（X → X＋M）：嵌入與密碼 session 都作廢；重新兌券拿到新品牌
  await put({ brand_ids: ['X', 'M'] });
  assert.strictEqual(await alive(e1), 401); assert.strictEqual(await alive(pw), 401);
  assert.strictEqual(resets(), 1);
  const au = c.app.db.prepare("SELECT before, after FROM audit WHERE action = 'admin_user_update' ORDER BY id DESC LIMIT 1").get();
  assert.deepStrictEqual(JSON.parse(au.before).brand_ids, ['X']); assert.deepStrictEqual(JSON.parse(au.after).brand_ids, ['M', 'X']);   // 稽核的 before 是改之前
  const r2 = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY911') } });
  assert.deepStrictEqual(r2.data.brands.map((b) => b.id).sort(), ['M', 'X']);
  // 只改預設品牌（清單不變）：不作廢
  await put({ brand_id: 'M' });
  assert.strictEqual(await alive(r2.data.token), 200);

  // 會計 → admin：作廢；重新兌券是 admin
  await put({ role: 'admin' });
  assert.strictEqual(await alive(r2.data.token), 401);
  const r3 = await c.call('POST', '/sso', { body: { ticket: c.fp.ticket('DZY911') } });
  assert.strictEqual(r3.data.role, 'admin');
  // admin → 會計：也作廢
  await put({ role: 'accountant', brand_ids: ['X'] });
  assert.strictEqual(await alive(r3.data.token), 401);

  // admin 改自己（角色仍是 admin）：不會把自己登出；降級自己照舊擋
  const me = await c.uid('admin');
  assert.strictEqual((await c.call('PUT', '/admin/users/' + me, { token: c.admin, body: { role: 'admin', name: '測試管理者' } })).status, 200);
  assert.strictEqual((await c.call('GET', '/admin/users', { token: c.admin })).status, 200);
  assert.strictEqual((await c.call('PUT', '/admin/users/' + me, { token: c.admin, body: { role: 'accountant', brand_ids: ['X'] } })).status, 400);
  assert.strictEqual((await c.call('GET', '/admin/users', { token: c.admin })).status, 200);
  await c.done();
});
