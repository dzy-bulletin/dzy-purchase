'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startApp, PASS, uuid } = require('./helpers');

const AI = (o) => JSON.stringify(Object.assign({ vendor: '測試肉品行', date: '2026-10-01', doc_no: 'A1', lines: [{ name: '範例肉末', qty: '120', unit: '', unit_price: '45', amount: '54' }],
  subtotal: '', tax: '', total: '5400', handwritten_changes: '' }, o));
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

test('健康檢查、資料表數量、重啟不重建', async () => {
  const t = await startApp();
  try {
    const r = await t.call('GET', '/health');
    assert.strictEqual(r.ok, true);
    const tables = t.app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    assert.strictEqual(tables.length, 18);
    const { openDb } = require('../server/db');
    const again = openDb(t.dir);                                    // 同一資料夾再開一次：資料還在
    assert.strictEqual(again.prepare('SELECT COUNT(*) c FROM stores').get().c, 3);
    assert.strictEqual(again.prepare('PRAGMA user_version').get().user_version, 5);
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
    assert.strictEqual((await t.call('GET', '/vendors', { token: adm })).data.length, 18);
    assert.strictEqual((await t.call('POST', '/slips', { token: await t.login('acc-c', PASS.SEED_PASS_ACC_C), raw: Buffer.from('x') })).error, 'FORBIDDEN');
  } finally { await t.close(); }
});

test('上傳：client_id 冪等只一筆、ID 與照片路徑照契約、vendor_name 規則', async () => {
  const t = await startApp();
  try {
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    const cid = uuid();
    const a = await t.upload(st, { clientId: cid, photos: 2, vendor_name: '範例蔬果行' });
    const b = await t.upload(st, { clientId: cid, photos: 2, vendor_name: '範例蔬果行' });
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
  const up = await t.upload(st, { vendor_name: '測試肉品行' });
  assert.ok(up.ok, JSON.stringify(up));
  await t.app.worker.drain();
  return up.data.id;
}

test('worker：漏零 → AMOUNT_FIXED；品牌隔離；有紅旗標 confirm → RED_FLAGS', async () => {
  let text = AI();
  const t = await startApp({ recognize: async () => text });
  try {
    const id = await slipInReview(t);
    const accC = await t.login('acc-c', PASS.SEED_PASS_ACC_C), accM = await t.login('acc-m', PASS.SEED_PASS_ACC_M);
    const d = (await t.call('GET', `/slips/${id}`, { token: accC })).data;
    assert.strictEqual(d.status, 'review'); assert.strictEqual(d.lines[0].amount, 5400);
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
    const put = await t.call('PUT', `/slips/${id}`, { token: accC, body: { lines: [{ id: lid, raw_name: '範例肉末', qty: 120, unit: '公斤', unit_price: null, amount: null, checked: 1 }] } });
    assert.ok(put.data.lines[0].flags.includes('PRICE_MISSING'));
    const c1 = await t.call('POST', `/slips/${id}/confirm`, { token: accC });
    assert.strictEqual(c1.error, 'RED_FLAGS'); assert.strictEqual(c1.status, 409);
    // 補單價，但總額不符 → SUM_MISMATCH 也擋
    await t.call('PUT', `/slips/${id}`, { token: accC, body: { total: 999, lines: [{ id: lid, raw_name: '範例肉末', qty: 120, unit: '公斤', unit_price: 45, amount: 5400, checked: 1 }] } });
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: accC })).error, 'RED_FLAGS');
    // 全部處理好 → 入帳成功；audit 有紀錄
    await t.call('PUT', `/slips/${id}`, { token: accC, body: { total: 5400, lines: [{ id: lid, raw_name: '範例肉末', qty: 120, unit: '公斤', unit_price: 45, amount: 5400, checked: 1 }] } });
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
  const t = await startApp({ recognize: async () => AI({ lines: [{ name: '範例雞腿', qty: '36', unit: '', unit_price: '', amount: '' }], total: '8888' }) });
  try {
    const id = await slipInReview(t);
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C), st = await t.login('C01', PASS.SEED_PASS_C01);
    const d = (await t.call('GET', `/slips/${id}`, { token: acc })).data;
    assert.ok(d.lines[0].flags.includes('PRICE_MISSING')); assert.strictEqual(d.lines[0].unit_price, null);
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).error, 'RED_FLAGS');
    // 補單價（不勾）→ 沒紅旗標但未打勾
    await t.call('PUT', `/slips/${id}`, { token: acc, body: { lines: [{ id: d.lines[0].id, raw_name: '範例雞腿', qty: 36, unit_price: 246.89, amount: 8888 }] } });
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).error, 'RED_FLAGS'); // 36*246.89=8888.04 ≠ 8888
    const r = await t.call('POST', `/slips/${id}/return`, { token: acc, body: { reason: '照片模糊' } });
    assert.strictEqual(r.data.status, 'returned');
    const mine = (await t.call('GET', '/slips?mine=1', { token: st })).data;
    assert.strictEqual(mine[0].status, 'returned'); assert.strictEqual(mine[0].return_reason, '照片模糊');
    await t.call('PUT', `/slips/${id}`, { token: acc, body: { lines: [{ id: d.lines[0].id, raw_name: '範例雞腿', qty: 20, unit_price: 400, amount: 8000 }], total: 8000 } });
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

