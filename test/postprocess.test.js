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
test('DATE_FIXED：日期讀不出（如只有年月）→ 暫用拍照日', () => {
  const r = postprocess(mk({ date: '2026-09' }), SHOT, mapped);
  assert.strictEqual(r.doc_date, SHOT);
  assert.ok(r.flags.includes('DATE_FIXED'));
  assert.strictEqual(fixDate('', SHOT).fixed, true);
});
test('60 天內的日期不動', () => {
  assert.strictEqual(postprocess(mk({ date: '2026-08-10' }), SHOT, mapped).doc_date, '2026-08-10');
});

test('漏零：120×45 讀成 54 → 5400 並標 AMOUNT_FIXED（黃）', () => {
  const r = postprocess(mk({ lines: [L('範例肉末', '120', '45', '54')], total: '5400' }), SHOT, mapped);
  assert.strictEqual(r.lines[0].amount, 5400);
  assert.deepStrictEqual(r.lines[0].flags, ['AMOUNT_FIXED']);
  assert.deepStrictEqual(r.flags, []);                      // 加總 5400 = 總額，沒有 SUM_MISMATCH
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

test('缺單價：PRICE_MISSING（紅），不填入', () => {
  const r = postprocess(mk({ lines: [L('範例雞腿', '36', '', ''), L('範例空籃', '11', '', '')], total: '8888' }), SHOT, mapped);
  for (const l of r.lines) { assert.ok(l.flags.includes('PRICE_MISSING')); assert.strictEqual(l.unit_price, null); }
  assert.deepStrictEqual(r.flags, ['SUM_MISMATCH']);        // 有列沒金額：缺值本身就是紅，不跳過檢核
});

test('SUM_MISMATCH（紅）：各列加總 ≠ 總額', () => {
  const r = postprocess(mk({ lines: [L('a', '1', '100', '100'), L('b', '1', '50', '50')], total: '200' }), SHOT, mapped);
  assert.deepStrictEqual(r.flags, ['SUM_MISMATCH']);
});
test('加總 + 稅額 = 總額 不算 SUM_MISMATCH', () => {
  const r = postprocess(mk({ lines: [L('a', '20', '210', '4200')], tax: '210', total: '4410' }), SHOT, mapped);
  assert.deepStrictEqual(r.flags, []);
});

test('HANDWRITTEN（黃）：有手寫說明；「無」不算', () => {
  const r = postprocess(mk({ handwritten_changes: '加一件範例商品 333' }), SHOT, mapped);
  assert.deepStrictEqual(r.flags, ['HANDWRITTEN']);
  assert.strictEqual(r.total_handwritten, 1);
  assert.strictEqual(r.handwritten_note, '加一件範例商品 333');
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

test('#2 缺總額或任一列缺金額 → SUM_MISMATCH（不可跳過）', () => {
  assert.deepStrictEqual(postprocess(mk({ lines: [L('a', '1', '10', '10')], total: '' }), SHOT, mapped).flags, ['SUM_MISMATCH']);
  assert.deepStrictEqual(evaluate({ total: 10 }, [{ qty: 1, unit_price: 10, amount: 10, flags: [] }, { qty: 3, unit_price: 100, amount: null, flags: [] }], mapped).flags, ['SUM_MISMATCH']);
});

test('#6 postprocess：0／負數的數量、單價、金額視為讀不出', () => {
  const r = postprocess(mk({ lines: [L('a', '0', '-5', '0')], total: '0' }), SHOT, mapped);
  assert.strictEqual(r.lines[0].qty, null); assert.strictEqual(r.lines[0].unit_price, null); assert.strictEqual(r.lines[0].amount, null); assert.strictEqual(r.total, null);
  assert.ok(r.lines[0].flags.includes('PRICE_MISSING'));
});

test('#9 fixDate 讀不出時 reason=unreadable；離太遠 reason=far', () => {
  assert.strictEqual(fixDate('', SHOT).reason, 'unreadable');
  assert.strictEqual(fixDate('2025-09-30', SHOT).reason, 'far');
});

test('#10 跨年：12/30 的單 1/2 才拍，年份讀錯 → 取前一年的 12/30，不是拍照年', () => {
  for (const raw of ['2025-12-30', '2027-12-30', '2020-12-30']) {
    const r = fixDate(raw, '2027-01-02');
    assert.strictEqual(r.date, '2026-12-30', raw); assert.strictEqual(r.fixed, true);
  }
  assert.strictEqual(postprocess(mk({ date: '2026-12-30' }), '2027-01-02', mapped).doc_date, '2026-12-30');   // 60 天內不動
  // 今年的 12/30 比拍照日晚太多 → 取前一年
  assert.strictEqual(fixDate('2024-12-30', '2026-06-01').date, '2025-12-30');
  assert.strictEqual(fixDate('2025-05-30', '2026-06-01').date, '2026-05-30');
});

test('#12 HANDWRITTEN 依 handwritten_note 重算：清空即移除', () => {
  const lines = [{ qty: 1, unit_price: 10, amount: 10, flags: [], raw_name: 'a' }];
  assert.deepStrictEqual(evaluate({ total: 10, handwritten_note: '加一項', flags: ['HANDWRITTEN'] }, lines, mapped).flags, ['HANDWRITTEN']);
  assert.deepStrictEqual(evaluate({ total: 10, handwritten_note: '', flags: ['HANDWRITTEN'] }, lines, mapped).flags, []);
  assert.deepStrictEqual(evaluate({ total: 10, handwritten_note: null, flags: ['HANDWRITTEN'] }, lines, mapped).flags, []);
});
