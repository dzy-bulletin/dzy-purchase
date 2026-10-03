'use strict';
// 後處理檢核（程式做，不靠模型）。旗標代碼只用 plan.md 契約那 8 個。
const FLAG_ORDER = ['DATE_FIXED', 'AMOUNT_FIXED', 'AMOUNT_MISMATCH', 'SUM_MISMATCH', 'PRICE_MISSING', 'HANDWRITTEN', 'ITEM_UNMAPPED', 'UNIT_UNCONVERTED'];
const RED = new Set(['AMOUNT_MISMATCH', 'SUM_MISMATCH', 'PRICE_MISSING']);
const STICKY_LINE = ['AMOUNT_FIXED'];            // 歷史事實型旗標：重算時保留（人工改過該欄位則去掉）
const STICKY_SLIP = ['DATE_FIXED', 'HANDWRITTEN'];

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
// 日期校正：讀不出來或離拍照日 > 60 天 → 年份改成拍照日年份（DATE_FIXED）
function fixDate(raw, shotDate) {
  const shot = parseDate(shotDate);
  const p = parseDate(raw);
  if (!p) return { date: shotDate, fixed: true };
  const iso = (o) => `${o.y}-${pad(o.m)}-${pad(o.d)}`;
  const diff = Math.abs(Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(shot.y, shot.m - 1, shot.d)) / 86400e3;
  if (diff <= 60) return { date: iso(p), fixed: false };
  if (!validYmd(shot.y, p.m, p.d)) return { date: shotDate, fixed: true };
  return { date: iso({ y: shot.y, m: p.m, d: p.d }), fixed: true };
}

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
  const total = slip.total;
  if (total != null && outLines.length && outLines.every((l) => l.amount != null)) {
    const sum = round2(outLines.reduce((s, l) => s + l.amount, 0));
    const { subtotal: sub, tax } = slip;
    const ok = near(sum, total) || (tax != null && near(round2(sum + tax), total)) || (sub != null && tax != null && near(sum, sub) && near(round2(sub + tax), total));
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
    subtotal: parseNum(ai.subtotal), tax: parseNum(ai.tax), total: parseNum(ai.total),
    total_handwritten: hand ? 1 : 0, handwritten_note: hand,
    flags: [].concat(d.fixed ? ['DATE_FIXED'] : [], hand ? ['HANDWRITTEN'] : [])
  };
  const rawLines = (Array.isArray(ai.lines) ? ai.lines : []).filter((x) => x && typeof x === 'object');
  const lines = rawLines.map((x, i) => {
    let qty = parseNum(x.qty), price = parseNum(x.unit_price), amt = parseNum(x.amount);
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
