'use strict';
// T17：損益科目對照管理 API（GET／PUT /pnl-map）。會計＝自己品牌、admin＝指定 brand_id。
// 對照以「廠商×類別 → 科目代號」整份覆蓋（同 units 的做法）；改動到的 廠商×類別 會讓受影響的 店×月 重推。
const { ApiError } = require('./http-util');
const { audit } = require('./db');
const { CATEGORIES } = require('./calc');
const { normText } = require('./slips-common');
const P = require('./pnl-push');

module.exports = function register(ctx) {
  const { route, db, A, readBody, parseJson, now } = ctx;
  const iso = () => now().toISOString();

  function brandOf(p, given) {
    if (p.role === 'accountant') {
      if (!p.brand_id) throw new ApiError('FORBIDDEN', '這個會計帳號沒有設定品牌');
      if (given && given !== p.brand_id) throw new ApiError('FORBIDDEN', '不能操作其他品牌的資料');
      return p.brand_id;
    }
    if (!given) throw new ApiError('BAD_INPUT', '管理者請指定 brand_id');
    if (!db.prepare('SELECT 1 FROM brands WHERE id = ?').get(given)) throw new ApiError('BAD_INPUT', '找不到這個品牌');
    return given;
  }
  const entriesOf = (brand) => db.prepare(`SELECT m.vendor_id, v.name vendor_name, m.category, m.acc_id FROM pnl_map m JOIN vendors v ON v.id = m.vendor_id
    WHERE m.brand_id = ? ORDER BY v.name, m.category`).all(brand);

  route('GET', /^\/pnl-map$/, ['accountant', 'admin'], async ({ p, url }) => {
    const brand = brandOf(p, url.searchParams.get('brand_id') || undefined);
    const un = P.unmappedReport(db, { brandId: brand });
    const stores = db.prepare("SELECT id, code, name FROM stores WHERE brand_id = ? AND pnl_unit_code IS NOT NULL AND pnl_unit_code <> '' ORDER BY code").all(brand);
    return { brand_id: brand, categories: CATEGORIES, entries: entriesOf(brand), unmapped: un.rows, unmapped_total: un.total, stores, stuck: ctx.pnlPush.terminalList(brand) };
  });

  // 手動「重推此店此月」（定案 #3）：清終態（已定稿／被拒收）與退避，重新排入；會計限本品牌的門市、admin 不限
  route('POST', /^\/pnl-push\/retry$/, ['accountant', 'admin'], async ({ req, p }) => {
    const b = parseJson(await readBody(req, 16 * 1024));
    const month = String(b.month == null ? '' : b.month);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError('BAD_INPUT', 'month 要是 YYYY-MM');
    const store = db.prepare('SELECT id, code, brand_id, pnl_unit_code FROM stores WHERE id = ?').get(Number(b.store_id));
    if (!store) throw new ApiError('BAD_INPUT', '找不到這間門市');
    if (p.role === 'accountant' && store.brand_id !== p.brand_id) throw new ApiError('FORBIDDEN', '不能操作其他品牌的門市');
    if (!store.pnl_unit_code) throw new ApiError('BAD_INPUT', '這間門市沒有設定損益門市代號，不會推送');
    return db.tx(() => {
      P.retryNow(db, store.id, month, iso());
      audit(db, A.whoOf(p), 'pnl_push_retry', null, null, { store: store.code, month });
      return { queued: true, store_id: store.id, month };
    });
  });

  route('PUT', /^\/pnl-map$/, ['accountant', 'admin'], async ({ req, p }) => {
    const b = parseJson(await readBody(req, 256 * 1024));
    const brand = brandOf(p, b.brand_id);
    if (!Array.isArray(b.entries)) throw new ApiError('BAD_INPUT', '請送 entries 陣列');
    const next = new Map();
    for (const x of b.entries) {
      if (!x || typeof x !== 'object') throw new ApiError('BAD_INPUT', '對照格式錯誤');
      const acc = normText(x.acc_id, 31);
      if (!acc) continue;                                               // 空白＝沒有對照（等於刪除）
      if (acc.length > 30 || /\s/.test(acc)) throw new ApiError('BAD_INPUT', '科目代號不可含空白、最長 30 字');
      if (!CATEGORIES.includes(x.category)) throw new ApiError('BAD_INPUT', `類別只能是 ${CATEGORIES.join('、')}`);
      const vid = Number(x.vendor_id);
      if (!db.prepare('SELECT 1 FROM vendors WHERE id = ? AND brand_id = ?').get(vid, brand)) throw new ApiError('BAD_INPUT', 'vendor_id 不存在或不屬於這個品牌');
      const k = `${vid}|${x.category}`;
      if (next.has(k)) throw new ApiError('BAD_INPUT', '同一個廠商＋類別重複');
      next.set(k, { vendor_id: vid, category: x.category, acc_id: acc });
    }
    return db.tx(() => {
      const before = entriesOf(brand);
      const old = new Map(before.map((r) => [`${r.vendor_id}|${r.category}`, r.acc_id]));
      const changed = [];
      for (const [k, v] of next) if (old.get(k) !== v.acc_id) changed.push(v);
      for (const [k] of old) if (!next.has(k)) { const [vid, cat] = k.split('|'); changed.push({ vendor_id: Number(vid), category: cat }); }
      db.prepare('DELETE FROM pnl_map WHERE brand_id = ?').run(brand);
      const ins = db.prepare('INSERT INTO pnl_map (brand_id, vendor_id, category, acc_id) VALUES (?,?,?,?)');
      for (const v of next.values()) ins.run(brand, v.vendor_id, v.category, v.acc_id);
      let marked = 0;
      for (const c of changed) marked += P.markForVendorCategory(db, c.vendor_id, c.category, iso());   // 對照變更 → 受影響的店×月重推
      const after = entriesOf(brand);
      audit(db, A.whoOf(p), 'pnl_map_update', null, before, after);
      return { brand_id: brand, entries: after, changed: changed.length, requeued: marked };
    });
  });
};
