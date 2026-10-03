// 開發用假後端：依 spec 6.1 回假資料。node web/dev/mock-server.mjs [port]
// 假帳號（只在這支假伺服器有效）：門市 X01／test，會計 acct／test
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.argv[2] || 8794);
const P = '/purchase/api';
const tokens = new Map();   // token -> {role, brand, store_id, name}
const clientIds = new Map();
// 全部虛構資料。假帳號（只在這支假伺服器有效，密碼一律 test）：
// 門市 X01／M01／C01；會計 acct（小辛辣）／acctM／acctC；管理員 admin
const ACCOUNTS = {
  X01: { role: 'store', brand: 'X', store_id: 'X01', name: '光復店' },
  M01: { role: 'store', brand: 'M', store_id: 'M01', name: '示範墨竹亭店' },
  C01: { role: 'store', brand: 'C', store_id: 'C01', name: '示範中央廚房' },
  acct: { role: 'accountant', brand: 'X', name: '示範會計（小辛辣）' },
  acctM: { role: 'accountant', brand: 'M', name: '示範會計（墨竹亭）' },
  acctC: { role: 'accountant', brand: 'C', name: '示範會計（央廚）' },
  admin: { role: 'admin', brand: null, name: '示範管理員' }
};
let vendors = [
  { id: 1, name: '示範肉品行', brand_id: 'X', active: 1 }, { id: 2, name: '示範蔬果行', brand_id: 'X', active: 1 }, { id: 3, name: '舊示範乾貨', brand_id: 'X', active: 0 },
  { id: 4, name: '示範海產行', brand_id: 'M', active: 1 }, { id: 5, name: '示範米糧行', brand_id: 'C', active: 1 }
];
let items = [
  { id: 1, name: '豬頭皮', category: '食材', base_unit: '斤', active: 1, brand_id: 'X' },
  { id: 2, name: '鴨掌', category: '食材', base_unit: '斤', active: 1, brand_id: 'X' },
  { id: 3, name: '高麗菜', category: '食材', base_unit: '斤', active: 1, brand_id: 'X' },
  { id: 4, name: '外帶紙碗', category: '包材', base_unit: '箱', active: 1, brand_id: 'X' },
  { id: 5, name: '洗碗精', category: '雜貨', base_unit: '瓶', active: 0, brand_id: 'X' },
  { id: 6, name: '示範干貝', category: '食材', base_unit: '包', active: 1, brand_id: 'M' },
  { id: 7, name: '示範白米', category: '食材', base_unit: '公斤', active: 1, brand_id: 'C' }
];
let units = { 1: [{ unit: '公斤', factor: 1.667 }], 3: [{ unit: '顆', factor: 2.5 }], 4: [{ unit: '條', factor: 0.1 }] };
let stores = [
  { id: 1, code: 'X01', name: '光復店', brand_id: 'X', active: 1 }, { id: 2, code: 'X02', name: '示範二店', brand_id: 'X', active: 1 },
  { id: 3, code: 'M01', name: '示範墨竹亭店', brand_id: 'M', active: 1 }, { id: 4, code: 'C01', name: '示範中央廚房', brand_id: 'C', active: 1 }
];
let users = [
  { id: 1, username: 'acct', name: '示範會計（小辛辣）', role: 'accountant', brand_id: 'X', active: 1 },
  { id: 2, username: 'acctM', name: '示範會計（墨竹亭）', role: 'accountant', brand_id: 'M', active: 1 },
  { id: 3, username: 'admin', name: '示範管理員', role: 'admin', brand_id: null, active: 1 }
];
let nextId = 100;
const r2 = n => Math.round(n * 100) / 100;
const mk = (id, status, vendor, lines, extra = {}) => ({
  id, brand_id: 'X', store_id: 'X01', store_name: '光復店', vendor_id: 1, vendor_name: vendor, status, doc_date: '2026-10-03', doc_no: 'A' + id.slice(-4),
  total: null, total_handwritten: null, handwritten_note: '', flags: [], uploaded_at: '2026-10-03T09:00:00', photo_count: 1, photos: ['p'],
  lines: lines.map((l, i) => ({ id: id + '-L' + (i + 1), seq: i + 1, flags: [], checked: 0, item_id: null, ...l })), ...extra
});
const slips = [
  mk('S20261003-0001', 'review', '示範肉品行', [
    { raw_name: '豬頭皮', qty: 10, unit: '斤', unit_price: 50, amount: 600, flags: ['AMOUNT_MISMATCH', 'ITEM_UNMAPPED'] },
    { raw_name: '鴨掌', qty: 5, unit: '斤', unit_price: 120, amount: 600, flags: ['ITEM_UNMAPPED'] }], { total: 1234, photo_count: 2, photos: ['p', 'p'] }),
  mk('S20261003-0002', 'review', '示範蔬果行', [
    { raw_name: '範例菇類', qty: 3, unit: '袋', unit_price: null, amount: 450, flags: ['PRICE_MISSING', 'ITEM_UNMAPPED'] },
    { raw_name: '高麗菜', qty: 20, unit: '斤', unit_price: 15, amount: 300, flags: ['HANDWRITTEN', 'ITEM_UNMAPPED'] }], { vendor_id: 2, total: 750, handwritten_note: '高麗菜改 20 斤' }),
  mk('S20261003-0003', 'review', '示範肉品行', [{ raw_name: '五花肉', qty: 4, unit: '斤', unit_price: 100, amount: 400, flags: ['ITEM_UNMAPPED'] }], { total: 400, flags: ['DATE_FIXED'], date_note: '日期讀不出，暫用拍照日' }),
  mk('S20261003-0004', 'failed', '示範肉品行', [{ raw_name: '示範里肌', qty: 2, unit: '斤', unit_price: 90, amount: 180 }], { doc_date: null, total: 180 }),
  mk('S20261003-0005', 'review', '示範海產行', [{ raw_name: '干貝（大）', qty: 6, unit: '包', unit_price: 300, amount: 1800, flags: ['ITEM_UNMAPPED'] }], { brand_id: 'M', store_id: 'M01', store_name: '示範墨竹亭店', vendor_id: 4, total: 1800 }),
  mk('S20261003-0006', 'review', '示範米糧行', [{ raw_name: '白米 30kg', qty: 3, unit: '袋', unit_price: 900, amount: 2700, flags: ['ITEM_UNMAPPED', 'UNIT_UNCONVERTED'] }], { brand_id: 'C', store_id: 'C01', store_name: '示範中央廚房', vendor_id: 5, total: 2700 })
];
// 「我的上傳」今天／昨天／更早（相對現在，台北時間）、以及退回／已入帳各一張，供側欄筆數與看更多的截圖用
const dayAgo = n => new Date(Date.now() + 8 * 3600e3 - n * 86400e3).toISOString().slice(0, 10) + 'T09:00:00';
slips.push(
  mk('S20261003-0007', 'returned', '示範蔬果行', [], { uploaded_at: dayAgo(0), return_reason: '照片太糊' }),
  mk('S20261003-0008', 'confirmed', '示範肉品行', [{ raw_name: '豬頭皮', qty: 2, unit: '斤', unit_price: 50, amount: 100, item_id: 1, checked: 1 }], { total: 100, uploaded_at: dayAgo(1) }),
  mk('S20261003-0009', 'confirmed', '示範蔬果行', [{ raw_name: '高麗菜', qty: 4, unit: '斤', unit_price: 15, amount: 60, item_id: 3, checked: 1 }], { vendor_id: 2, total: 60, uploaded_at: dayAgo(6) }),
  mk('S20261003-0010', 'confirmed', '示範肉品行', [{ raw_name: '鴨掌', qty: 1, unit: '斤', unit_price: 120, amount: 120, item_id: 2, checked: 1 }], { total: 120, uploaded_at: dayAgo(13) })
);
slips.filter(x => x.store_id === 'X01' && x.status === 'review').forEach((x, i) => { x.uploaded_at = dayAgo(i ? 3 : 0); });
let seq = 10;
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cors }); res.end(JSON.stringify(obj)); };
const ok = (res, data) => send(res, 200, { ok: true, data });
const fail = (res, code, error, message) => send(res, code, { ok: false, error, message });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS' };
const readBody = req => new Promise(r => { const a = []; req.on('data', c => a.push(c)); req.on('end', () => r(Buffer.concat(a))); });
function redFlags(s) {
  const out = [];
  let sum = 0;
  for (const l of s.lines) {
    if (l.unit_price == null) out.push('PRICE_MISSING');
    else if (l.qty != null && l.amount != null && Math.abs(r2(l.qty * l.unit_price) - l.amount) >= 0.01) out.push('AMOUNT_MISMATCH');
    sum += l.amount || 0;
  }
  if (s.total == null || Math.abs(r2(sum) - s.total) >= 0.01) out.push('SUM_MISMATCH');
  return out;
}
const photoSvg = n => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100"><rect width="800" height="1100" fill="#fbfaf6"/><text x="60" y="110" font-size="44" font-family="sans-serif" fill="#34312c">示範送貨單（虛構）</text><text x="60" y="170" font-size="26" font-family="sans-serif" fill="#6e6a62">第 ${n} 張</text>${[0, 1, 2, 3, 4, 5, 6].map(i => `<line x1="60" x2="740" y1="${260 + i * 90}" y2="${260 + i * 90}" stroke="#bbb"/><rect x="70" y="${275 + i * 90}" width="${220 + i * 25}" height="14" fill="#ccc"/><rect x="560" y="${275 + i * 90}" width="120" height="14" fill="#ccc"/>`).join('')}</svg>`;
const inBrand = (role, brand, q) => role.role === 'admin' ? (q.get('brand_id') ? q.get('brand_id') === brand : true) : role.brand === brand;
const workBrand = (role, q, body) => role.role === 'admin' ? (q.get('brand_id') || (body && body.brand_id) || 'X') : role.brand;
const need = (res, role, ...ok) => ok.includes(role.role) ? true : (fail(res, 403, 'FORBIDDEN', '無權限'), false);
const mkName = ['豬頭皮', '鴨掌', '高麗菜', '外帶紙碗'];
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams;
  if (!u.pathname.startsWith(P)) return fail(res, 404, 'NOT_FOUND', '找不到');
  const p = u.pathname.slice(P.length);
  const body = await readBody(req);
  const json = () => { try { return JSON.parse(body.toString() || '{}'); } catch { return {}; } };
  if (p === '/health') return ok(res, { up: true });
  if (p === '/login' && req.method === 'POST') {
    const { account, password } = json();
    const a = ACCOUNTS[account];
    if (password !== 'test' || !a) return fail(res, 401, 'AUTH', '帳號或密碼錯誤');
    const token = 'mock-' + Math.random().toString(36).slice(2);
    tokens.set(token, a);
    return ok(res, { token, role: a.role, name: a.name, brand: a.brand, brand_id: a.brand, store_id: a.store_id || null });
  }
  let tok = (req.headers.authorization || '').replace('Bearer ', '');
  if (!tokens.has(tok) && q.get('t')) tok = q.get('t');
  const who = tokens.get(tok);
  if (!who) return fail(res, 401, 'AUTH', '請重新登入');
  const role = who.role;
  const wb = () => workBrand(who, q, null);

  /* ---- P2 管理 ---- */
  if (p === '/stores' && req.method === 'GET') {
    if (role === 'store') return fail(res, 403, 'FORBIDDEN', '無權限');
    return ok(res, stores.filter(s => inBrand(who, s.brand_id, q)));
  }
  let m;
  if ((m = p.match(/^\/admin\/(stores|users)(?:\/(\d+))?$/))) {
    if (!need(res, who, 'admin')) return;
    const tbl = m[1] === 'stores' ? stores : users;
    if (req.method === 'GET') return ok(res, tbl);
    const b = json(); delete b.password;
    if (req.method === 'POST') { const row = { id: ++nextId, ...b }; tbl.push(row); return ok(res, row); }
    if (req.method === 'PUT') { const row = tbl.find(x => x.id === +m[2]); if (!row) return fail(res, 404, 'NOT_FOUND', '找不到'); Object.assign(row, b); return ok(res, row); }
  }
  if (p === '/vendors' && req.method === 'POST') {
    if (role === 'store') return fail(res, 403, 'FORBIDDEN', '無權限');
    const b = json(), row = { id: ++nextId, name: b.name, brand_id: workBrand(who, q, b), active: b.active ?? 1 }; vendors.push(row); return ok(res, row);
  }
  if (p === '/vendors') {
    if (role === 'store') return ok(res, vendors.filter(v => v.brand_id === who.brand && v.active).map(v => ({ id: v.id, name: v.name })));
    return ok(res, vendors.filter(v => inBrand(who, v.brand_id, q) && (q.get('all') || v.active)));
  }
  if ((m = p.match(/^\/vendors\/(\d+)$/)) && req.method === 'PUT') {
    if (role === 'store') return fail(res, 403, 'FORBIDDEN', '無權限');
    const v = vendors.find(x => x.id === +m[1]); if (!v) return fail(res, 404, 'NOT_FOUND', '找不到'); Object.assign(v, json()); return ok(res, v);
  }
  if (p === '/items/suggest') {
    if (role === 'store') return fail(res, 403, 'FORBIDDEN', '無權限');
    const raw = q.get('raw') || '', b = wb();
    const sc = it => { let n = 0; for (const ch of new Set(it.name)) if (raw.includes(ch)) n++; return n / Math.max(it.name.length, 1); };
    return ok(res, items.filter(i => i.brand_id === b && i.active).map(i => ({ id: i.id, name: i.name, score: r2(sc(i)) })).filter(x => x.score > 0).sort((a, c) => c.score - a.score).slice(0, 3));
  }
  if (p === '/items') {
    if (role === 'store') return fail(res, 403, 'FORBIDDEN', '無權限');
    if (req.method === 'GET') { const k = q.get('q') || '', b = wb(); return ok(res, items.filter(i => i.brand_id === b && (!k || i.name.includes(k))).map(({ brand_id, ...r }) => r)); }
    if (req.method === 'POST') {
      const b = json(), br = workBrand(who, q, b);
      if (!['食材', '包材', '雜貨', '其他'].includes(b.category)) return fail(res, 400, 'BAD_INPUT', '類別只能是 食材／包材／雜貨／其他');
      if (items.some(i => i.brand_id === br && i.name === b.name)) return fail(res, 409, 'CONFLICT', '已有同名品項');
      const row = { id: ++nextId, name: b.name, category: b.category, base_unit: b.base_unit, active: b.active ?? 1, brand_id: br }; items.push(row);
      const { brand_id, ...out } = row; return ok(res, out);
    }
  }
  if ((m = p.match(/^\/items\/(\d+)(\/units)?$/))) {
    if (role === 'store') return fail(res, 403, 'FORBIDDEN', '無權限');
    const it = items.find(x => x.id === +m[1]); if (!it) return fail(res, 404, 'NOT_FOUND', '找不到品項');
    if (!m[2] && req.method === 'PUT') { const b = json(); delete b.brand_id; Object.assign(it, b); const { brand_id, ...out } = it; return ok(res, out); }
    if (m[2] && req.method === 'GET') return ok(res, units[it.id] || []);
    if (m[2] && req.method === 'PUT') { const b = json(); if (!Array.isArray(b) || b.some(x => !(x.factor > 0))) return fail(res, 400, 'BAD_INPUT', '換算要大於 0'); units[it.id] = b; return ok(res, b); }
  }

  /* ---- P2 報表 ---- */
  if (p.startsWith('/reports') || p === '/alerts' || p === '/export/legacy.xlsx') {
    if (role === 'store') return fail(res, 403, 'FORBIDDEN', '無權限');
    const b = wb(), mult = b === 'X' ? 1 : b === 'M' ? 1.6 : 2.2, sid = q.get('store_id');
    if (p === '/reports/cost') {
      const f = sid ? 0.55 : 1;
      const cat = { 食材: 126400 * mult * f, 包材: 18200 * mult * f, 雜貨: 6900 * mult * f, 其他: 2100 * mult * f, 未分類: 4350 * mult * f };
      Object.keys(cat).forEach(k => cat[k] = r2(cat[k]));
      const total = r2(Object.values(cat).reduce((s, x) => s + x, 0));
      const vn = vendors.filter(v => v.brand_id === b && v.active).map(v => v.name).concat(['示範調味行']);
      return ok(res, { total, by_category: cat, by_vendor: vn.map((v, i) => ({ vendor: v, amount: r2(total * [0.4, 0.3, 0.2, 0.1][i % 4] / (vn.length > 4 ? 1 : 1)) })).slice(0, 4), by_store: sid ? stores.filter(s => String(s.id) === sid).map(s => ({ store: s.name, store_id: s.id, amount: total })) : stores.filter(s => s.brand_id === b).map((s, i) => ({ store: s.name, store_id: s.id, amount: r2(total * (i ? 0.45 : 0.55)) })) });
    }
    if (p === '/reports/price') {
      const it = items.find(x => String(x.id) === q.get('item_id'));
      if (!it) return fail(res, 404, 'NOT_FOUND', '找不到品項');
      const base = 40 + it.id * 7, pts = [];
      ['2026-07-08', '2026-07-29', '2026-08-12', '2026-08-30', '2026-09-10', '2026-09-24', '2026-10-01', '2026-10-02'].forEach((d, i) => pts.push({ doc_date: d, vendor: vendors.find(v => v.brand_id === b)?.name || '示範廠商', unit_cost: r2(base + [0, 2, -1, 3, 5, 4, 8, 6][i]), slip_id: 'S' + d.replace(/-/g, '') + '-000' + (i + 1) }));
      return ok(res, { item: it.name, base_unit: it.base_unit, points: pts, avg_month: r2(base + 7), avg_3m: r2(base + 4.6) });
    }
    if (p === '/reports/daily') {
      const rows = [];
      for (let d = 1; d <= 5; d++) for (const [i, n] of mkName.entries()) if ((d + i) % 2 === 0) { const qty = 5 + d * 2, up = 40 + i * 30; rows.push({ doc_date: '2026-10-0' + d, store: '光復店', vendor: '示範肉品行', item: n, raw_name: n + (i === 3 ? '（箱）' : ''), qty, unit: i === 3 ? '箱' : '斤', unit_price: up, amount: qty * up, base_qty: qty, unit_cost: up }); }
      rows.push({ doc_date: '2026-10-05', store: '光復店', vendor: '示範蔬果行', item: null, raw_name: '範例菇類', qty: 3, unit: '袋', unit_price: 150, amount: 450, base_qty: null, unit_cost: null });
      return ok(res, rows.filter(r => r.doc_date >= q.get('from') && r.doc_date <= q.get('to')));
    }
    if (p === '/alerts') return ok(res, [
      { id: 1, created_at: '2026-10-02T03:10:00Z', item: '豬頭皮', vendor: '示範肉品行', store: '光復店', prev_price: 50, new_price: 56, pct: 12, direction: 'up', slip_id: 'S20261002-0003' },
      { id: 2, created_at: '2026-10-01T05:40:00Z', item: '高麗菜', vendor: '示範蔬果行', store: '光復店', prev_price: 16, new_price: 15, pct: -6.3, direction: 'down', slip_id: 'S20261001-0002' },
      { id: 3, created_at: '2026-10-01T05:20:00Z', item: '外帶紙碗', vendor: '示範肉品行', store: '示範二店', prev_price: 880, new_price: 920, pct: 4.5, direction: 'up', slip_id: 'S20261001-0001' }]);
    if (p === '/export/legacy.xlsx') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="legacy.xlsx"', ...cors });
      return res.end(Buffer.from('PK\u0003\u0004mock-xlsx-not-a-real-file'));
    }
  }

  if (p === '/pnl-map') {
    if (req.method === 'PUT') return ok(res, { entries: json().entries || [], requeued: 0 });
    return ok(res, { categories: ['食材', '包材', '雜貨', '其他'], entries: [{ vendor_id: 1, category: '食材', acc_id: '5101' }],
      unmapped: [{ store_name: '光復店', month: '2026-10', vendor: '示範蔬果行', category: '未分類', reason: '未對照', amount: 2400 }], unmapped_total: 2400,
      stuck: [{ store_id: 1, store_name: '光復店', month: '2026-09', state: 'locked', reason: '月份已定稿' }], stores: stores.filter(s => inBrand(who, s.brand_id, q)) });
  }
  /* ---- P1 ---- */
  if (p === '/slips' && req.method === 'POST') {
    if (role !== 'store') return fail(res, 403, 'FORBIDDEN', '只有門市能上傳');
    const text = body.toString('latin1');
    const cid = (text.match(/name="client_id"\r\n\r\n([^\r]+)/) || [])[1];
    if (!cid || !/^[0-9a-f-]{36}$/.test(cid)) return fail(res, 400, 'BAD_INPUT', 'client_id 格式錯誤');
    if (clientIds.has(cid)) return fail(res, 409, 'CONFLICT', '這張貨單已收過');
    const nphotos = (text.match(/name="photos\[\]"/g) || []).length;
    if (!nphotos) return fail(res, 400, 'BAD_INPUT', '沒有照片');
    const vid = (text.match(/name="vendor_id"\r\n\r\n([^\r]+)/) || [])[1];
    const vname = (text.match(/name="vendor_name"\r\n\r\n([^\r]+)/) || [])[1];
    const id = 'S20261003-' + String(++seq).padStart(4, '0');
    clientIds.set(cid, id);
    const v = vendors.find(x => String(x.id) === vid);
    slips.push(mk(id, 'queued', v ? v.name : (vname ? Buffer.from(vname, 'latin1').toString('utf8') : ''), [], { brand_id: who.brand, store_id: who.store_id, photo_count: nphotos, uploaded_at: new Date().toISOString().slice(0, 19) }));
    return ok(res, { id, client_id: cid, status: 'queued' });
  }
  if (p === '/slips' && req.method === 'GET') {
    return ok(res, slips.filter(s => s.store_id === who.store_id).map(s => ({ id: s.id, vendor_name: s.vendor_name, status: s.status, uploaded_at: s.uploaded_at, return_reason: s.return_reason || '' })).reverse());
  }
  if (p === '/review') {
    const st = q.get('status') || 'review';
    return ok(res, slips.filter(s => s.status === st && inBrand(who, s.brand_id, q)).map(s => ({ id: s.id, vendor_name: s.vendor_name, store_name: s.store_name, doc_date: s.doc_date, total: s.total, flags: s.flags.concat(redFlags(s)), uploaded_at: s.uploaded_at })));
  }
  if ((m = p.match(/^\/photos\/([^/]+)\/(\d+)$/))) {
    const s = slips.find(x => x.id === m[1]); const f = s && s.photos[+m[2] - 1];
    if (!f) return fail(res, 404, 'NOT_FOUND', '沒有這張照片');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', ...cors }); return res.end(photoSvg(m[2]));
  }
  if ((m = p.match(/^\/slips\/([^/]+)(\/(confirm|unconfirm|return|reopen|retry))?$/))) {
    const s = slips.find(x => x.id === m[1]);
    if (!s) return fail(res, 404, 'NOT_FOUND', '找不到貨單');
    if (role === 'store') return fail(res, 403, 'FORBIDDEN', '無權限');
    if (!m[2] && req.method === 'GET') return ok(res, s);
    if (!m[2] && req.method === 'PUT') {
      const b = json();
      if ('doc_date' in b && !/^(\d{4}|\d{3})[-/]\d{2}[-/]\d{2}$/.test(String(b.doc_date || ''))) return fail(res, 400, 'BAD_INPUT', '日期格式看不懂，請重新輸入');
      for (const k of ['vendor_name', 'doc_date', 'doc_no', 'total', 'subtotal', 'tax']) if (k in b) s[k] = b[k];
      if ('doc_date' in b) s.flags = s.flags.filter(f => f !== 'DATE_FIXED');
      if (s.status === 'failed') s.status = 'review';
      if (b.lines) s.lines = b.lines.map((l, i) => ({ ...l, id: l.id || s.id + '-N' + Date.now() + i, flags: ((s.lines.find(o => o.id === l.id) || {}).flags || []).filter(f => !['AMOUNT_MISMATCH', 'PRICE_MISSING'].includes(f) && !(f === 'ITEM_UNMAPPED' && l.item_id)) }));
      return ok(res, s);
    }
    if (m[3] === 'retry') { s.status = 'queued'; return ok(res, { id: s.id, status: s.status }); }
    if (m[3] === 'confirm') {
      const reds = redFlags(s);
      if (reds.length || s.lines.some(l => !l.checked)) return fail(res, 409, 'RED_FLAGS', '還有紅色檢核或未打勾的列：' + reds.join('、'));
      s.status = 'confirmed'; return ok(res, { id: s.id, status: s.status });
    }
    if (m[3] === 'unconfirm') { if (!json().reason) return fail(res, 400, 'BAD_INPUT', '必須填寫原因'); s.status = 'review'; return ok(res, { id: s.id, status: s.status }); }
    if (m[3] === 'reopen') { if (s.status !== 'returned') return fail(res, 409, 'CONFLICT', '只有退回的貨單可以重新開放'); s.status = 'review'; return ok(res, s); }
    if (m[3] === 'return') { s.status = 'returned'; s.return_reason = json().reason || ''; return ok(res, { id: s.id, status: s.status }); }
  }
  fail(res, 404, 'NOT_FOUND', '找不到路徑 ' + p);
});
server.listen(PORT, () => console.log('mock server on http://localhost:' + PORT + P));