// ---------- 階段關審查修正的測試 ----------
const reviewSlip = async (t, ai) => {   // 上傳＋辨識＋回傳 {id, acc, d}
  const id = await slipInReview(t);
  const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C);
  return { id, acc, d: (await t.call('GET', `/slips/${id}`, { token: acc })).data };
};
const LN = (id, o) => Object.assign({ id, raw_name: '範例肉末', qty: 120, unit: '公斤', unit_price: 45, amount: 5400, checked: 1 }, o);

test('#2 confirm 要求總額與每列數量／單價／金額，缺值就擋', async () => {
  const t = await startApp({ recognize: async () => AI() });
  try {
    const { id, acc, d } = await reviewSlip(t);
    const lid = d.lines[0].id;
    // 總額清掉 → 紅旗標 SUM_MISMATCH，confirm 被擋
    const p1 = await t.call('PUT', `/slips/${id}`, { token: acc, body: { total: null, lines: [LN(lid)] } });
    assert.ok(p1.data.flags.includes('SUM_MISMATCH'));
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).error, 'RED_FLAGS');
    // 新增一列只有數量單價、金額空 → 該列金額遺失，不可入帳
    const p2 = await t.call('PUT', `/slips/${id}`, { token: acc, body: { total: 5400, lines: [LN(lid), { raw_name: '新列', qty: 3, unit: '個', unit_price: 100, amount: null, checked: 1 }] } });
    assert.ok(p2.data.flags.includes('SUM_MISMATCH'));
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).error, 'RED_FLAGS');
    // 補齊 → 可入帳（加總 5400+300 = 5700）
    await t.call('PUT', `/slips/${id}`, { token: acc, body: { total: 5700, lines: [LN(lid), { raw_name: '新列', qty: 3, unit: '個', unit_price: 100, amount: 300, checked: 1 }] } });
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).data.status, 'confirmed');
  } finally { await t.close(); }
});

test('#3 含稅單：未稅合計＋稅額＝總額 → 可入帳，成本以總額（含稅）為準', async () => {
  const t = await startApp({ recognize: async () => AI({ lines: [{ name: '範例茶葉', qty: '20', unit: '', unit_price: '210', amount: '4200' }], subtotal: '4200', tax: '210', total: '4410' }) });
  try {
    const { id, acc, d } = await reviewSlip(t);
    assert.deepStrictEqual(d.flags, []); assert.strictEqual(d.subtotal, 4200); assert.strictEqual(d.tax, 210); assert.strictEqual(d.total, 4410);
    await t.call('PUT', `/slips/${id}`, { token: acc, body: { lines: [LN(d.lines[0].id, { raw_name: '範例茶葉', qty: 20, unit_price: 210, amount: 4200 })] } });
    const r = await t.call('POST', `/slips/${id}/confirm`, { token: acc });
    assert.strictEqual(r.data.status, 'confirmed'); assert.strictEqual(r.data.total, 4410);
    // 會計改稅額欄位也被接受；稅額亂填 → 紅
    await t.call('POST', `/slips/${id}/unconfirm`, { token: acc, body: { reason: 'x' } });
    const bad = await t.call('PUT', `/slips/${id}`, { token: acc, body: { tax: 999 } });
    assert.ok(bad.data.flags.includes('SUM_MISMATCH'));
  } finally { await t.close(); }
});

