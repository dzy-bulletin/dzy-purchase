'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startApp, PASS, uuid } = require('./helpers');

const AI = (o) => JSON.stringify(Object.assign({ vendor: '邦聿肉品', date: '2026-10-01', doc_no: 'A1', lines: [{ name: '絞肉', qty: '300', unit: '', unit_price: '68', amount: '204' }],
  subtotal: '', tax: '', total: '20400', handwritten_changes: '' }, o));
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

test('健康檢查、資料表數量、重啟不重建', async () => {
  const t = await startApp();
  try {
    const r = await t.call('GET', '/health');
    assert.strictEqual(r.ok, true);
    const tables = t.app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    assert.strictEqual(tables.length, 14);
    const { openDb } = require('../server/db');
    const again = openDb(t.dir);                                    // 同一資料夾再開一次：資料還在
    assert.strictEqual(again.prepare('SELECT COUNT(*) c FROM stores').get().c, 2);
    assert.strictEqual(again.prepare('PRAGMA user_version').get().user_version, 1);
    again.close();
    assert.ok((await t.call('GET', '/nope')).error === 'NOT_FOUND');
  } finally { await t.close(); }
});

test('登入：錯密碼 AUTH、第 6 次 LOCKED（含正確密碼也鎖）、成功重置', async () => {
  const t = await startApp();
  try {
    for (let i = 0; i < 5; i++) { const r = await t.call('POST', '/login', { body: { account: 'C01', password: 'bad' } }); assert.strictEqual(r.error, 'AUTH'); assert.strictEqual(r.status, 401); }
    const r6 = await t.call('POST', '/login', { body: { account: 'C01', password: 'bad' } });
    assert.strictEqual(r6.error, 'LOCKED');
    assert.strictEqual((await t.call('POST', '/login', { body: { account: 'C01', password: PASS.SEED_PASS_C01 } })).error, 'LOCKED');
    // 其他帳號不受影響；成功登入重置計數
    for (let i = 0; i < 3; i++) await t.call('POST', '/login', { body: { account: 'M01', password: 'bad' } });
    const ok = await t.call('POST', '/login', { body: { account: 'M01', password: PASS.SEED_PASS_M01 } });
    assert.strictEqual(ok.ok, true); assert.strictEqual(ok.data.role, 'store'); assert.strictEqual(ok.data.brand, 'M');
    assert.strictEqual((await t.call('POST', '/login', { body: { account: 'nobody', password: 'x' } })).error, 'AUTH');
    assert.strictEqual((await t.call('GET', '/vendors')).error, 'AUTH');
    // token 只存雜湊
    const row = t.app.db.prepare('SELECT token_hash FROM sessions').get();
    assert.notStrictEqual(row.token_hash, ok.data.token);
  } finally { await t.close(); }
});

test('門市 token 打會計 API → FORBIDDEN；/vendors 依角色回傳', async () => {
  const t = await startApp();
  try {
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    for (const [m, p] of [['GET', '/review'], ['GET', '/slips/S20260101-0001'], ['POST', '/slips/S20260101-0001/confirm'], ['PUT', '/slips/S20260101-0001']]) {
      const r = await t.call(m, p, { token: st, body: {} }); assert.strictEqual(r.error, 'FORBIDDEN', m + p); assert.strictEqual(r.status, 403);
    }
    const v = await t.call('GET', '/vendors', { token: st });
    assert.strictEqual(v.data.length, 6); assert.deepStrictEqual(Object.keys(v.data[0]).sort(), ['id', 'name']);
    const adm = await t.login('admin', PASS.SEED_PASS_ADMIN);
    assert.strictEqual((await t.call('GET', '/vendors', { token: adm })).data.length, 12);
    assert.strictEqual((await t.call('POST', '/slips', { token: await t.login('acc-c', PASS.SEED_PASS_ACC_C), raw: Buffer.from('x') })).error, 'FORBIDDEN');
  } finally { await t.close(); }
});

