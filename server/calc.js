'use strict';
// 計算核心（plan.md「P2 共用契約」）：統一單位數量、當次單價、加權平均、食材成本、價格變動。
// 報表、提醒、匯出都只呼叫這支，公式不在別處重寫。金額內部用「分」（整數）累加，避免浮點誤差。
const { round2 } = require('../web/js/rules');

const CATEGORIES = ['食材', '包材', '雜貨', '其他'];
const COST_CATS = CATEGORIES.concat(['未分類']);
const cents = (x) => Math.round((x + Number.EPSILON) * 100);
const fromCents = (c) => c / 100;

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

// 期間：month 該月 1 日～月底；months=3 → 含該月往前共 3 個曆月
function periodOf(month, months) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const k = (months || 1) - 1;
  const idx = y * 12 + (m - 1) - k;
  const fy = Math.floor(idx / 12), fm = (idx % 12) + 1;
  return { from: `${fy}-${pad(fm)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
}

function convMap(db) {
  const map = new Map();
  for (const r of db.prepare('SELECT item_id, unit, factor_to_base f FROM unit_conv').all()) map.set(`${r.item_id}|${r.unit}`, r.f);
  return map;
}
// 換算係數；查不到回 null。契約：只有 unit 與 base_unit 相同時 factor=1；空白單位一律視為查不到（與 postprocess.evaluate 同一判斷）
function factorOf(conv, itemId, unit, baseUnit) {
  if (!unit) return null;
  if (unit === baseUnit) return 1;
  const f = conv.get(`${itemId}|${unit}`);
  return f > 0 ? f : null;
}

// 載入已入帳明細（含換算結果）。opts: brandId, from, to, storeId, itemId, excludeSlipId
function confirmedLines(db, opts) {
  const w = ["s.status = 'confirmed'"], a = [];
  if (opts.brandId) { w.push('s.brand_id = ?'); a.push(opts.brandId); }
  if (opts.from) { w.push('s.doc_date >= ?'); a.push(opts.from); }
  if (opts.to) { w.push('s.doc_date <= ?'); a.push(opts.to); }
  if (opts.storeId) { w.push('s.store_id = ?'); a.push(opts.storeId); }
  if (opts.itemId) { w.push('l.item_id = ?'); a.push(opts.itemId); }
  if (opts.slipId) { w.push('s.id = ?'); a.push(opts.slipId); }
  if (opts.excludeSlipId) { w.push('s.id <> ?'); a.push(opts.excludeSlipId); }
  const rows = db.prepare(`SELECT l.id line_id, l.seq, l.slip_id, l.raw_name, l.item_id, l.qty, l.unit, l.unit_price, l.amount,
      s.doc_date, s.confirmed_at, s.store_id, s.vendor_id, s.vendor_name_raw, s.brand_id, s.tax, s.total, s.tax_included,
      i.name item_name, i.category, i.base_unit
    FROM slip_lines l JOIN slips s ON s.id = l.slip_id LEFT JOIN items i ON i.id = l.item_id
    WHERE ${w.join(' AND ')} ORDER BY s.doc_date, s.confirmed_at, s.id, l.seq`).all(...a);
  const conv = convMap(db);
  return rows.map((r) => withBase(r, conv));
}

// 補上 base_qty／unit_cost／converted。沒有 item_id 或查不到換算 → converted=false，兩者為 null
function withBase(r, conv) {
  let f = null;
  if (r.item_id != null) f = factorOf(conv, r.item_id, r.unit, r.base_unit);
  const ok = f != null && r.qty > 0 && r.amount != null;
  const base = ok ? r.qty * f : null;
  // 單價比較基準一律未稅：tax_included=1 的單，未稅金額＝金額 × (總額−稅額)÷總額；稅額空白或總額 0 → 1:1
  const net = r.amount == null ? null : r.amount * netRatio(r);
  return Object.assign({}, r, { converted: ok, base_qty: ok ? Math.round(base * 10000) / 10000 : null, net_amount: net, unit_cost: ok ? round2(net / base) : null });
}
function netRatio(s) {
  if (!s.tax_included || s.tax == null || !(s.total > 0)) return 1;
  return (s.total - s.tax) / s.total;
}

// 加權平均 avg = Σamount ÷ Σbase_qty（只算已換算的列）；無資料回 null
function weightedAvg(lines) {
  let amt = 0, qty = 0;
  for (const l of lines) if (l.converted) { amt += cents(l.net_amount); qty += l.base_qty; }
  return qty > 0 ? round2(fromCents(amt) / qty) : null;
}
function avgFor(db, brandId, itemId, month, months) {
  const p = periodOf(month, months);
  return weightedAvg(confirmedLines(db, { brandId, itemId, from: p.from, to: p.to }));
}

// 稅額依各列金額比例分攤回類別；最後一類吃尾差，確保類別合計＝各列加總＋稅額。入出都是「分」
function allocateTax(catCents, taxCents) {
  const out = Object.assign({}, catCents);
  const cats = COST_CATS.filter((c) => catCents[c] > 0);
  const sum = cats.reduce((s, c) => s + catCents[c], 0);
  if (!taxCents) return out;
  if (!cats.length || sum <= 0) { out['未分類'] += taxCents; return out; }     // 各列金額都是 0 但有稅額：稅額歸「未分類」，類別合計仍＝總額（P3 審查 #11）
  let used = 0;
  cats.forEach((c, i) => {
    const share = i === cats.length - 1 ? taxCents - used : Math.round(taxCents * catCents[c] / sum);
    used += share; out[c] += share;
  });
  return out;
}

// 食材成本：已入帳列的 amount 依類別加總，稅額分攤回類別。回傳 slips（每張的類別分攤）供其他報表重用
function slipCosts(db, opts) {
  const lines = confirmedLines(db, opts);
  const bySlip = new Map();
  for (const l of lines) {
    let s = bySlip.get(l.slip_id);
    if (!s) { s = { slip_id: l.slip_id, doc_date: l.doc_date, store_id: l.store_id, vendor_id: l.vendor_id, vendor_name_raw: l.vendor_name_raw, brand_id: l.brand_id, tax: l.tax || 0, tax_included: l.tax_included ? 1 : 0, cats: {} }; COST_CATS.forEach((c) => { s.cats[c] = 0; }); bySlip.set(l.slip_id, s); }
    s.cats[CATEGORIES.includes(l.category) ? l.category : '未分類'] += cents(l.amount || 0);
  }
  const out = [];
  for (const s of bySlip.values()) {
    const cats = s.tax_included ? s.cats : allocateTax(s.cats, cents(s.tax));   // 已含稅：各列金額加總＝總額，稅額不再分攤
    out.push(Object.assign(s, { cats, total_cents: COST_CATS.reduce((t, c) => t + cats[c], 0) }));
  }
  return out;
}

function costReport(db, opts) {
  const p = periodOf(opts.month, 1);
  const slips = slipCosts(db, { brandId: opts.brandId, storeId: opts.storeId, from: p.from, to: p.to });
  const cat = {}; COST_CATS.forEach((c) => { cat[c] = 0; });
  const vendors = new Map(), stores = new Map();
  let total = 0;
  for (const s of slips) {
    COST_CATS.forEach((c) => { cat[c] += s.cats[c]; });
    total += s.total_cents;
    const vn = (s.vendor_id && (db.prepare('SELECT name FROM vendors WHERE id = ?').get(s.vendor_id) || {}).name) || s.vendor_name_raw || '（未指定廠商）';
    const vk = `${s.vendor_id || ''}\t${vn}`;
    vendors.set(vk, (vendors.get(vk) || 0) + s.total_cents);
    const sn = (db.prepare('SELECT name FROM stores WHERE id = ?').get(s.store_id) || {}).name || String(s.store_id);
    const sk = `${s.store_id}\t${sn}`;
    stores.set(sk, (stores.get(sk) || 0) + s.total_cents);
  }
  const list = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const by_category = {}; COST_CATS.forEach((c) => { by_category[c] = fromCents(cat[c]); });
  return { total: fromCents(total), by_category,
    by_vendor: list(vendors).map(([k, c]) => { const [id, vendor] = k.split('\t'); return { vendor_id: id ? Number(id) : null, vendor, amount: fromCents(c) }; }),
    by_store: list(stores).map(([k, c]) => { const [id, store] = k.split('\t'); return { store_id: Number(id), store, amount: fromCents(c) }; }) };
}

// 價格變動：入帳時呼叫。每列（有 item_id 且已換算）跟「同品牌同品項、排在本張之前的最近一筆已入帳列」比
function generatePriceAlerts(db, slipId, createdAt) {
  const s = db.prepare('SELECT * FROM slips WHERE id = ?').get(slipId);
  if (!s || s.status !== 'confirmed') return 0;
  const mine = confirmedLines(db, { brandId: s.brand_id, slipId }).filter((l) => l.converted);
  const key = (l) => [l.doc_date || '', l.confirmed_at || '', l.slip_id, String(l.seq).padStart(6, '0')].join('|');
  const ins = db.prepare('INSERT INTO price_alerts (line_id, item_id, vendor_id, store_id, prev_price, new_price, pct, direction, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  let n = 0;
  for (const l of mine) {
    const prevs = confirmedLines(db, { brandId: s.brand_id, itemId: l.item_id, excludeSlipId: slipId }).filter((x) => x.converted && key(x) < key(l));
    if (!prevs.length) continue;                                     // 第一次進貨不提醒
    const prev = prevs.reduce((a, b) => (key(b) > key(a) ? b : a));
    if (!(prev.unit_cost > 0) || Math.abs(cents(l.unit_cost) - cents(prev.unit_cost)) < 1) continue;   // 以「分」比，避免 38.01-38 浮點誤差變成 0.00999
    const pct = Math.round(((l.unit_cost - prev.unit_cost) / prev.unit_cost) * 1000) / 10;
    ins.run(l.line_id, l.item_id, s.vendor_id, s.store_id, prev.unit_cost, l.unit_cost, pct, l.unit_cost > prev.unit_cost ? 'up' : 'down', createdAt);
    n++;
  }
  return n;
}
function clearPriceAlerts(db, slipId) {
  return db.prepare('DELETE FROM price_alerts WHERE line_id IN (SELECT id FROM slip_lines WHERE slip_id = ?)').run(slipId).changes;
}

module.exports = { CATEGORIES, COST_CATS, cents, fromCents, isMonth, periodOf, lastDay, convMap, factorOf, confirmedLines, withBase,
  weightedAvg, avgFor, allocateTax, slipCosts, costReport, generatePriceAlerts, clearPriceAlerts };
