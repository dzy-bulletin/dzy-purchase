'use strict';
// P4：create-accounts.js 互動核心（注入假輸入；全部虛構密碼）
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../server/db');
const { verifyPassword } = require('../server/auth');
const { run } = require('../server/tools/create-accounts');

const mkIo = (answers, hidden) => { const out = []; return { out: (s) => out.push(s), ask: async () => (answers.length ? answers.shift() : ''), askHidden: async () => hidden.shift(), lines: out }; };

test('P4 create-accounts：建立 5 門市＋2 會計＋admin；會計品牌 C＋X／M；密碼不出現在輸出；重跑冪等', async () => {
  const db = openDb(':memory:');
  const pws = []; for (let i = 0; i < 8; i++) pws.push('pw-test-' + i, 'pw-test-' + i);   // 每個帳號輸入兩次
  const io = mkIo([], pws);
  const r = await run(db, io, {});
  assert.deepStrictEqual(r.created, ['CF', 'MDGF', 'MZTGF', 'MZTZS', 'MZTLZL', 'acc-wu', 'acc-zhang', 'admin']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM stores').get().c, 5);
  assert.strictEqual(db.prepare("SELECT brand_id FROM stores WHERE code='MDGF'").get().brand_id, 'X');
  assert.strictEqual(db.prepare("SELECT brand_id FROM stores WHERE code='CF'").get().brand_id, 'C');
  const wu = db.prepare("SELECT * FROM users WHERE username='acc-wu'").get();
  assert.deepStrictEqual(db.prepare('SELECT brand_id FROM user_brands WHERE user_id=? ORDER BY brand_id').all(wu.id).map((x) => x.brand_id), ['C', 'X']);
  assert.strictEqual(wu.brand_id, 'C'); assert.strictEqual(wu.name, '吳佳宜');
  const zh = db.prepare("SELECT * FROM users WHERE username='acc-zhang'").get();
  assert.deepStrictEqual(db.prepare('SELECT brand_id FROM user_brands WHERE user_id=?').all(zh.id).map((x) => x.brand_id), ['M']);
  assert.strictEqual(db.prepare("SELECT role, brand_id FROM users WHERE username='admin'").get().role, 'admin');
  assert.ok(verifyPassword('pw-test-0', db.prepare("SELECT pass_hash FROM stores WHERE code='CF'").get().pass_hash));
  assert.ok(!io.lines.join('\n').includes('pw-test-'), '輸出不得含密碼');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes('pw-test-'), 'audit 不得含密碼');
  // 重跑：全部「已存在」，預設跳過（不問密碼）
  const io2 = mkIo([], []);
  const r2 = await run(db, io2, {});
  assert.deepStrictEqual(r2.created, []); assert.strictEqual(r2.skipped.length, 8);
  // 重設其中一個（CF 答 y，其餘 N）
  const io3 = mkIo(['y'], ['new-pass-1', 'new-pass-1']);
  const r3 = await run(db, io3, { only: 'stores' });
  assert.deepStrictEqual(r3.reset, ['CF']);
  assert.ok(verifyPassword('new-pass-1', db.prepare("SELECT pass_hash FROM stores WHERE code='CF'").get().pass_hash));
  db.close();
});

test('P4 create-accounts：密碼太短或兩次不一致會重問；--list 不問密碼；缺品牌權限會補', async () => {
  const db = openDb(':memory:');
  const io = mkIo(['n'], ['123', 'good-pass-1', 'oops-pass-1', 'good-pass-1', 'good-pass-1']);   // CF：太短→重問；兩次不一致→重問；最後一致
  await run(db, io, { only: 'stores' }).catch(() => {});
  assert.ok(io.lines.some((l) => l.includes('至少')) && io.lines.some((l) => l.includes('兩次不一樣')));
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM stores WHERE code='CF'").get().c, 1);
  const lst = mkIo([], []); await run(db, lst, { list: true });
  assert.ok(lst.lines.some((l) => l.startsWith('  CF') && l.includes('已建立')) && lst.lines.some((l) => l.includes('MDGF') && l.includes('尚未建立')));
  // 既有單品牌 acc-wu → 補上 X
  db.prepare("INSERT INTO users (username, role, brand_id, name, pass_hash) VALUES ('acc-wu','accountant','C','吳佳宜','x')").run();
  const uid = db.prepare("SELECT id FROM users WHERE username='acc-wu'").get().id;
  db.prepare("INSERT INTO user_brands (user_id, brand_id) VALUES (?, 'C')").run(uid);
  const io2 = mkIo(['acc-wu', 'n', ''], ['pw-zhang-1', 'pw-zhang-1']);
  const r = await run(db, io2, { only: 'accountants' });
  assert.deepStrictEqual(r.brandsFixed, ['acc-wu+X']);
  db.close();
});