test('#6 負數與 0 的數量／單價／金額／總額一律 BAD_INPUT；稅額可 0 不可負', async () => {
  const t = await startApp({ recognize: async () => AI() });
  try {
    const { id, acc, d } = await reviewSlip(t);
    const lid = d.lines[0].id;
    for (const o of [{ qty: -10 }, { qty: 0 }, { unit_price: 0 }, { unit_price: -5 }, { amount: -50 }, { amount: 0 }]) {
      const r = await t.call('PUT', `/slips/${id}`, { token: acc, body: { lines: [LN(lid, o)] } });
      assert.strictEqual(r.error, 'BAD_INPUT', JSON.stringify(o)); assert.strictEqual(r.status, 400);
    }
    assert.strictEqual((await t.call('PUT', `/slips/${id}`, { token: acc, body: { total: -50 } })).error, 'BAD_INPUT');
    assert.strictEqual((await t.call('PUT', `/slips/${id}`, { token: acc, body: { total: 0 } })).error, 'BAD_INPUT');
    assert.strictEqual((await t.call('PUT', `/slips/${id}`, { token: acc, body: { tax: -1 } })).error, 'BAD_INPUT');
    assert.strictEqual((await t.call('PUT', `/slips/${id}`, { token: acc, body: { tax: 0 } })).ok, true);
    // 被拒絕的修改不會留下任何改動
    assert.strictEqual((await t.call('GET', `/slips/${id}`, { token: acc })).data.lines[0].amount, 5400);
  } finally { await t.close(); }
});

test('#7 returned：PUT 回 CONFLICT；要 reopen 才能改，保留退回原因並留 audit', async () => {
  const t = await startApp({ recognize: async () => AI() });
  try {
    const { id, acc, d } = await reviewSlip(t);
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    assert.strictEqual((await t.call('POST', `/slips/${id}/return`, { token: acc, body: { reason: '照片模糊' } })).data.status, 'returned');
    const put = await t.call('PUT', `/slips/${id}`, { token: acc, body: { doc_no: 'X' } });
    assert.strictEqual(put.error, 'CONFLICT'); assert.strictEqual(put.status, 409);
    assert.strictEqual(t.app.db.prepare('SELECT status FROM slips WHERE id = ?').get(id).status, 'returned');
    assert.strictEqual((await t.call('POST', `/slips/${id}/confirm`, { token: acc })).error, 'CONFLICT');
    assert.strictEqual((await t.call('POST', `/slips/${id}/reopen`, { token: st })).error, 'FORBIDDEN');   // 門市不行
    const accM = await t.login('acc-m', PASS.SEED_PASS_ACC_M);
    assert.strictEqual((await t.call('POST', `/slips/${id}/reopen`, { token: accM })).error, 'FORBIDDEN'); // 別品牌不行
    const re = await t.call('POST', `/slips/${id}/reopen`, { token: acc });
    assert.strictEqual(re.data.status, 'review'); assert.strictEqual(re.data.return_reason, '照片模糊');
    assert.strictEqual((await t.call('POST', `/slips/${id}/reopen`, { token: acc })).error, 'CONFLICT');  // 只有 returned 能 reopen
    assert.strictEqual((await t.call('PUT', `/slips/${id}`, { token: acc, body: { doc_no: 'X' } })).ok, true);
    const acts = t.app.db.prepare('SELECT action FROM audit WHERE slip_id = ? ORDER BY id').all(id).map((r) => r.action);
    assert.deepStrictEqual(acts, ['upload', 'recognize', 'return', 'reopen', 'edit']);
    assert.strictEqual((await t.call('GET', '/review?status=returned', { token: acc })).data.length, 0);
  } finally { await t.close(); }
});

test('#9 日期讀不出：flags 仍是 DATE_FIXED，date_note 如實說「日期讀不出，暫用拍照日」', async () => {
  let date = '';
  const t = await startApp({ recognize: async () => AI({ date }) });
  try {
    const a = await reviewSlip(t);
    assert.ok(a.d.flags.includes('DATE_FIXED')); assert.strictEqual(a.d.date_note, '日期讀不出，暫用拍照日');
    date = '2020-09-30';
    const st = await t.login('C01', PASS.SEED_PASS_C01); await t.upload(st); await t.app.worker.drain();
    const list = (await t.call('GET', '/review', { token: a.acc })).data;
    const other = list.find((x) => x.id !== a.id);
    const d2 = (await t.call('GET', `/slips/${other.id}`, { token: a.acc })).data;
    assert.ok(d2.flags.includes('DATE_FIXED')); assert.match(d2.date_note, /年份離拍照日太遠/);
  } finally { await t.close(); }
});