test('上傳：client_id 冪等只一筆、ID 與照片路徑照契約、vendor_name 規則', async () => {
  const t = await startApp();
  try {
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    const cid = uuid();
    const a = await t.upload(st, { clientId: cid, photos: 2, vendor_name: '蔬鄉' });
    const b = await t.upload(st, { clientId: cid, photos: 2, vendor_name: '蔬鄉' });
    assert.strictEqual(a.ok, true); assert.strictEqual(b.ok, true); assert.strictEqual(a.data.id, b.data.id);
    assert.match(a.data.id, /^S\d{8}-0001$/); assert.strictEqual(a.data.id.slice(1, 9), today().replace(/-/g, ''));
    assert.strictEqual(t.app.db.prepare('SELECT COUNT(*) c FROM slips').get().c, 1);
    const ph = t.app.db.prepare('SELECT * FROM slip_photos ORDER BY seq').all();
    assert.strictEqual(ph.length, 2);
    const ym = today().slice(0, 7).replace('-', '');
    assert.strictEqual(ph[0].path, `data/photos/${ym}/${a.data.id}_1.jpg`);
    assert.ok(fs.existsSync(path.join(t.dir, 'photos', ym, `${a.data.id}_2.jpg`)));
    const s = t.app.db.prepare('SELECT * FROM slips').get();
    assert.strictEqual(s.status, 'queued'); assert.ok(s.vendor_id); assert.strictEqual(s.vendor_name_raw, null);
    const c = await t.upload(st, { vendor_name: '不存在的廠商' });
    assert.match(c.data.id, /-0002$/);
    const s2 = t.app.db.prepare('SELECT * FROM slips WHERE id = ?').get(c.data.id);
    assert.strictEqual(s2.vendor_id, null); assert.strictEqual(s2.vendor_name_raw, '不存在的廠商');
    // 錯誤輸入
    assert.strictEqual((await t.upload(st, { clientId: 'not-a-uuid' })).error, 'BAD_INPUT');
    assert.strictEqual((await t.upload(st, { photos: 7 })).error, 'BAD_INPUT');
    assert.strictEqual((await t.upload(st, { vendor_id: '9999' })).error, 'BAD_INPUT');
    // 自己門市清單
    const mine = await t.call('GET', '/slips?mine=1', { token: st });
    assert.strictEqual(mine.data.length, 2); assert.ok('return_reason' in mine.data[0]);
  } finally { await t.close(); }
});

// 共用：上傳＋跑一次 worker → review
async function slipInReview(t, aiText, store = 'C01', pw = PASS.SEED_PASS_C01) {
  const st = await t.login(store, pw);
  const up = await t.upload(st, { vendor_name: '邦聿肉品' });
  assert.ok(up.ok, JSON.stringify(up));
  await t.app.worker.drain();
  return up.data.id;
}

