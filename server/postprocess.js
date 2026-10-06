'use strict';
// 後處理檢核（程式做，不靠模型）。旗標代碼只用 plan.md 契約那 8 個。
const FLAG_ORDER = ['DATE_FIXED', 'AMOUNT_FIXED', 'AMOUNT_MISMATCH', 'SUM_MISMATCH', 'PRICE_MISSING', 'HANDWRITTEN', 'ITEM_UNMAPPED', 'UNIT_UNCONVERTED'];
const RED = new Set(['AMOUNT_MISMATCH', 'SUM_MISMATCH', 'PRICE_MISSING']);
const STICKY_LINE = ['AMOUNT_FIXED'];            // 歷史事實型旗標：重算時保留（人工改過該欄位則去掉）
const STICKY_SLIP = ['DATE_FIXED'];   // HANDWRITTEN 不 sticky：依 handwritten_note 是否有內容重算

const { round2, near, moneyEq, sumCheck } = require('../web/js/rules');
const { normText } = require('./slips-common');   // 前後端共用同一份總額規則
const sortFlags = (set) => FLAG_ORDER.filter((f) => set.has(f));
const hasRed = (flags) => flags.some((f) => RED.has(f));

function parseNum(x) {
  if (x === null || x === undefined || typeof x === 'boolean') return null;
  if (typeof x === 'number') return Number.isFinite(x) ? round2(x) : null;
  const s = String(x).normalize('NFKC').replace(/[,，\s]/g, '');
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  return m ? round2(Number(m[0])) : null;
}

