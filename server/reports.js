'use strict';
// T15／T16：報表 API（成本、單價走勢、每日明細、提醒）與會計現行格式匯出。數字一律來自 calc.js
const ExcelJS = require('exceljs');
const { ApiError } = require('./http-util');
const C = require('./calc');

module.exports = function register(ctx) {
  const { route, db, now, RAW: RAW_SYM, corsHeaders } = ctx;
  const taipeiMonth = () => new Date(now().getTime() + 8 * 3600e3).toISOString().slice(0, 7);
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

  // 會計＝自己品牌；admin 可用 brand_id 縮小，不給就是全部品牌
  function scope(p, url) {
    const given = url.searchParams.get('brand_id') || undefined;
    if (p.role === 'accountant') {
      if (!p.brand_id) throw new ApiError('FORBIDDEN', '這個會計帳號沒有設定品牌');
      if (given && given !== p.brand_id) throw new ApiError('FORBIDDEN', '不能查看其他品牌的資料');
      return p.brand_id;
    }
    if (given && !db.prepare('SELECT 1 FROM brands WHERE id = ?').get(given)) throw new ApiError('BAD_INPUT', '找不到這個品牌');
    return given || null;
  }
  function storeScope(brand, url) {
    const sid = url.searchParams.get('store_id');
    if (!sid) return null;
    const s = db.prepare('SELECT id, brand_id FROM stores WHERE id = ?').get(Number(sid));
    if (!s) throw new ApiError('NOT_FOUND', '找不到這間門市');
    if (brand && s.brand_id !== brand) throw new ApiError('FORBIDDEN', '這間門市不屬於可查看的品牌');
    return s.id;
  }
  const monthParam = (url, dflt) => {
    const m = url.searchParams.get('month') || dflt;
    if (!C.isMonth(m)) throw new ApiError('BAD_INPUT', 'month 格式為 YYYY-MM');
    return m;
  };
  const ROLES = ['accountant', 'admin'];

  route('GET', /^\/reports\/cost$/, ROLES, async ({ p, url }) => {
    const brand = scope(p, url);
    return C.costReport(db, { brandId: brand, month: monthParam(url), storeId: storeScope(brand, url) });
  });

  route('GET', /^\/reports\/price$/, ROLES, async ({ p, url }) => {
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(url.searchParams.get('item_id')));
    if (!it) throw new ApiError('NOT_FOUND', '找不到這個品項');
    if (p.role === 'accountant' && it.brand_id !== p.brand_id) throw new ApiError('FORBIDDEN', '不能查看其他品牌的資料');
    const months = Math.min(36, Math.max(1, Math.floor(Number(url.searchParams.get('months'))) || 6));
    const month = monthParam(url, taipeiMonth());
    const from = C.periodOf(month, months).from;
    const to = C.periodOf(month, 1).to;
    const lines = C.confirmedLines(db, { brandId: it.brand_id, itemId: it.id, from, to }).filter((l) => l.converted);
    const vname = (id, raw) => (id && (db.prepare('SELECT name FROM vendors WHERE id = ?').get(id) || {}).name) || raw || null;
    return { item: it.name, base_unit: it.base_unit,
      points: lines.map((l) => ({ doc_date: l.doc_date, vendor: vname(l.vendor_id, l.vendor_name_raw), unit_cost: l.unit_cost, slip_id: l.slip_id })),
      avg_month: C.avgFor(db, it.brand_id, it.id, month, 1), avg_3m: C.avgFor(db, it.brand_id, it.id, month, 3) };
  });

  route('GET', /^\/reports\/daily$/, ROLES, async ({ p, url }) => {
    const brand = scope(p, url);
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) throw new ApiError('BAD_INPUT', 'from／to 格式為 YYYY-MM-DD，且 from 不可晚於 to');
    const lines = C.confirmedLines(db, { brandId: brand, from, to, storeId: storeScope(brand, url) });
    const vn = new Map(db.prepare('SELECT id, name FROM vendors').all().map((v) => [v.id, v.name]));
    const sn = new Map(db.prepare('SELECT id, name FROM stores').all().map((v) => [v.id, v.name]));
    return lines.map((l) => ({ doc_date: l.doc_date, store: sn.get(l.store_id) || null, vendor: vn.get(l.vendor_id) || l.vendor_name_raw || null,
      item: l.item_name || null, raw_name: l.raw_name, qty: l.qty, unit: l.unit, unit_price: l.unit_price, amount: l.amount, base_qty: l.base_qty, unit_cost: l.unit_cost }));
  });

  // 提醒的月份＝該張貨單的進貨日期月份（與成本報表同一個歸屬規則）；不給 month 就是全部
  route('GET', /^\/alerts$/, ROLES, async ({ p, url }) => {
    const brand = scope(p, url);
    const w = [], a = [];
    if (brand) { w.push('s.brand_id = ?'); a.push(brand); }
    if (url.searchParams.get('month')) { const m = monthParam(url); w.push('s.doc_date >= ? AND s.doc_date <= ?'); const pr = C.periodOf(m, 1); a.push(pr.from, pr.to); }
    return db.prepare(`SELECT pa.id, pa.created_at, i.name item, v.name vendor, st.name store, pa.prev_price, pa.new_price, pa.pct, pa.direction, s.id slip_id
      FROM price_alerts pa JOIN slip_lines l ON l.id = pa.line_id JOIN slips s ON s.id = l.slip_id
      LEFT JOIN items i ON i.id = pa.item_id LEFT JOIN vendors v ON v.id = pa.vendor_id LEFT JOIN stores st ON st.id = pa.store_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY pa.created_at DESC, pa.id DESC`).all(...a);
  });

  // ---------- 會計現行格式匯出 ----------
  route('GET', /^\/export\/legacy\.xlsx$/, ROLES, async ({ p, url, req, res }) => {
    const brand = scope(p, url);
    const month = monthParam(url);
    const storeId = storeScope(brand, url);
    const wb = await buildLegacyWorkbook(month, { brandId: brand, storeId });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="legacy-${month}.xlsx"`, 'Content-Length': buf.length, 'Cache-Control': 'no-store'
    }, corsHeaders(req)));
    res.end(buf);
    return RAW_SYM;
  });

  async function buildLegacyWorkbook(month, opts) {
    const y = Number(month.slice(0, 4)), mo = Number(month.slice(5, 7));
    const p = C.periodOf(month, 1);
    const slips = C.slipCosts(db, { brandId: opts.brandId, storeId: opts.storeId, from: p.from, to: p.to });
    const vn = new Map(db.prepare('SELECT id, name FROM vendors').all().map((v) => [v.id, v.name]));
    const nameOf = (s) => vn.get(s.vendor_id) || s.vendor_name_raw || '（未指定廠商）';
    const vendors = [...new Set(slips.map(nameOf))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const cell = new Map();                                               // `${day}|${vendor}` → 分
    for (const s of slips) { const k = `${Number(s.doc_date.slice(8, 10))}|${nameOf(s)}`; cell.set(k, (cell.get(k) || 0) + s.total_cents); }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('廠商進貨總額');
    ws.getCell(1, 1).value = `${y - 1911} 年 ${mo} 月廠商支出(月結)`;
    ws.getRow(2).values = ['進貨日期'].concat(vendors);
    const days = C.lastDay(y, mo);
    const colTotal = vendors.map(() => 0);
    for (let d = 1; d <= days; d++) {
      const row = ws.getRow(2 + d);
      const dc = row.getCell(1);
      dc.value = new Date(Date.UTC(y, mo - 1, d)); dc.numFmt = 'yyyy/m/d';
      vendors.forEach((v, i) => {
        const c = cell.get(`${d}|${v}`);
        if (c) { row.getCell(2 + i).value = C.fromCents(c); colTotal[i] += c; }
      });
    }
    const tr = ws.getRow(3 + days);
    tr.getCell(1).value = '總計';
    vendors.forEach((v, i) => { tr.getCell(2 + i).value = C.fromCents(colTotal[i]); });
    ws.getColumn(1).width = 12;
    vendors.forEach((v, i) => { ws.getColumn(2 + i).width = Math.max(10, v.length * 2 + 2); });
    return wb;
  }
  return { buildLegacyWorkbook };
};