test('#12 會計清空手寫說明 → HANDWRITTEN 旗標移除；重新填就回來', async () => {
  const t = await startApp({ recognize: async () => AI({ handwritten_changes: '加一件範例商品 333' }) });
  try {
    const { id, acc, d } = await reviewSlip(t);
    assert.ok(d.flags.includes('HANDWRITTEN'));
    const p = await t.call('PUT', `/slips/${id}`, { token: acc, body: { handwritten_note: '' } });
    assert.ok(!p.data.flags.includes('HANDWRITTEN')); assert.strictEqual(p.data.handwritten_note, null); assert.strictEqual(p.data.total_handwritten, 0);
    assert.ok((await t.call('PUT', `/slips/${id}`, { token: acc, body: { handwritten_note: '又寫了' } })).data.flags.includes('HANDWRITTEN'));
  } finally { await t.close(); }
});

test('#11 worker：outer 錯誤（記錄寫入失敗）不會卡在 recognizing，重新排隊後也能辨識', async () => {
  const t = await startApp({ recognize: async () => { throw new Error('boom'); } });
  try {
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    const up = await t.upload(st);
    t.app.db.exec("CREATE TRIGGER no_attempts BEFORE UPDATE OF attempts ON slips BEGIN SELECT RAISE(ABORT, 'db boom'); END;");   // 原本會讓這張卡在 recognizing
    await t.app.worker.drain();
    assert.strictEqual(t.app.db.prepare('SELECT status FROM slips WHERE id = ?').get(up.data.id).status, 'failed');
    t.app.db.exec('DROP TRIGGER no_attempts');
    // 卡住（recognizing 殘留）的貨單：下一輪 drain 會自己撿回來，不必重啟
    const up2 = await t.upload(st);
    t.app.db.prepare("UPDATE slips SET status = 'recognizing' WHERE id = ?").run(up2.data.id);
    await t.app.worker.drain();
    assert.notStrictEqual(t.app.db.prepare('SELECT status FROM slips WHERE id = ?').get(up2.data.id).status, 'recognizing');
  } finally { await t.close(); }
});

test('#11 worker：單張等待時間可設定（OLLAMA_TIMEOUT_S，預設 300 秒），逾時就標 failed', async () => {
  const { loadConfig } = require('../server/config');
  assert.strictEqual(loadConfig({ PURCHASE_NO_DOTENV: '1' }).OLLAMA_TIMEOUT_MS, 300000);
  assert.strictEqual(loadConfig({ OLLAMA_TIMEOUT_S: '0.2' }).OLLAMA_TIMEOUT_MS, 200);
  const http = require('http');
  const hang = http.createServer(() => { /* 永遠不回應 */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const t = await startApp({ cfg: { OLLAMA_URL: `http://127.0.0.1:${hang.address().port}`, OLLAMA_TIMEOUT_MS: 200 } });
  try {
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    const up = await t.upload(st);
    const t0 = Date.now();
    await t.app.worker.drain();
    const s = t.app.db.prepare('SELECT status, attempts, error FROM slips WHERE id = ?').get(up.data.id);
    assert.strictEqual(s.status, 'failed'); assert.strictEqual(s.attempts, 3); assert.ok(Date.now() - t0 < 5000, '應在數秒內結束');
  } finally { hang.closeAllConnections(); hang.close(); await t.close(); }
});

// ---------- 第 2 輪修正（#14／#15／#16）----------
const fakeOllama = async (body) => {
  const http = require('http');
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ response: body })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv;
};