const pad = (n) => String(n).padStart(2, '0');
function validYmd(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
// 回傳 {y,m,d}（已把民國年 +1911）或 null
function parseDate(raw) {
  const s = String(raw == null ? '' : raw).normalize('NFKC');
  let m = /(\d{1,4})\s*[^\d\s]\s*(\d{1,2})\s*[^\d\s]\s*(\d{1,2})/.exec(s) || /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/.exec(s);
  if (!m) return null;
  if (m[1].length < 3) return null;                  // 兩位數年無法判讀（不猜）
  let y = Number(m[1]); if (y < 1000) y += 1911;     // 三位數年＝民國
  const mo = Number(m[2]), d = Number(m[3]);
  return validYmd(y, mo, d) ? { y, m: mo, d } : null;
}
// 日期校正：讀不出來 → 暫用拍照日（DATE_FIXED）；離拍照日 > 60 天 → 在「拍照年」與「拍照年−1」中，
// 取離拍照日最近且不晚於拍照日 7 天者；都不合就用拍照日（DATE_FIXED）
function fixDate(raw, shotDate) {
  const shot = parseDate(shotDate);
  const p = parseDate(raw);
  if (!p) {
    const two = /(?<!\d)\d{1,2}\s*[^\d\s]\s*\d{1,2}\s*[^\d\s]\s*\d{1,2}(?!\d)/.test(String(raw == null ? '' : raw).normalize('NFKC'));
    return { date: shotDate, fixed: true, reason: 'unreadable', note: two ? '年份只有兩位數，暫用拍照日' : '日期讀不出，暫用拍照日' };
  }
  const iso = (o) => `${o.y}-${pad(o.m)}-${pad(o.d)}`;
  const day = (y, m, d) => Date.UTC(y, m - 1, d) / 86400e3;
  const shotDay = day(shot.y, shot.m, shot.d);
  if (Math.abs(day(p.y, p.m, p.d) - shotDay) <= 60) return { date: iso(p), fixed: false };
  let best = null;
  for (const y of [shot.y, shot.y - 1]) {
    if (!validYmd(y, p.m, p.d)) continue;
    const diff = day(y, p.m, p.d) - shotDay;
    if (diff > 7) continue;
    if (!best || Math.abs(diff) < best.abs) best = { y, abs: Math.abs(diff) };
  }
  if (!best) return { date: shotDate, fixed: true, reason: 'far', note: '日期的月日在拍照年與前一年都不存在（例如 2/29），暫用拍照日' };
  return { date: iso({ y: best.y, m: p.m, d: p.d }), fixed: true, reason: 'far', note: '年份離拍照日太遠，已改用拍照日附近的年份' };
}

// 人工輸入日期：只收 YYYY-MM-DD 與民國 YYY-MM-DD／YYY/MM/DD；其他回 null（呼叫端回 BAD_INPUT）
function parseManualDate(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t), y;
  if (m) y = Number(m[1]);
  else if ((m = /^(\d{3})([-/])(\d{2})\2(\d{2})$/.exec(t))) { y = Number(m[1]) + 1911; m = [null, null, m[3], m[4]]; }
  else return null;
  const mo = Number(m[2]), d = Number(m[3]);
  if (y < 2000 || y > 2100 || !validYmd(y, mo, d)) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

const pos = (n) => (n != null && n > 0 ? n : null);   // 數量／單價／金額／總額必須 > 0，其餘視為讀不出
const NO_HAND = new Set(['', '無', '无', '沒有', '没有', '無手寫', '無修改', '無手寫修改', 'none', 'null', 'n/a', 'na', '-', '無手寫修改說明']);
function handwrittenText(x) {
  const s = String(x == null ? '' : x).trim();
  return NO_HAND.has(s.toLowerCase()) ? '' : s;
}

// 檢核（計算型旗標）：lines 是 {raw_name, item_id, qty, unit, unit_price, amount, flags(舊), edited}。
// ctx.resolveItem(line) → {id, base_unit} | null；ctx.hasConv(itemId, unit) → bool
function evaluate(slip, lines, ctx) {
  ctx = ctx || {};
  const resolve = ctx.resolveItem || (() => null);
  const hasConv = ctx.hasConv || (() => false);
  const outLines = lines.map((l) => {
    const f = new Set();
    for (const k of STICKY_LINE) if ((l.flags || []).includes(k)) f.add(k);
    const { qty, unit_price: p, amount: a } = l;
    if (p == null) f.add('PRICE_MISSING');
    else if (qty != null && a != null && !moneyEq(qty * p, a)) f.add('AMOUNT_MISMATCH');   // 四捨五入後相符就不算錯
    const item = resolve(l);
    if (!item) f.add('ITEM_UNMAPPED');
    else if (!l.unit || (l.unit !== item.base_unit && !hasConv(item.id, l.unit))) f.add('UNIT_UNCONVERTED');   // 空白單位＝查不到換算（與 calc.factorOf 同一判斷）
    return Object.assign({}, l, { item_id: l.item_id != null ? l.item_id : (item ? item.id : null), flags: sortFlags(f) });
  });
  const sf = new Set();
  for (const k of STICKY_SLIP) if ((slip.flags || []).includes(k)) sf.add(k);
  if (handwrittenText(slip.handwritten_note)) sf.add('HANDWRITTEN');
  // 總額規則（plan.md 共用契約）：各列加總＋稅額（空白＝0）＝總額；subtotal 只核對≈各列加總。缺值本身就是紅。
  if (outLines.length && !sumCheck(outLines.map((l) => l.amount), slip.subtotal, slip.tax, slip.total, slip.tax_included ? 1 : 0).ok) sf.add('SUM_MISMATCH');
  return { lines: outLines, flags: sortFlags(sf) };
}

// 模型輸出（字串 JSON 物件）→ 可存進資料庫的結構。shotDate＝拍照日 YYYY-MM-DD
function postprocess(ai, shotDate, ctx) {
  ai = ai || {};
  const d = fixDate(ai.date, shotDate);
  const hand = handwrittenText(ai.handwritten_changes);
  const slip = {
    doc_date: d.date, doc_no: String(ai.doc_no == null ? '' : ai.doc_no).trim(),
    vendor_name: String(ai.vendor == null ? '' : ai.vendor).trim(),
    subtotal: pos(parseNum(ai.subtotal)), tax: pos(parseNum(ai.tax)), total: pos(parseNum(ai.total)),
    total_handwritten: hand ? 1 : 0, handwritten_note: hand, tax_included: ctx && ctx.taxIncluded ? 1 : 0,
    flags: [].concat(d.fixed ? ['DATE_FIXED'] : [], hand ? ['HANDWRITTEN'] : [])
  };
  const rawLines = (Array.isArray(ai.lines) ? ai.lines : []).filter((x) => x && typeof x === 'object');
  const lines = rawLines.map((x, i) => {
    let qty = pos(parseNum(x.qty)), price = pos(parseNum(x.unit_price)), amt = pos(parseNum(x.amount));
    const flags = [];
    if (qty != null && price != null) {
      const calc = round2(qty * price);
      if (amt == null) amt = calc;
      else if (!moneyEq(qty * price, amt) && amt > 0 && calc > amt && Number.isInteger(amt)
               && String(Math.round(calc)).startsWith(String(amt))) { amt = calc; flags.push('AMOUNT_FIXED'); }   // 漏零
    }
    return { seq: i + 1, raw_name: normText(x.name, 200), item_id: null, qty, unit: normText(x.unit, 20),
             unit_price: price, amount: amt, flags, checked: 0, edited_by_human: 0 };
  });
  const r = evaluate(slip, lines, ctx);
  return Object.assign(slip, { flags: r.flags, lines: r.lines, date_note: d.fixed ? d.note : null });
}

module.exports = { postprocess, evaluate, parseNum, parseDate, parseManualDate, fixDate, round2, near, hasRed, RED, FLAG_ORDER };