test('worker：p1 漏零 → AMOUNT_FIXED；品牌隔離；有紅旗標 confirm → RED_FLAGS', async () => {
  let text = AI();
  const t = await startApp({ recognize: async () => text });
  try {
    const id = await slipInReview(t);
    const accC = await t.login('acc-c', PASS.SEED_PASS_ACC_C), accM = await t.login('acc-m', PASS.SEED_PASS_ACC_M);
    const d = (await t.call('GET', `/slips/${id}`, { token: accC })).data;
    assert.strictEqual(d.status, 'review'); assert.strictEqual(d.lines[0].amount, 20400);
    assert.deepStrictEqual(d.lines[0].flags, ['AMOUNT_FIXED', 'ITEM_UNMAPPED']);
    assert.strictEqual(d.photos.length, 1); assert.ok(d.ai_seconds >= 0);
    // A 品牌會計讀 B 品牌貨單
    assert.strictEqual((await t.call('GET', `/slips/${id}`, { token: accM })).error, 'FORBIDDEN');
    assert.strictEqual((await t.call('PUT', `/slips/${id}`, { token: accM, body: {} })).error, 'FORBIDDEN');
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: accM })).error, 'FORBIDDEN');
    assert.strictEqual((await t.call('GET', `/photos/${id}/1`, { token: accM })).error, 'FORBIDDEN');
    assert.strictEqual((await t.call('GET', '/review', { token: accM })).data.length, 0);
    assert.strictEqual((await t.call('GET', '/review', { token: accC })).data.length, 1);
    assert.strictEqual((await t.call('GET', `/slips/S20200101-0001`, { token: accC })).error, 'NOT_FOUND');
    // 照片：要登入；本門市可看、別門市不行
    assert.strictEqual((await t.call('GET', `/photos/${id}/1`)).error, 'AUTH');
    const stC = await t.login('C01', PASS.SEED_PASS_C01), stM = await t.login('M01', PASS.SEED_PASS_M01);
    const pic = await t.call('GET', `/photos/${id}/1`, { token: stC }); assert.strictEqual(pic.status, 200); assert.strictEqual(pic.type, 'image/jpeg');
    assert.strictEqual((await t.call('GET', `/photos/${id}/1`, { token: stM })).error, 'FORBIDDEN');
    // 改成缺單價 → 紅旗標 → confirm 被擋
    const lid = d.lines[0].id;
    const put = await t.call('PUT', `/slips/${id}`, { token: accC, body: { lines: [{ id: lid, raw_name: '絞肉', qty: 300, unit: '公斤', unit_price: null, amount: null, checked: 1 }] } });
    assert.ok(put.data.lines[0].flags.includes('PRICE_MISSING'));
    const c1 = await t.call('POST', `/slips/${id}/confirm`, { token: accC });
    assert.strictEqual(c1.error, 'RED_FLAGS'); assert.strictEqual(c1.status, 409);
    // 補單價，但總額不符 → SUM_MISMATCH 也擋
    await t.call('PUT', `/slips/${id}`, { token: accC, body: { total: 999, lines: [{ id: lid, raw_name: '絞肉', qty: 300, unit: '公斤', unit_price: 68, amount: 20400, checked: 1 }] } });
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: accC })).error, 'RED_FLAGS');
    // 全部處理好 → 入帳成功；audit 有紀錄
    await t.call('PUT', `/slips/${id}`, { token: accC, body: { total: 20400, lines: [{ id: lid, raw_name: '絞肉', qty: 300, unit: '公斤', unit_price: 68, amount: 20400, checked: 1 }] } });
    const ok = await t.call('POST', `/slips/${id}/confirm`, { token: accC });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok)); assert.strictEqual(ok.data.status, 'confirmed');
    assert.strictEqual((await t.call('PUT', `/slips/${id}`, { token: accC, body: {} })).error, 'CONFLICT');
    // unconfirm 必填原因
    assert.strictEqual((await t.call('POST', `/slips/${id}/unconfirm`, { token: accC, body: {} })).error, 'BAD_INPUT');
    assert.strictEqual((await t.call('POST', `/slips/${id}/unconfirm`, { token: accC, body: { reason: '單價打錯' } })).data.status, 'review');
    const acts = t.app.db.prepare('SELECT action FROM audit WHERE slip_id = ? ORDER BY id').all(id).map((r) => r.action);
    assert.deepStrictEqual(acts, ['upload', 'recognize', 'edit', 'edit', 'edit', 'confirm', 'unconfirm']);
    const un = t.app.db.prepare("SELECT after FROM audit WHERE action='unconfirm'").get();
    assert.ok(un.after.includes('單價打錯'));
  } finally { await t.close(); }
});

test('未打勾不能入帳；return 寫入原因且門市看得到；p6 缺單價走紅旗標', async () => {
  const t = await startApp({ recognize: async () => AI({ lines: [{ name: 'T7帶皮腿肉', qty: '108', unit: '', unit_price: '', amount: '' }], total: '50850' }) });
  try {
    const id = await slipInReview(t);
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C), st = await t.login('C01', PASS.SEED_PASS_C01);
    const d = (await t.call('GET', `/slips/${id}`, { token: acc })).data;
    assert.ok(d.lines[0].flags.includes('PRICE_MISSING')); assert.strictEqual(d.lines[0].unit_price, null);
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).error, 'RED_FLAGS');
    // 補單價（不勾）→ 沒紅旗標但未打勾
    await t.call('PUT', `/slips/${id}`, { token: acc, body: { lines: [{ id: d.lines[0].id, raw_name: 'T7帶皮腿肉', qty: 108, unit_price: 470.83, amount: 50850 }] } });
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).error, 'RED_FLAGS'); // 108*470.83=50849.64 ≠ 50850
    const r = await t.call('POST', `/slips/${id}/return`, { token: acc, body: { reason: '照片模糊' } });
    assert.strictEqual(r.data.status, 'returned');
    const mine = (await t.call('GET', '/slips?mine=1', { token: st })).data;
    assert.strictEqual(mine[0].status, 'returned'); assert.strictEqual(mine[0].return_reason, '照片模糊');
    await t.call('PUT', `/slips/${id}`, { token: acc, body: { lines: [{ id: d.lines[0].id, raw_name: 'T7帶皮腿肉', qty: 100, unit_price: 500, amount: 50000 }], total: 50000 } });
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).error, 'CONFLICT');   // 沒打勾
  } finally { await t.close(); }
});

