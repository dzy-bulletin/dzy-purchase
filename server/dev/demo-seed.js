#!/usr/bin/env node
'use strict';
// 示範資料產生器（全部是虛構：品牌門市名稱、廠商、品項、價格、貨單照片都是編造的，與任何真實貨單無關，所以可以進版控）。
//
//   DATA_DIR=spike/demodata node server/dev/demo-seed.js        （DATA_DIR 預設 spike/demodata；會先「整個清空」再重建）
//   DEMO_PASS=<密碼>  可選；沒給就隨機產生，只印在終端機、不寫進任何檔案。所有示範帳號（門市／會計／admin）共用這一組。
//
// 走的是正式的程式路徑：辨識結果走 postprocess（旗標由程式算）、會計核對／入帳走真正的 HTTP API（PUT／confirm／return），
// 所以廠商記憶、價格變動提醒、成本計算、損益推送排程（outbox）都是正式邏輯產生的，不是另寫一份公式。
// 不呼叫任何外部服務（不設 PNL_PUSH_URL／BACKUP_URL；也不需要 Ollama——辨識結果直接寫成 ai_raw 與明細，模擬辨識完成）。
// 照片：產生 SVG → macOS 內建 qlmanage 轉 PNG → sips 轉 JPEG（系統只收 JPEG）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { loadConfig, ROOT } = require('../config');
const { openDb, audit } = require('../db');
const { hashPassword } = require('../auth');
const { postprocess } = require('../postprocess');
const { matchVendor, makeCtx } = require('../slips-common');
const { makeApp, PREFIX } = require('../index');

