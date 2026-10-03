// 開發用假後端：依 spec 6.1 回假資料。node web/dev/mock-server.mjs [port]
// 假帳號（只在這支假伺服器有效）：門市 X01／test，會計 acct／test
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(here, '../../spike/work');
const PORT = +(process.argv[2] || 8794);
const P = '/purchase/api';
const tokens = new Map();
const clientIds = new Map();
const vendors = [{ id: 'V001', name: '示範肉品行' }, { id: 'V002', name: '示範蔬果行' }];
const r2 = n => Math.round(n * 100) / 100;
const mk = (id, status, vendor, lines, extra = {}) => ({
  id, store_id: 'X01', store_name: '光復店', vendor_id: 'V001', vendor_name: vendor, status, doc_date: '2026-10-03', doc_no: 'A' + id.slice(-4),
  total: null, total_handwritten: null, handwritten_note: '', flags: [], uploaded_at: '2026-10-03T09:00:00', photo_count: 1, photos: ['p4.jpg'],
  lines: lines.map((l, i) => ({ id: id + '-L' + (i + 1), seq: i + 1, flags: [], checked: 0, item_id: null, ...l })), ...extra
});
const slips = [
  mk('S20261003-0001', 'review', '示範肉品行', [
    { raw_name: '豬頭皮', qty: 10, unit: '斤', unit_price: 50, amount: 600, flags: ['AMOUNT_MISMATCH'] },
    { raw_name: '鴨掌', qty: 5, unit: '斤', unit_price: 120, amount: 600, flags: ['ITEM_UNMAPPED'] }], { total: 1234, photo_count: 2, photos: ['p4.jpg', 'p6.jpg'] }),
  mk('S20261003-0002', 'review', '示範蔬果行', [
    { raw_name: '範例菇類', qty: 3, unit: '袋', unit_price: null, amount: 450, flags: ['PRICE_MISSING'] },
    { raw_name: '高麗菜', qty: 20, unit: '斤', unit_price: 15, amount: 300, flags: ['HANDWRITTEN'] }], { total: 750, handwritten_note: '高麗菜改 20 斤', photos: ['p9.jpg'] }),
  mk('S20261003-0003', 'review', '示範肉品行', [{ raw_name: '五花肉', qty: 4, unit: '斤', unit_price: 100, amount: 400 }], { total: 400, photos: ['p6.jpg'] })
];
let seq = 3;
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
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith(P)) return fail(res, 404, 'NOT_FOUND', '找不到');
  const p = u.pathname.slice(P.length);
  const body = await readBody(req);
  const json = () => { try { return JSON.parse(body.toString() || '{}'); } catch { return {}; } };
  if (p === '/health') return ok(res, { up: true });
  if (p === '/login' && req.method === 'POST') {
    const { account, password } = json();
    if (password !== 'test' || !['X01', 'acct'].includes(account)) return fail(res, 401, 'AUTH', '帳號或密碼錯誤');
    const token = 'mock-' + Math.random().toString(36).slice(2);
    const role = account === 'acct' ? 'accountant' : 'store';
    tokens.set(token, role);
    return ok(res, { token, role, name: role === 'store' ? '光復店' : '示範會計', brand: 'X', store_id: role === 'store' ? 'X01' : null });
  }
  let tok = (req.headers.authorization || '').replace('Bearer ', '');
  if (!tokens.has(tok) && u.searchParams.get('t')) tok = u.searchParams.get('t');
  const role = tokens.get(tok);
  if (!role) return fail(res, 401, 'AUTH', '請重新登入');
  if (p === '/vendors') return ok(res, vendors);
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
    const v = vendors.find(x => x.id === vid);
    slips.push(mk(id, 'queued', v ? v.name : (vname ? Buffer.from(vname, 'latin1').toString('utf8') : ''), [], { photo_count: nphotos, uploaded_at: new Date().toISOString().slice(0, 19) }));
    return ok(res, { id, client_id: cid, status: 'queued' });
  }
  if (p === '/slips' && req.method === 'GET') {
    return ok(res, slips.map(s => ({ id: s.id, vendor_name: s.vendor_name, status: s.status, uploaded_at: s.uploaded_at, return_reason: s.return_reason || '' })).reverse());
  }
  if (p === '/review') {
    const st = u.searchParams.get('status') || 'review';
    return ok(res, slips.filter(s => s.status === st).map(s => ({ id: s.id, vendor_name: s.vendor_name, store_name: s.store_name, doc_date: s.doc_date, total: s.total, flags: s.flags.concat(redFlags(s)), uploaded_at: s.uploaded_at })));
  }
  let m;
  if ((m = p.match(/^\/photos\/([^/]+)\/(\d+)$/))) {
    const s = slips.find(x => x.id === m[1]); const f = s && s.photos[+m[2] - 1];
    if (!f) return fail(res, 404, 'NOT_FOUND', '沒有這張照片');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', ...cors }); return res.end(fs.readFileSync(path.join(WORK, f)));
  }
  if ((m = p.match(/^\/slips\/([^/]+)(\/(confirm|unconfirm|return|reopen))?$/))) {
    const s = slips.find(x => x.id === m[1]);
    if (!s) return fail(res, 404, 'NOT_FOUND', '找不到貨單');
    if (role === 'store') return fail(res, 403, 'FORBIDDEN', '無權限');
    if (!m[2] && req.method === 'GET') return ok(res, s);
    if (!m[2] && req.method === 'PUT') {
      const b = json();
      for (const k of ['vendor_name', 'doc_date', 'doc_no', 'total']) if (k in b) s[k] = b[k];
      if (b.lines) s.lines = b.lines.map((l, i) => ({ ...l, id: l.id || s.id + '-N' + Date.now() + i, flags: (s.lines.find(o => o.id === l.id) || {}).flags?.filter(f => !['AMOUNT_MISMATCH', 'PRICE_MISSING'].includes(f)) || [] }));
      return ok(res, s);
    }
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
