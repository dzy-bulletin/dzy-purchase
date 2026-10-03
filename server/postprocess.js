'use strict';
// 後處理檢核（程式做，不靠模型）。旗標代碼只用 plan.md 契約那 8 個。
const FLAG_ORDER = ['DATE_FIXED', 'AMOUNT_FIXED', 'AMOUNT_MISMATCH', 'SUM_MISMATCH', 'PRICE_MISSING', 'HANDWRITTEN', 'ITEM_UNMAPPED', 'UNIT_UNCONVERTED'];
const RED = new Set(['AMOUNT_MISMATCH', 'SUM_MISMATCH', 'PRICE_MISSING']);
const STICKY_LINE = ['AMOUNT_FIXED'];            // 歷史事實型旗標：重算時保留（人工改過該欄位則去掉）
const STICKY_SLIP = ['DATE_FIXED'];   // HANDWRITTEN 不 sticky：依 handwritten_note 是否有內容重算

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const near = (a, b) => Math.abs(a - b) < 0.01;
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
  let y = Number(m[1]); if (y < 1000) y += 1911;
  const mo = Number(m[2]), d = Number(m[3]);
  return validYmd(y, mo, d) ? { y, m: mo, d } : null;
}
// 日期校正：讀不出來 → 暫用拍照日（DATE_FIXED）；離拍照日 > 60 天 → 在「拍照年」與「拍照年−1」中，
// 取離拍照日最近且不晚於拍照日 7 天者；都不合就用拍照日（DATE_FIXED）
function fixDate(raw, shotDate) {
  const shot = parseDate(shotDate);
  const p = parseDate(raw);
  if (!p) return { date: shotDate, fixed: true, reason: 'unreadable' };
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
  if (!best) return { date: shotDate, fixed: true, reason: 'far' };
  return { date: iso({ y: best.y, m: p.m, d: p.d }), fixed: true, reason: 'far' };
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
    else if (qty != null && a != null && !near(round2(qty * p), a)) f.add('AMOUNT_MISMATCH');
    const item = resolve(l);
    if (!item) f.add('ITEM_UNMAPPED');
    else if (l.unit && item.base_unit && l.unit !== item.base_unit && !hasConv(item.id, l.unit)) f.add('UNIT_UNCONVERTED');
    return Object.assign({}, l, { flags: sortFlags(f) });
  });
  const sf = new Set();
  for (const k of STICKY_SLIP) if ((slip.flags || []).includes(k)) sf.add(k);
  if (handwrittenText(slip.handwritten_note)) sf.add('HANDWRITTEN');
  const total = slip.total;
  if (outLines.length && (total == null || outLines.some((l) => l.amount == null))) sf.add('SUM_MISMATCH');   // 缺值本身就是紅，不可跳過檢核
  else if (outLines.length) {
    const sum = round2(outLines.reduce((s, l) => s + l.amount, 0));
    const { subtotal: sub, tax } = slip;
    const subOk = sub == null || near(sum, sub) || (tax != null && near(round2(sub + tax), sum));   // 有未稅合計就要對得上各列加總（列金額是未稅，或已含稅）
    const ok = subOk && (near(sum, total) || (tax != null && near(round2(sum + tax), total)) || (sub != null && tax != null && near(sum, sub) && near(round2(sub + tax), total)));
    if (!ok) sf.add('SUM_MISMATCH');
  }
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
    total_handwritten: hand ? 1 : 0, handwritten_note: hand,
    flags: [].concat(d.fixed ? ['DATE_FIXED'] : [], hand ? ['HANDWRITTEN'] : [])
  };
  const rawLines = (Array.isArray(ai.lines) ? ai.lines : []).filter((x) => x && typeof x === 'object');
  const lines = rawLines.map((x, i) => {
    let qty = pos(parseNum(x.qty)), price = pos(parseNum(x.unit_price)), amt = pos(parseNum(x.amount));
    const flags = [];
    if (qty != null && price != null) {
      const calc = round2(qty * price);
      if (amt == null) amt = calc;
      else if (!near(calc, amt) && amt > 0 && calc > amt && Number.isInteger(amt)
               && String(Math.round(calc)).startsWith(String(amt))) { amt = calc; flags.push('AMOUNT_FIXED'); }   // 漏零
    }
    return { seq: i + 1, raw_name: String(x.name == null ? '' : x.name).trim(), item_id: null, qty, unit: String(x.unit == null ? '' : x.unit).trim(),
             unit_price: price, amount: amt, flags, checked: 0, edited_by_human: 0 };
  });
  const r = evaluate(slip, lines, ctx);
  return Object.assign(slip, { flags: r.flags, lines: r.lines });
}

module.exports = { postprocess, evaluate, parseNum, parseDate, fixDate, round2, near, hasRed, RED, FLAG_ORDER };