// ---------- 小工具 ----------
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const R = rng(20261004);
const pick = (a) => a[Math.floor(R() * a.length)];
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(s + 'T00:00:00Z') + n * 86400e3));
const esc = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const uuid4 = () => { const b = crypto.randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

// ---------- 虛構主資料 ----------
const BRANDS = [['X', '小辛辣'], ['M', '墨竹亭'], ['C', '央廚']];
const STORES = [
  ['X01', 'X', '小辛辣示範一店'], ['X02', 'X', '小辛辣示範二店'],
  ['M01', 'M', '墨竹亭示範一店'], ['M02', 'M', '墨竹亭示範二店'], ['C01', 'C', '央廚示範廚房']
];
// 品項樣板（14 個，四類別都有）。每品牌共用同一結構、名稱與廠商名不同。v＝廠商序號；unit／price＝貨單上寫的進貨單位與單價
const TMPL = [
  { cat: '食材', base: '公斤', conv: { 箱: 10, 台斤: 0.6 }, v: 0, unit: '台斤', price: 18 },
  { cat: '食材', base: '公斤', conv: { 箱: 8, 台斤: 0.6 }, v: 0, unit: '台斤', price: 22 },
  { cat: '食材', base: '公斤', conv: { 箱: 5 }, v: 0, unit: '箱', price: 450 },
  { cat: '食材', base: '公斤', conv: { 箱: 10, 台斤: 0.6 }, v: 1, unit: '台斤', price: 85 },
  { cat: '食材', base: '公斤', conv: { 箱: 12 }, v: 1, unit: '箱', price: 1080 },
  { cat: '食材', base: '公斤', conv: { 包: 0.6 }, v: 2, unit: '包', price: 180 },
  { cat: '食材', base: '公斤', conv: { 箱: 10, 包: 1 }, v: 2, unit: '箱', price: 620 },
  { cat: '食材', base: '公斤', conv: { 桶: 5 }, v: 3, unit: '桶', price: 780 },
  { cat: '食材', base: '瓶', conv: { 箱: 12 }, v: 3, unit: '箱', price: 1440 },
  { cat: '包材', base: '個', conv: { 箱: 500, 條: 50 }, v: 4, unit: '箱', price: 1250 },
  { cat: '包材', base: '個', conv: { 箱: 1000 }, v: 4, unit: '箱', price: 880 },
  { cat: '雜貨', base: '瓶', conv: { 箱: 12 }, v: 5, unit: '箱', price: 540 },
  { cat: '雜貨', base: '包', conv: { 箱: 20 }, v: 5, unit: '箱', price: 960 },
  { cat: '其他', base: '捲', conv: { 箱: 20 }, v: 5, unit: '箱', price: 700 }
];
const NAMES = {
  X: { items: ['示範高麗菜', '示範青江菜', '示範玉米筍', '範例豬五花', '範例雞胸肉', '虛構乾香菇', '虛構寬粉', '模擬麻辣醬', '模擬花椒油', '樣品紙碗', '樣品外帶袋', '測試洗潔精', '測試垃圾袋', '示範標籤貼紙'],
       raw: ['高麗菜', '青江菜', '玉米筍', '豬五花', '雞胸', '乾香菇', '寬粉', '麻辣醬', '花椒油', '紙碗', '外帶袋', '洗潔精', '垃圾袋', '標籤貼紙'],
       vendors: ['示範蔬果行', '範例肉品行', '虛構乾貨行', '模擬調味商行', '樣品包材行', '測試雜貨行'], factor: 1.0 },
  M: { items: ['模擬細麵', '示範小白菜', '範例蔥花', '範例豬骨', '虛構牛腱', '示範花生碎', '虛構辣油', '模擬醬油', '範例芝麻醬', '樣品湯碗', '樣品筷子', '測試清潔劑', '測試抹布', '示範熱感紙'],
       raw: ['細麵', '小白菜', '蔥', '豬骨', '牛腱', '花生碎', '辣油', '醬油', '芝麻醬', '湯碗', '筷子', '清潔劑', '抹布', '熱感紙'],
       vendors: ['示範農產行', '範例肉品批發', '虛構乾貨商', '模擬醬料行', '樣品包裝行', '測試百貨行'], factor: 1.08 },
  C: { items: ['示範洋蔥', '示範紅蘿蔔', '範例大白菜', '範例雞腿肉', '範例豬梅花', '虛構辣椒乾', '虛構冬粉', '模擬高湯粉', '模擬米酒', '樣品餐盒', '樣品真空袋', '測試消毒水', '測試手套', '示範封箱膠帶'],
       raw: ['洋蔥', '紅蘿蔔', '大白菜', '雞腿肉', '梅花肉', '辣椒乾', '冬粉', '高湯粉', '米酒', '餐盒', '真空袋', '消毒水', '手套', '封箱膠帶'],
       vendors: ['示範蔬菜供應', '範例肉品供應', '虛構南北貨', '模擬調味供應', '樣品包材供應', '測試五金行'], factor: 0.92 }
};
const TAX_VENDORS = new Set([1, 3, 4]);          // 這幾家開含稅單（稅額 5%），其餘無稅
const ROC_VENDORS = new Set([0, 3]);             // 這幾家日期印民國年
// 價格調整事件（日期為 MM-DD，2026 年；各品牌依序晚 1 天）：[品項序, MM-DD, 倍率]
const EVENTS = [[0, '08-24', 1.15], [3, '09-07', 1.08], [7, '09-21', 1.10], [1, '09-28', 1.18], [9, '10-01', 1.06],
                [4, '09-14', 0.94], [8, '08-31', 0.92], [11, '09-21', 0.95], [0, '09-14', 0.90]];
const BRAND_IDX = { X: 0, M: 1, C: 2 };
function priceOf(brand, ti, date) {
  let p = TMPL[ti].price * NAMES[brand].factor;
  for (const [i, md, f] of EVENTS) if (i === ti && date >= `2026-${addDays('2026-' + md, BRAND_IDX[brand]).slice(5)}`) p *= f;
  return Math.max(1, Math.round(p));
}
// 損益對照：這幾組「廠商×類別」故意不對照 → 待補對照
const UNMAPPED = { X: [[5, '雜貨'], [5, '其他']], M: [[4, '包材']], C: [] };

// ---------- 貨單規格 ----------
// spec：{ brand, store, vendorIdx, date, kind, ai, pickVendor, hand, note }
function lineOf(brand, ti, date, qty, over) {
  const t = TMPL[ti]; const price = priceOf(brand, ti, date);
  const l = { name: NAMES[brand].raw[ti], qty, unit: t.unit, unit_price: price, amount: r2(qty * price) };
  return Object.assign(l, over || {});
}
function qtyFor(ti) { const u = TMPL[ti].unit; return u === '台斤' ? Math.round((8 + R() * 50) * 2) / 2 : u === '箱' ? 1 + Math.floor(R() * 4) : 1 + Math.floor(R() * 6); }
function aiOf(brand, vi, date, lines, opt) {
  opt = opt || {};
  const sub = r2(lines.reduce((s, l) => s + (l.amount || 0), 0));
  const taxed = opt.tax != null ? opt.tax : TAX_VENDORS.has(vi);
  const tax = taxed ? Math.round(sub * 0.05) : null;
  const roc = ROC_VENDORS.has(vi);
  const dd = roc ? `${Number(date.slice(0, 4)) - 1911}/${date.slice(5, 7)}/${date.slice(8)}` : date.replace(/-/g, '/');
  return { vendor: NAMES[brand].vendors[vi], date: dd, doc_no: `${'ABCDEF'[vi]}${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8)}-${pad(1 + Math.floor(R() * 99))}`,
    subtotal: taxed ? sub : null, tax, total: opt.total != null ? opt.total : r2(sub + (tax || 0)), handwritten_changes: opt.hand || '', lines };
}

function buildSpecs() {
  const specs = [];
  // 歷史已入帳：8/3 起，每家門市每週 3–4 張（週一到週六隨機挑日），到 10/03
  for (const [code, brand] of STORES) {
    let vrot = BRAND_IDX[brand] + code.charCodeAt(2);
    for (let w = '2026-08-03'; w <= '2026-10-03'; w = addDays(w, 7)) {
      const days = [0, 1, 2, 3, 4, 5].sort(() => R() - 0.5).slice(0, 3 + (R() < 0.5 ? 1 : 0)).sort();
      for (const d of days) {
        const date = addDays(w, d); if (date > '2026-10-03') continue;
        const vi = vrot++ % 6;
        const its = TMPL.map((t, i) => i).filter((i) => TMPL[i].v === vi);
        const n = Math.min(its.length, 2 + Math.floor(R() * 3));
        const chosen = its.sort(() => R() - 0.5).slice(0, n).sort((a, b) => a - b);
        specs.push({ brand, store: code, vendorIdx: vi, date, kind: 'confirmed', pickVendor: R() < 0.7,
          ai: aiOf(brand, vi, date, chosen.map((i) => lineOf(brand, i, date, qtyFor(i)))) });
      }
    }
  }
  // 本月待核對 8 張（X：缺單價／數量×單價不符／含稅單／無稅單；M：手寫修改／品名未對照／單位未換算；C：系統補算（漏零））
  const X = 'X', M = 'M', C = 'C';
  const L = (b, ti, d, q, o) => lineOf(b, ti, d, q, o);
  specs.push({ brand: X, store: 'X01', vendorIdx: 1, date: '2026-10-02', kind: 'review', pickVendor: true, tag: '缺單價（紅）',
    ai: aiOf(X, 1, '2026-10-02', [L(X, 3, '2026-10-02', 30), L(X, 4, '2026-10-02', 2, { unit_price: null })]) });
  specs.push({ brand: X, store: 'X02', vendorIdx: 0, date: '2026-10-02', kind: 'review', pickVendor: true, tag: '數量×單價不符（紅）',
    ai: aiOf(X, 0, '2026-10-02', [L(X, 0, '2026-10-02', 25), L(X, 2, '2026-10-02', 3, { amount: 1440 })]) });
  specs.push({ brand: X, store: 'X01', vendorIdx: 3, date: '2026-10-03', kind: 'review', pickVendor: false, tag: '含稅單',
    ai: aiOf(X, 3, '2026-10-03', [L(X, 7, '2026-10-03', 2), L(X, 8, '2026-10-03', 1)], { tax: true }) });
  specs.push({ brand: X, store: 'X02', vendorIdx: 2, date: '2026-10-03', kind: 'review', pickVendor: true, tag: '無稅單',
    ai: aiOf(X, 2, '2026-10-03', [L(X, 5, '2026-10-03', 4), L(X, 6, '2026-10-03', 2)], { tax: false }) });
  specs.push({ brand: M, store: 'M01', vendorIdx: 0, date: '2026-10-03', kind: 'review', pickVendor: true, tag: '手寫修改（黃）', hand: { row: 1, newQty: '6' },
    ai: aiOf(M, 0, '2026-10-03', [L(M, 0, '2026-10-03', 20), L(M, 1, '2026-10-03', 6), L(M, 2, '2026-10-03', 2)], { hand: '第 2 項數量原 5 手寫改為 6，旁邊有簽名章' }) });
  specs.push({ brand: M, store: 'M02', vendorIdx: 3, date: '2026-10-03', kind: 'review', pickVendor: true, tag: '品名未對照（黃）',
    ai: aiOf(M, 3, '2026-10-03', [L(M, 7, '2026-10-03', 1), { name: '特選花椒粉（新品）', qty: 2, unit: '包', unit_price: 360, amount: 720 }]) });
  specs.push({ brand: M, store: 'M01', vendorIdx: 2, date: '2026-10-02', kind: 'review', pickVendor: true, tag: '單位未換算（黃）',
    ai: aiOf(M, 2, '2026-10-02', [L(M, 5, '2026-10-02', 3, { unit: '袋', unit_price: 170, amount: 510 }), L(M, 6, '2026-10-02', 2)]) });
  const cAi = aiOf(C, 1, '2026-10-03', [L(C, 3, '2026-10-03', 25), L(C, 4, '2026-10-03', 10)]);
  cAi.lines[1].amount = cAi.lines[1].amount / 10;        // 貨單上印成少一個零（例如 9340 印成 934）：後處理判斷漏零並補回，總額仍是正確值
  specs.push({ brand: C, store: 'C01', vendorIdx: 1, date: '2026-10-03', kind: 'review', pickVendor: true, tag: '系統補算（漏零）', ai: cAi });
  // 辨識失敗、退回、辨識中
  specs.push({ brand: M, store: 'M02', vendorIdx: 4, date: '2026-10-03', kind: 'failed', pickVendor: true, tag: '辨識失敗',
    ai: aiOf(M, 4, '2026-10-03', [L(M, 9, '2026-10-03', 2)]) });
  specs.push({ brand: X, store: 'X01', vendorIdx: 5, date: '2026-10-02', kind: 'returned', pickVendor: true, tag: '退回', blur: true,
    ai: aiOf(X, 5, '2026-10-02', [L(X, 11, '2026-10-02', 2), L(X, 12, '2026-10-02', 1)]) });
  specs.push({ brand: C, store: 'C01', vendorIdx: 0, date: '2026-10-04', kind: 'recognizing', pickVendor: true, tag: '辨識中',
    ai: aiOf(C, 0, '2026-10-04', [L(C, 0, '2026-10-04', 30), L(C, 1, '2026-10-04', 20)]) });
  // 修正特例的總額：含稅單 total 需含稅（缺單價那張 total 先含稅後面 postprocess 會判紅，另行處理）
  for (const s of specs) { if (s.ai.total != null) s.ai.total = r2(s.ai.total); }
  specs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const seq = {};
  for (const s of specs) { seq[s.date] = (seq[s.date] || 0) + 1; s.id = `S${s.date.replace(/-/g, '')}-${String(seq[s.date]).padStart(4, '0')}`; }
  return specs;
}

// ---------- 照片（SVG → PNG → JPEG）----------
function svgOf(spec, storeName) {
  const ai = spec.ai, rnd = rng(parseInt(spec.id.slice(-4), 10) * 7919 + spec.id.charCodeAt(5));
  const tilt = (rnd() - 0.5) * 4.4, paper = pick2(rnd, ['#f4efe1', '#f1ecdc', '#f6f1e6', '#efe9d6']), desk = pick2(rnd, ['#6f6354', '#5f5a52', '#76695a']);
  const F = 'PingFang TC, Heiti TC, Noto Sans CJK TC, sans-serif', K = 'Kaiti TC, BiauKai, STKaiti, serif';
  const out = [];
  const t = (x, y, s, size, extra) => out.push(`<text x="${x}" y="${y}" font-size="${size}" font-family="${F}" ${extra || ''}>${esc(s)}</text>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">`);
  out.push(`<defs><linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${desk}"/><stop offset="1" stop-color="#3f3a33"/></linearGradient></defs>`);
  out.push(`<rect width="1200" height="1200" fill="url(#d)"/>`);
  out.push(`<g transform="rotate(${tilt.toFixed(2)} 600 600)">`);
  out.push(`<rect x="176" y="62" width="860" height="1100" fill="#000" opacity="0.28"/>`);       // 陰影
  out.push(`<rect x="170" y="50" width="860" height="1100" fill="${paper}"/>`);
  out.push(`<rect x="170" y="560" width="860" height="3" fill="#000" opacity="0.06"/>`);          // 摺痕
  t(600, 135, ai.vendor, 56, 'text-anchor="middle" font-weight="bold" fill="#222"');
  t(600, 185, '出　貨　單', 30, 'text-anchor="middle" fill="#333" letter-spacing="10"');
  t(210, 255, `日期：${ai.date}`, 28, 'fill="#222"');
  t(620, 255, `單號：${ai.doc_no}`, 28, 'fill="#222"');
  t(210, 305, `客戶：${storeName}`, 28, 'fill="#222"');
  out.push(`<rect x="200" y="335" width="800" height="3" fill="#333"/>`);
  const cols = [[215, '品名', 'start'], [640, '數量', 'end'], [700, '單位', 'start'], [830, '單價', 'end'], [980, '金額', 'end']];
  for (const [x, s, a] of cols) t(x, 380, s, 26, `text-anchor="${a}" fill="#444"`);
  out.push(`<rect x="200" y="395" width="800" height="2" fill="#777"/>`);
  let y = 450;
  ai.lines.forEach((l) => {
    t(215, y, l.name, 30, 'fill="#1b1b1b"');
    t(640, y, l.qty == null ? '' : l.qty, 30, 'text-anchor="end" fill="#1b1b1b"');
    t(700, y, l.unit || '', 30, 'fill="#1b1b1b"');
    t(830, y, l.unit_price == null ? '' : l.unit_price, 30, 'text-anchor="end" fill="#1b1b1b"');
    t(980, y, l.amount == null ? '' : l.amount, 30, 'text-anchor="end" fill="#1b1b1b"');
    out.push(`<rect x="200" y="${y + 18}" width="800" height="1" fill="#999" opacity="0.7"/>`);
    y += 66;
  });
  const by = 800;
  out.push(`<rect x="200" y="${by - 30}" width="800" height="3" fill="#333"/>`);
  if (ai.subtotal != null) t(980, by + 20, `小計　${ai.subtotal}`, 28, 'text-anchor="end" fill="#222"');
  if (ai.tax != null) t(980, by + 68, `營業稅 5%　${ai.tax}`, 28, 'text-anchor="end" fill="#222"');
  t(980, by + 125, `合計　${ai.total}`, 36, 'text-anchor="end" font-weight="bold" fill="#111"');
  out.push(`<circle cx="270" cy="${by + 140}" r="52" fill="none" stroke="#b3261e" stroke-width="5" opacity="0.75"/>`);   // 收貨章
  t(270, by + 134, '收訖', 30, 'text-anchor="middle" fill="#b3261e" opacity="0.8"');
  t(270, by + 166, '示範章', 20, 'text-anchor="middle" fill="#b3261e" opacity="0.8"');
  if (spec.hand) {                                                                     // 手寫修改：紅筆劃掉原數字、旁邊寫新數字與說明
    const hy = 450 + 66 * spec.hand.row;
    out.push(`<line x1="585" y1="${hy - 12}" x2="645" y2="${hy - 12}" stroke="#b3261e" stroke-width="4"/>`);
    out.push(`<text x="595" y="${hy - 42}" font-size="38" font-family="${K}" fill="#b3261e">${esc(spec.hand.newQty)}</text>`);
    out.push(`<text x="215" y="${by + 235}" font-size="30" font-family="${K}" fill="#b3261e" transform="rotate(-2 215 ${by + 235})">${esc('數量改 ' + spec.hand.newQty + '（已核）')}</text>`);
  }
  out.push(`</g>`);
  if (spec.blur) out.push(`<rect width="1200" height="1200" fill="#fff" opacity="0.0"/>`);
  out.push(`</svg>`);
  return out.join('\n');
}
function pick2(rnd, a) { return a[Math.floor(rnd() * a.length)]; }

function renderPhotos(specs, storeNameOf, dataDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-svg-'));
  try {
    for (const s of specs) fs.writeFileSync(path.join(tmp, `${s.id}.svg`), svgOf(s, storeNameOf[s.store]));
    const ids = specs.map((s) => s.id);
    for (let i = 0; i < ids.length; i += 40) {
      execFileSync('qlmanage', ['-t', '-s', '1600', '-o', tmp].concat(ids.slice(i, i + 40).map((id) => path.join(tmp, id + '.svg'))), { stdio: 'ignore' });
    }
    for (const s of specs) {
      const ym = s.id.slice(1, 7), dir = path.join(dataDir, 'photos', ym);
      fs.mkdirSync(dir, { recursive: true });
      const rel = `data/photos/${ym}/${s.id}_1.jpg`;
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', path.join(tmp, `${s.id}.svg.png`), '--out', path.join(dir, `${s.id}_1.jpg`)], { stdio: 'ignore' });
      s.photoRel = rel;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- 主流程 ----------
async function main() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'spike', 'demodata'));
  if (!dataDir.includes('demo')) throw new Error(`為免誤刪，DATA_DIR 路徑必須含 "demo"：${dataDir}`);
  const givenPass = !!process.env.DEMO_PASS;
  const pw = process.env.DEMO_PASS || crypto.randomBytes(9).toString('base64url');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig({ DATA_DIR: dataDir, WORKER: '0', PORT: '0', HOME: process.env.HOME });
  const db = openDb(cfg.DATA_DIR);

  // 1) 主資料
  const passHash = hashPassword(pw);
  const ids = { store: {}, vendor: {}, item: {} };
  db.tx(() => {
    for (const [id, name] of BRANDS) db.prepare('INSERT INTO brands (id, name) VALUES (?,?)').run(id, name);
    for (const [code, brand, name] of STORES) ids.store[code] = Number(db.prepare('INSERT INTO stores (brand_id, code, name, pass_hash, pnl_unit_code) VALUES (?,?,?,?,?)').run(brand, code, name, passHash, `ZU-${code}`).lastInsertRowid);
    for (const [u, role, brand, name] of [['acc-x', 'accountant', 'X', '小辛辣示範會計'], ['acc-m', 'accountant', 'M', '墨竹亭示範會計'], ['acc-c', 'accountant', 'C', '央廚示範會計'], ['admin', 'admin', null, '示範管理者']])
      db.prepare('INSERT INTO users (username, role, brand_id, name, pass_hash) VALUES (?,?,?,?,?)').run(u, role, brand, name, passHash);
    let acc = { X: 1, M: 101, C: 201 }; const accOf = {};
    for (const [b] of BRANDS) {
      NAMES[b].vendors.forEach((vn, vi) => {
        const al = vi === 0 ? JSON.stringify([vn.slice(0, 4)]) : '[]';
        ids.vendor[`${b}${vi}`] = Number(db.prepare('INSERT INTO vendors (brand_id, name, aliases) VALUES (?,?,?)').run(b, vn, al).lastInsertRowid);
      });
      TMPL.forEach((t, ti) => {
        const iid = Number(db.prepare('INSERT INTO items (brand_id, name, category, base_unit) VALUES (?,?,?,?)').run(b, NAMES[b].items[ti], t.cat, t.base).lastInsertRowid);
        ids.item[`${b}${ti}`] = iid;
        for (const [u, f] of Object.entries(t.conv)) db.prepare('INSERT INTO unit_conv (item_id, unit, factor_to_base) VALUES (?,?,?)').run(iid, u, f);
        const vi = t.v, key = `${b}|${vi}|${t.cat}`;
        if (!accOf[key] && !(UNMAPPED[b] || []).some(([v, c]) => v === vi && c === t.cat)) {
          accOf[key] = `Z${String(acc[b]++).padStart(3, '0')}`;
          db.prepare('INSERT INTO pnl_map (brand_id, vendor_id, category, acc_id) VALUES (?,?,?,?)').run(b, ids.vendor[`${b}${vi}`], t.cat, accOf[key]);
        }
      });
    }
  });

  // 2) 貨單規格與照片
  const specs = buildSpecs();
  const storeName = Object.fromEntries(STORES.map(([c, , n]) => [c, n]));
  renderPhotos(specs, storeName, dataDir);

  // 3) 啟動內嵌伺服器（工人與損益推送不啟動），以會計身分走正式 API
  let clock = new Date('2026-10-04T10:00:00Z');
  const app = makeApp(cfg, { db, now: () => clock });
  const addr = await app.listen(0, '127.0.0.1');
  const call = async (method, p, token, body) => {
    const r = await fetch(`http://127.0.0.1:${addr.port}${PREFIX}${p}`, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}), body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method} ${p} → ${j.error} ${j.message}`);
    return j.data;
  };
  const tok = {};
  for (const b of ['x', 'm', 'c']) tok[b.toUpperCase()] = (await call('POST', '/login', null, { account: `acc-${b}`, password: pw })).token;

  const saveResult = (slip, text, seconds) => {                       // 與 worker.saveResult 同一流程（postprocess＋makeCtx＋寫明細）
    const ai = JSON.parse(text);
    db.tx(() => {
      const cur = db.prepare('SELECT vendor_id, vendor_name_raw FROM slips WHERE id = ?').get(slip.id);
      const shot = `${slip.id.slice(1, 5)}-${slip.id.slice(5, 7)}-${slip.id.slice(7, 9)}`;
      let vendorId = cur.vendor_id, vendorRaw = cur.vendor_name_raw;
      if (!vendorId) { vendorId = matchVendor(db, slip.brand_id, ai.vendor); if (!vendorId && !vendorRaw && ai.vendor) vendorRaw = ai.vendor; }
      const r = postprocess(ai, shot, makeCtx(db, slip.brand_id, vendorId, true));
      db.prepare(`UPDATE slips SET status='review', vendor_id=?, vendor_name_raw=?, doc_date=?, doc_no=?, subtotal=?, tax=?, total=?,
                  total_handwritten=?, handwritten_note=?, flags=?, date_note=?, ai_raw=?, ai_model=?, ai_seconds=?, error=NULL WHERE id=?`)
        .run(vendorId, vendorRaw, r.doc_date, r.doc_no, r.subtotal, r.tax, r.total, r.total_handwritten, r.handwritten_note, JSON.stringify(r.flags), r.date_note, text, cfg.MODEL, seconds, slip.id);
      db.prepare('DELETE FROM slip_lines WHERE slip_id = ?').run(slip.id);
      const ins = db.prepare('INSERT INTO slip_lines (slip_id, seq, raw_name, item_id, qty, unit, unit_price, amount, flags, checked, edited_by_human) VALUES (?,?,?,?,?,?,?,?,?,0,0)');
      for (const l of r.lines) ins.run(slip.id, l.seq, l.raw_name, l.item_id, l.qty, l.unit, l.unit_price, l.amount, JSON.stringify(l.flags));
      audit(db, 'system:worker', 'recognize', slip.id, null, { status: 'review', lines: r.lines.length, flags: r.flags });
    });
  };

  const counts = { confirmed: 0, review: 0, failed: 0, returned: 0, recognizing: 0 };
  let minute = 0;
  for (const s of specs) {
    const upAt = new Date(`${s.date}T0${2 + Math.floor(R() * 6)}:${pad(Math.floor(R() * 60))}:00Z`);       // 台北 10～14 點
    clock = new Date(upAt.getTime() + 20 * 60e3);
    const vendorId = s.pickVendor ? ids.vendor[`${s.brand}${s.vendorIdx}`] : null;
    db.tx(() => {
      db.prepare("INSERT INTO slips (id, client_id, store_id, brand_id, vendor_id, vendor_name_raw, status, uploaded_at) VALUES (?,?,?,?,?,?, 'queued', ?)")
        .run(s.id, uuid4(), ids.store[s.store], s.brand, vendorId, null, upAt.toISOString());
      const full = path.join(dataDir, s.photoRel.replace(/^data\//, ''));
      db.prepare('INSERT INTO slip_photos (slip_id, seq, path, sha256) VALUES (?,?,?,?)').run(s.id, 1, s.photoRel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
      audit(db, `store:${ids.store[s.store]}`, 'upload', s.id, null, { photos: 1, vendor_id: vendorId });
    });
    if (s.kind === 'failed') {
      db.prepare("UPDATE slips SET status='failed', attempts=3, error=? WHERE id=?").run('辨識逾時（示範資料：模擬辨識失敗）', s.id);
      audit(db, 'system:worker', 'recognize_failed', s.id, null, { error: '辨識逾時（示範資料）' });
    } else if (s.kind === 'recognizing') {
      db.prepare("UPDATE slips SET status='recognizing' WHERE id=?").run(s.id);
    } else {
      const slip = db.prepare('SELECT * FROM slips WHERE id = ?').get(s.id);
      saveResult(slip, JSON.stringify(s.ai), Math.round((18 + R() * 40) * 10) / 10);
      if (s.kind === 'confirmed') {
        const lines = db.prepare('SELECT * FROM slip_lines WHERE slip_id = ? ORDER BY seq').all(s.id);
        const body = { lines: lines.map((l, i) => {
          const ti = NAMES[s.brand].raw.indexOf(l.raw_name);
          return { id: l.id, raw_name: l.raw_name, qty: l.qty, unit: l.unit, unit_price: l.unit_price, amount: l.amount, item_id: l.item_id || ids.item[`${s.brand}${ti}`], checked: 1 };
        }) };
        await call('PUT', `/slips/${s.id}`, tok[s.brand], body);
        clock = new Date(Date.parse(s.date + 'T10:00:00Z') + (s.id.endsWith('1') ? 0 : 0) + (minute++ % 50) * 60e3);
        await call('POST', `/slips/${s.id}/confirm`, tok[s.brand], {});
      } else if (s.kind === 'returned') {
        await call('POST', `/slips/${s.id}/return`, tok[s.brand], { reason: '照片模糊、右下角被手指擋住，請重拍' });
      }
    }
    counts[s.kind]++;
    db.prepare('UPDATE audit SET at = ? WHERE slip_id = ? AND who NOT LIKE ?').run(clock.toISOString(), s.id, 'store:%');
    db.prepare('UPDATE audit SET at = ? WHERE slip_id = ? AND who LIKE ?').run(upAt.toISOString(), s.id, 'store:%');
  }

  // 4) 損益推送：一個月份「已定稿」終態黃燈示範（直接寫 outbox 終態，不推送）
  const lockedStore = ids.store.X01;
  db.prepare("INSERT OR IGNORE INTO pnl_outbox (store_id, month, dirty_at, ver) VALUES (?,?,?,1)").run(lockedStore, '2026-09', '2026-10-01T02:00:00.000Z');
  db.prepare("UPDATE pnl_outbox SET state='locked', reason=?, last_error='LOCKED', attempts=1, next_at=NULL, first_fail_at=NULL WHERE store_id=? AND month=?")
    .run('2026-09 已定稿（小辛辣示範一店），進貨金額變動 +1860 元未反映到損益，請解除定稿或手動調整', lockedStore, '2026-09');
  db.prepare('DELETE FROM sessions').run();                             // 示範用登入憑證不留
  await app.close();

  const unmapped = require('../pnl-push');
  console.log(`示範資料完成：${dataDir}`);
  console.log('貨單：' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('、'));
  if (!givenPass) console.log(`示範帳號（門市 X01 X02 M01 M02 C01；會計 acc-x acc-m acc-c；admin）共用密碼，只顯示這一次、沒有存檔：\n${pw}`);
  else console.log('示範帳號共用密碼＝環境變數 DEMO_PASS（未列印）');
  void unmapped;
}
main().catch((e) => { console.error(e); process.exit(1); });