test('worker：失敗重試 2 次（共 3 次）後 failed；JSON 壞掉算失敗；之後可手動輸入', async () => {
  let calls = 0;
  const t = await startApp({ recognize: async () => { calls++; throw new Error('connect ECONNREFUSED'); } });
  try {
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    const up = await t.upload(st);
    await t.app.worker.drain();
    assert.strictEqual(calls, 3);
    const s = t.app.db.prepare('SELECT * FROM slips WHERE id = ?').get(up.data.id);
    assert.strictEqual(s.status, 'failed'); assert.ok(s.error.includes('ECONNREFUSED'));
    // 失敗的貨單，會計可手動輸入並入帳
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C);
    assert.strictEqual((await t.call('GET', '/review?status=failed', { token: acc })).data.length, 1);
    const put = await t.call('PUT', `/slips/${up.data.id}`, { token: acc, body: { doc_date: '2026-10-02', total: 100, lines: [{ raw_name: '手動品', qty: 1, unit: 'kg', unit_price: 100, amount: 100, checked: 1 }] } });
    assert.strictEqual(put.data.status, 'review');
    assert.strictEqual((await t.call('POST', `/slips/${up.data.id}/confirm`, { token: acc })).data.status, 'confirmed');
  } finally { await t.close(); }
  // 壞 JSON
  let n = 0;
  const t2 = await startApp({ recognize: async () => (++n < 3 ? '{壞掉' : AI()) });
  try {
    const st = await t2.login('C01', PASS.SEED_PASS_C01);
    const up = await t2.upload(st);
    await t2.app.worker.drain();
    assert.strictEqual(t2.app.db.prepare('SELECT status FROM slips WHERE id = ?').get(up.data.id).status, 'review');   // 第 3 次成功
    assert.strictEqual(t2.app.db.prepare('SELECT attempts FROM slips WHERE id = ?').get(up.data.id).attempts, 2);
  } finally { await t2.close(); }
});

test('worker：一次一張、先進先出；重啟時把卡住的辨識中重新排隊', async () => {
  let active = 0, maxActive = 0; const order = [];
  const t = await startApp({ recognize: async (files, slip) => { active++; maxActive = Math.max(maxActive, active); order.push(slip.id); await new Promise((r) => setTimeout(r, 10)); active--; return AI(); } });
  try {
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    const ids = []; for (let i = 0; i < 3; i++) ids.push((await t.upload(st)).data.id);
    t.app.db.prepare("UPDATE slips SET status = 'recognizing' WHERE id = ?").run(ids[0]);   // 模擬當機
    t.app.worker.requeueStuck();
    await Promise.all([t.app.worker.drain(), t.app.worker.drain()]);
    assert.strictEqual(maxActive, 1); assert.deepStrictEqual(order, ids);
    assert.strictEqual(t.app.db.prepare("SELECT COUNT(*) c FROM slips WHERE status = 'review'").get().c, 3);
  } finally { await t.close(); }
});

test('CORS：允許 dzy-bulletin 與 localhost、含 Authorization 與 PUT；其他來源不給', async () => {
  const t = await startApp();
  try {
    const h = (origin) => fetch(t.base + '/slips/S1', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' } });
    let r = await h('https://dzy-bulletin.github.io'); assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://dzy-bulletin.github.io');
    assert.match(r.headers.get('access-control-allow-headers'), /Authorization/); assert.match(r.headers.get('access-control-allow-methods'), /PUT/);
    assert.strictEqual((await h('http://localhost:5500')).headers.get('access-control-allow-origin'), 'http://localhost:5500');
    assert.strictEqual((await h('https://evil.example')).headers.get('access-control-allow-origin'), null);
  } finally { await t.close(); }
});