test('#14 照片檔不存在：該張 failed（照片檔不存在）、process 不崩潰、下一張照常處理', async () => {
  const srv = await fakeOllama(AI());
  const t = await startApp({ cfg: { OLLAMA_URL: `http://127.0.0.1:${srv.address().port}` } });   // 走真實 ollamaRecognize → shrink
  let uncaught = null; const h = (e) => { uncaught = e; }; process.on('uncaughtException', h);
  try {
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    const a = await t.upload(st), b = await t.upload(st);
    const pa = t.app.db.prepare('SELECT path FROM slip_photos WHERE slip_id = ?').get(a.data.id).path;
    fs.unlinkSync(path.join(t.cfg.DATA_DIR, pa.replace(/^data\//, '')));
    await t.app.worker.drain();
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(uncaught, null);
    const sa = t.app.db.prepare('SELECT status, error FROM slips WHERE id = ?').get(a.data.id);
    assert.strictEqual(sa.status, 'failed'); assert.match(sa.error, /照片檔不存在/);
    assert.strictEqual(t.app.db.prepare('SELECT status FROM slips WHERE id = ?').get(b.data.id).status, 'review');
  } finally { process.removeListener('uncaughtException', h); srv.close(); await t.close(); }
});

test('#14 shrink 遇到不存在的檔案是 reject，不是未捕捉例外', async () => {
  const { shrink } = require('../server/worker');
  await assert.rejects(shrink(path.join(require('os').tmpdir(), 'no-such-photo-' + Date.now() + '.jpg')), /照片檔不存在/);
});

test('#15 retry：僅 failed、同品牌會計／admin；回 queued、attempts 歸零、清 error、寫 audit；辨識後回 review', async () => {
  let fail = true;
  const t = await startApp({ recognize: async () => { if (fail) throw new Error('boom'); return AI(); } });
  try {
    const st = await t.login('C01', PASS.SEED_PASS_C01);
    const up = await t.upload(st); const id = up.data.id;
    await t.app.worker.drain();
    const acc = await t.login('acc-c', PASS.SEED_PASS_ACC_C), accM = await t.login('acc-m', PASS.SEED_PASS_ACC_M);
    const f = t.app.db.prepare('SELECT status, attempts, error FROM slips WHERE id = ?').get(id);
    assert.strictEqual(f.status, 'failed'); assert.strictEqual(f.attempts, 3); assert.ok(f.error);
    assert.strictEqual((await t.call('POST', `/slips/${id}/retry`, { token: st })).error, 'FORBIDDEN');
    assert.strictEqual((await t.call('POST', `/slips/${id}/retry`, { token: accM })).error, 'FORBIDDEN');
    fail = false;
    t.app.worker.stop();                      // 不讓背景 kick 搶在斷言之前處理
    const r = await t.call('POST', `/slips/${id}/retry`, { token: acc });
    assert.strictEqual(r.ok, true);
    const q = t.app.db.prepare('SELECT status, attempts, error FROM slips WHERE id = ?').get(id);
    assert.deepStrictEqual({ s: q.status, a: q.attempts, e: q.error }, { s: 'queued', a: 0, e: null });
    assert.strictEqual((await t.call('POST', `/slips/${id}/retry`, { token: acc })).error, 'CONFLICT');   // 不再是 failed
    const acts = t.app.db.prepare('SELECT action FROM audit WHERE slip_id = ? ORDER BY id').all(id).map((x) => x.action);
    assert.ok(acts.includes('retry'));
  } finally { await t.close(); }
});

test('#16a／#19 PUT 人工日期：只收 YYYY-MM-DD 與民國格式；其他 BAD_INPUT，不改成拍照日', async () => {
  const t = await startApp({ recognize: async () => AI() });
  try {
    const { id, acc } = await reviewSlip(t);
    let p = await t.call('PUT', `/slips/${id}`, { token: acc, body: { doc_date: '115/10/03' } });
    assert.strictEqual(p.data.doc_date, '2026-10-03');
    p = await t.call('PUT', `/slips/${id}`, { token: acc, body: { doc_date: '115-09-30' } });
    assert.strictEqual(p.data.doc_date, '2026-09-30');
    p = await t.call('PUT', `/slips/${id}`, { token: acc, body: { doc_date: '2026-09-29' } });
    assert.strictEqual(p.data.doc_date, '2026-09-29');
    for (const bad of ['10/03/2026', '26-10-03', '', '亂寫', '0115-10-03', '2026-02-30']) {
      p = await t.call('PUT', `/slips/${id}`, { token: acc, body: { doc_date: bad } });
      assert.strictEqual(p.error, 'BAD_INPUT', bad); assert.match(p.message || '', /日期格式看不懂，請重新輸入/, bad);
      assert.strictEqual((await t.call('GET', `/slips/${id}`, { token: acc })).data.doc_date, '2026-09-29', bad);   // 沒被改動
    }
  } finally { await t.close(); }
});

test('#17 會計送出的日期（即使等於系統補的拍照日）視為人工確認 → 移除 DATE_FIXED', async () => {
  const t = await startApp({ recognize: async () => AI({ date: '' }) });
  try {
    const { id, acc, d } = await reviewSlip(t);
    assert.ok(d.flags.includes('DATE_FIXED'));
    const p = await t.call('PUT', `/slips/${id}`, { token: acc, body: { doc_date: d.doc_date } });   // 原樣送回
    assert.ok(!p.data.flags.includes('DATE_FIXED')); assert.strictEqual(p.data.date_note, null);
    assert.ok(!(await t.call('GET', `/slips/${id}`, { token: acc })).data.flags.includes('DATE_FIXED'));
  } finally { await t.close(); }
});

test('#20 date_note 存實際原因：兩位數年／讀不出／離太遠', async () => {
  const t = await startApp({ recognize: async () => AI({ date: '26-10-01' }) });
  try {
    const a = await reviewSlip(t);
    assert.ok(a.d.flags.includes('DATE_FIXED')); assert.strictEqual(a.d.date_note, '年份只有兩位數，暫用拍照日');
  } finally { await t.close(); }
});

test('#16b PUT 同一個明細列 id 出現兩次 → BAD_INPUT', async () => {
  const t = await startApp({ recognize: async () => AI({ total: '5400', lines: [{ name: '範例肉末', qty: '120', unit: '', unit_price: '45', amount: '5400' }] }) });
  try {
    const { id, acc, d } = await reviewSlip(t);
    const l = d.lines[0];
    const row = { id: l.id, raw_name: l.raw_name, qty: l.qty, unit: l.unit, unit_price: l.unit_price, amount: l.amount };
    const r = await t.call('PUT', `/slips/${id}`, { token: acc, body: { lines: [row, row] } });
    assert.strictEqual(r.error, 'BAD_INPUT');
    assert.strictEqual((await t.call('GET', `/slips/${id}`, { token: acc })).data.lines.length, 1);   // 交易回滾，沒少存
  } finally { await t.close(); }
});

test('#16c／#18 subtotal 只核對≈各列加總；總額＝加總＋稅額', async () => {
  const t = await startApp({ recognize: async () => AI({ total: '5400', lines: [{ name: '範例肉末', qty: '120', unit: '', unit_price: '45', amount: '5400' }] }) });
  try {
    const { id, acc } = await reviewSlip(t);
    let p = await t.call('PUT', `/slips/${id}`, { token: acc, body: { subtotal: 5400 } });
    assert.ok(!p.data.flags.includes('SUM_MISMATCH'));
    p = await t.call('PUT', `/slips/${id}`, { token: acc, body: { subtotal: 1234 } });   // subtotal 填錯
    assert.ok(p.data.flags.includes('SUM_MISMATCH'));
    p = await t.call('PUT', `/slips/${id}`, { token: acc, body: { subtotal: 5143, tax: 257 } });   // 舊的「列含稅」解讀不再成立
    assert.ok(p.data.flags.includes('SUM_MISMATCH'));
  } finally { await t.close(); }
});

test('#18 審查員反例：各列加總 4200、subtotal 4000、tax 200、total 4400 → SUM_MISMATCH', async () => {
  const t = await startApp({ recognize: async () => AI({ lines: [{ name: '範例茶葉', qty: '20', unit: '', unit_price: '210', amount: '4200' }], subtotal: '4000', tax: '200', total: '4400' }) });
  try {
    const { d } = await reviewSlip(t);
    assert.ok(d.flags.includes('SUM_MISMATCH'));
  } finally { await t.close(); }
});

test('#16d 2/29 等月日在拍照年與前一年都不存在 → date_note 如實說明', async () => {
  const t = await startApp({ recognize: async () => AI({ date: '2020-02-29' }) });
  try {
    const a = await reviewSlip(t);
    assert.ok(a.d.flags.includes('DATE_FIXED'));
    assert.match(a.d.date_note, /2\/29/); assert.doesNotMatch(a.d.date_note, /附近的年份/);
  } finally { await t.close(); }
});

test('#16f reopen 清掉殘留的 error', async () => {
  const t = await startApp({ recognize: async () => AI() });
  try {
    const { id, acc } = await reviewSlip(t);
    t.app.db.prepare("UPDATE slips SET error = '舊的辨識錯誤' WHERE id = ?").run(id);
    await t.call('POST', `/slips/${id}/return`, { token: acc, body: { reason: 'x' } });
    await t.call('POST', `/slips/${id}/reopen`, { token: acc });
    assert.strictEqual(t.app.db.prepare('SELECT error FROM slips WHERE id = ?').get(id).error, null);
  } finally { await t.close(); }
});
