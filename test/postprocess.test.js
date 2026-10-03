'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { postprocess, evaluate, parseDate, fixDate, FLAG_ORDER } = require('../server/postprocess');

const SHOT = '2026-10-03';
const mk = (o) => Object.assign({ vendor: 'V', date: '2026-10-01', doc_no: '1', lines: [], subtotal: '', tax: '', total: '', handwritten_changes: '' }, o);
const L = (name, qty, unit_price, amount, unit) => ({ name, qty, unit: unit || '', unit_price, amount });
const mapped = { resolveItem: () => ({ id: 1, base_unit: '公斤' }), hasConv: () => true };

test('契約旗標表正好 8 個', () => {
  assert.deepStrictEqual(FLAG_ORDER, ['DATE_FIXED', 'AMOUNT_FIXED', 'AMOUNT_MISMATCH', 'SUM_MISMATCH', 'PRICE_MISSING', 'HANDWRITTEN', 'ITEM_UNMAPPED', 'UNIT_UNCONVERTED']);
});

test('民國年：115/10/03 → 2026-10-03，不標 DATE_FIXED', () => {
  const r = postprocess(mk({ date: '115/10/03' }), SHOT, mapped);
  assert.strictEqual(r.doc_date, '2026-10-03');
  assert.ok(!r.flags.includes('DATE_FIXED'));
  assert.strictEqual(parseDate('民國115年9月2日').y, 2026);
});

test('DATE_FIXED：年份離拍照日太遠 → 改成拍照日年份', () => {
  const r = postprocess(mk({ date: '2025-09-30' }), SHOT, mapped);
  assert.strictEqual(r.doc_date, '2026-09-30');
  assert.deepStrictEqual(r.flags, ['DATE_FIXED']);
});
test('DATE_FIXED：日期讀不出（如只有年月）→ 用拍照日', () => {
  const r = postprocess(mk({ date: '2026-09' }), SHOT, mapped);
  assert.strictEqual(r.doc_date, SHOT);
  assert.ok(r.flags.includes('DATE_FIXED'));
  assert.strictEqual(fixDate('', SHOT).fixed, true);
});
test('60 天內的日期不動', () => {
  assert.strictEqual(postprocess(mk({ date: '2026-08-10' }), SHOT, mapped).doc_date, '2026-08-10');
});

test('p1 類漏零：300×68 讀成 204 → 20400 並標 AMOUNT_FIXED（黃）', () => {
  const r = postprocess(mk({ lines: [L('絞肉', '300', '68', '204')], total: '20400' }), SHOT, mapped);
  assert.strictEqual(r.lines[0].amount, 20400);
  assert.deepStrictEqual(r.lines[0].flags, ['AMOUNT_FIXED']);
  assert.deepStrictEqual(r.flags, []);                      // 加總 20400 = 總額，沒有 SUM_MISMATCH
});

test('AMOUNT_MISMATCH（紅）：對不起來又不是漏零，不改', () => {
  const r = postprocess(mk({ lines: [L('a', '10', '5', '77')], total: '77' }), SHOT, mapped);
  assert.strictEqual(r.lines[0].amount, 77);
  assert.deepStrictEqual(r.lines[0].flags, ['AMOUNT_MISMATCH']);
});

test('金額缺但有數量與單價 → 補算，不標旗標', () => {
  const r = postprocess(mk({ lines: [L('a', '4', '2.5', '')], total: '10' }), SHOT, mapped);
  assert.strictEqual(r.lines[0].amount, 10);
  assert.deepStrictEqual(r.lines[0].flags, []);
});

test('p6 類缺單價：PRICE_MISSING（紅），不填入', () => {
  const r = postprocess(mk({ lines: [L('T7帶皮腿肉', '108', '', ''), L('空籃', '11', '', '')], total: '50850' }), SHOT, mapped);
  for (const l of r.lines) { assert.ok(l.flags.includes('PRICE_MISSING')); assert.strictEqual(l.unit_price, null); }
  assert.deepStrictEqual(r.flags, []);                      // 有列沒金額 → 不做加總比對
});

test('SUM_MISMATCH（紅）：各列加總 ≠ 總額', () => {
  const r = postprocess(mk({ lines: [L('a', '1', '100', '100'), L('b', '1', '50', '50')], total: '200' }), SHOT, mapped);
  assert.deepStrictEqual(r.flags, ['SUM_MISMATCH']);
});
test('加總 + 稅額 = 總額 不算 SUM_MISMATCH', () => {
  const r = postprocess(mk({ lines: [L('a', '30', '170', '5100')], tax: '255', total: '5355' }), SHOT, mapped);
  assert.deepStrictEqual(r.flags, []);
});

test('HANDWRITTEN（黃）：有手寫說明；「無」不算', () => {
  const r = postprocess(mk({ handwritten_changes: '加一桶豬油 1600' }), SHOT, mapped);
  assert.deepStrictEqual(r.flags, ['HANDWRITTEN']);
  assert.strictEqual(r.total_handwritten, 1);
  assert.strictEqual(r.handwritten_note, '加一桶豬油 1600');
  assert.deepStrictEqual(postprocess(mk({ handwritten_changes: '無' }), SHOT, mapped).flags, []);
});

test('ITEM_UNMAPPED（黃）：沒對到統一品名；對到就沒有', () => {
  const r = postprocess(mk({ lines: [L('a', '1', '10', '10')], total: '10' }), SHOT, {});
  assert.deepStrictEqual(r.lines[0].flags, ['ITEM_UNMAPPED']);
  assert.deepStrictEqual(postprocess(mk({ lines: [L('a', '1', '10', '10')], total: '10' }), SHOT, mapped).lines[0].flags, []);
});

test('UNIT_UNCONVERTED（黃）：單位不是統一單位又沒設換算', () => {
  const ctx = { resolveItem: () => ({ id: 1, base_unit: '公斤' }), hasConv: () => false };
  const r = postprocess(mk({ lines: [L('a', '1', '10', '10', '台斤')], total: '10' }), SHOT, ctx);
  assert.deepStrictEqual(r.lines[0].flags, ['UNIT_UNCONVERTED']);
  assert.deepStrictEqual(postprocess(mk({ lines: [L('a', '1', '10', '10', '公斤')], total: '10' }), SHOT, ctx).lines[0].flags, []);
});

test('數字格式：千分位、全形、單位黏在一起', () => {
  const r = postprocess(mk({ lines: [L('a', '１,000kg', 'NT$ 1.5', '1,500')], total: '1,500' }), SHOT, mapped);
  assert.strictEqual(r.lines[0].qty, 1000); assert.strictEqual(r.lines[0].unit_price, 1.5); assert.strictEqual(r.total, 1500);
});

test('evaluate 重算：保留 AMOUNT_FIXED／DATE_FIXED 等歷史旗標，重算計算型旗標', () => {
  const r = evaluate({ total: 100, flags: ['DATE_FIXED'] }, [{ qty: 1, unit_price: 100, amount: 100, flags: ['AMOUNT_FIXED', 'PRICE_MISSING'], raw_name: 'a' }], mapped);
  assert.deepStrictEqual(r.lines[0].flags, ['AMOUNT_FIXED']);
  assert.deepStrictEqual(r.flags, ['DATE_FIXED']);
});
