'use strict';
// T10／T11：管理 API（門市、帳號）與基本資料（廠商、品名、單位換算）、品名建議
const { ApiError } = require('./http-util');
const { hashPassword } = require('./auth');
const { audit } = require('./db');
const { CATEGORIES } = require('./calc');
const { normText } = require('./slips-common');
const P = require('./pnl-push');

const STORE_CODE = /^[A-Z0-9]{2,10}$/;            // P4：門市代號＝實際代號（CF、MDGF、MZTGF…），不再綁品牌字首
const MIN_PW = 6;

module.exports = function register(ctx) {
  const { route, db, A, readBody, parseJson } = ctx;
  const body = async (req) => parseJson(await readBody(req, 256 * 1024));
  const who = (p) => A.whoOf(p);

  // ---------- 小工具 ----------
  const bool = (v, def) => {
    if (v === undefined) return def;
    if (v === true || v === 1 || v === '1') return 1;
    if (v === false || v === 0 || v === '0') return 0;
    throw new ApiError('BAD_INPUT', 'active 必須是 true／false');
  };
  const text = (v, field, max) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) throw new ApiError('BAD_INPUT', `${field} 不可空白`);
    return s.slice(0, max || 100);
  };
  const brandExists = (id) => !!db.prepare('SELECT 1 FROM brands WHERE id = ?').get(id);
  const password = (v) => {
    if (typeof v !== 'string' || v.length < MIN_PW) throw new ApiError('BAD_INPUT', `密碼至少 ${MIN_PW} 個字元`);
    return v;
  };
  const dropSessions = (kind, id) => db.prepare('DELETE FROM sessions WHERE who = ?').run(`${kind}:${id}`);

  // 會計＝自己品牌（給了別的品牌 → FORBIDDEN）；admin＝可指定 brand_id
  function brandOf(p, given, required) {
    if (p.role === 'accountant') {
      if (!p.brand_id) throw new ApiError('FORBIDDEN', '這個會計帳號沒有設定品牌');
      if (given && given !== p.brand_id) throw new ApiError('FORBIDDEN', '不能操作其他品牌的資料');
      return p.brand_id;
    }
    if (given) { if (!brandExists(given)) throw new ApiError('BAD_INPUT', '找不到這個品牌'); return given; }
    if (required) throw new ApiError('BAD_INPUT', '管理者請指定 brand_id');
    return null;
  }
  function own(p, row, what) {
    if (!row) throw new ApiError('NOT_FOUND', `找不到這個${what}`);
    if (p.role === 'accountant' && row.brand_id !== p.brand_id) throw new ApiError('FORBIDDEN', '不能操作其他品牌的資料');
    return row;
  }

  // ---------- 門市 ----------
  route('GET', /^\/stores$/, ['accountant', 'admin'], async ({ p, url }) => {
    const brand = brandOf(p, url.searchParams.get('brand_id') || undefined, false);
    const rows = brand ? db.prepare('SELECT * FROM stores WHERE brand_id = ? ORDER BY code').all(brand) : db.prepare('SELECT * FROM stores ORDER BY code').all();
    return rows.map(storeOut);
  });
  const storeOut = (r) => ({ id: r.id, code: r.code, name: r.name, brand_id: r.brand_id, active: r.active ? 1 : 0 });
  const adminStoreOut = (r) => Object.assign(storeOut(r), { pnl_unit_code: r.pnl_unit_code || '' });   // 損益代號只給管理頁
  const unitCode = (v) => { const t = normText(v, 41); if (t.length > 40 || /\s/.test(t)) throw new ApiError('BAD_INPUT', '損益門市代號不可含空白、最長 40 字'); return t || null; };
  route('GET', /^\/admin\/stores$/, ['admin'], async () => db.prepare('SELECT * FROM stores ORDER BY code').all().map(adminStoreOut));
  route('POST', /^\/admin\/stores$/, ['admin'], async ({ req, p }) => {
    const b = await body(req);
    const code = String(b.code || '').trim().toUpperCase();
    if (!STORE_CODE.test(code)) throw new ApiError('BAD_INPUT', '門市代號格式：大寫英文或數字 2–10 字，例如 MDGF');
    if (!brandExists(b.brand_id)) throw new ApiError('BAD_INPUT', '找不到這個品牌');
    if (db.prepare('SELECT 1 FROM stores WHERE code = ?').get(code)) throw new ApiError('CONFLICT', '這個門市代號已存在');
    if (db.prepare('SELECT 1 FROM users WHERE UPPER(username) = ?').get(code)) throw new ApiError('CONFLICT', '這個代號與某個會計／管理者帳號相同，請改用別的代號');
    const pw = password(b.password);
    return db.tx(() => {
      const id = db.prepare('INSERT INTO stores (brand_id, code, name, pass_hash, active, pnl_unit_code) VALUES (?,?,?,?,?,?)')
        .run(b.brand_id, code, text(b.name, '門市名稱'), hashPassword(pw), bool(b.active, 1), b.pnl_unit_code === undefined ? null : unitCode(b.pnl_unit_code)).lastInsertRowid;
      const row = db.prepare('SELECT * FROM stores WHERE id = ?').get(Number(id));
      audit(db, who(p), 'admin_store_create', null, null, adminStoreOut(row));
      return adminStoreOut(row);
    });
  });
  route('PUT', /^\/admin\/stores\/(\d+)$/, ['admin'], async ({ req, p, m }) => {
    const b = await body(req);
    return db.tx(() => {
      const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(Number(m[1]));
      if (!s) throw new ApiError('NOT_FOUND', '找不到這間門市');
      const set = {};
      if (b.name !== undefined) set.name = text(b.name, '門市名稱');
      if (b.active !== undefined) set.active = bool(b.active);
      const code = b.code !== undefined ? String(b.code).trim().toUpperCase() : s.code;
      const brand = b.brand_id !== undefined ? b.brand_id : s.brand_id;
      if (code !== s.code || brand !== s.brand_id) {
        if (!STORE_CODE.test(code)) throw new ApiError('BAD_INPUT', '門市代號格式不正確');
        if (!brandExists(brand)) throw new ApiError('BAD_INPUT', '找不到這個品牌');
        if (db.prepare('SELECT 1 FROM users WHERE UPPER(username) = ?').get(code)) throw new ApiError('CONFLICT', '這個代號與某個會計／管理者帳號相同，請改用別的代號');
        if (db.prepare('SELECT 1 FROM stores WHERE code = ? AND id <> ?').get(code, s.id)) throw new ApiError('CONFLICT', '這個門市代號已存在');
        if (db.prepare('SELECT 1 FROM slips WHERE store_id = ? LIMIT 1').get(s.id)) throw new ApiError('CONFLICT', '這間門市已有貨單，不能改代號或品牌');
        set.code = code; set.brand_id = brand;
      }
      if (b.pnl_unit_code !== undefined) {
        const uc = unitCode(b.pnl_unit_code);
        if ((s.pnl_unit_code || null) !== uc) {
          set.pnl_unit_code = uc;
          P.retireOldCode(db, s.id, s.pnl_unit_code, new Date().toISOString());        // 舊代號在損益端的機器列要先推 0 撤回（成功才刪待撤回工作）；本地「曾推過」清單換新代號重新來過
          P.markAllForStore(db, s.id, new Date().toISOString());                       // 設定／更換代號 → 該店所有有入帳的月份推一次
        }
      }
      if (b.password !== undefined) { set.pass_hash = hashPassword(password(b.password)); set.fail_count = 0; set.locked_until = null; }
      const cols = Object.keys(set);
      if (cols.length) db.prepare(`UPDATE stores SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), s.id);
      if (b.password !== undefined || set.active === 0) dropSessions('store', s.id);
      const row = db.prepare('SELECT * FROM stores WHERE id = ?').get(s.id);
      audit(db, who(p), 'admin_store_update', null, adminStoreOut(s), Object.assign(adminStoreOut(row), b.password !== undefined ? { password_changed: true } : {}));
      return adminStoreOut(row);
    });
  });

  // ---------- 帳號（會計／管理者）----------
  const brandIdsOf = (id) => db.prepare('SELECT brand_id FROM user_brands WHERE user_id = ? ORDER BY brand_id').all(id).map((r) => r.brand_id);
  const userOut = (r) => ({ id: r.id, username: r.username, name: r.name, role: r.role, brand_id: r.brand_id, brand_ids: brandIdsOf(r.id), active: r.active ? 1 : 0 });
  const isStoreCode = (u) => !!db.prepare('SELECT 1 FROM stores WHERE code = ?').get(String(u).toUpperCase());
  const USERNAME = /^[A-Za-z0-9._-]{3,40}$/;
  function userRole(b, cur) {
    const role = b.role !== undefined ? b.role : cur.role;
    if (!['accountant', 'admin'].includes(role)) throw new ApiError('BAD_INPUT', 'role 只能是 accountant 或 admin');
    // 會計可管多個品牌：brand_ids（陣列）；只給舊欄位 brand_id 則等於只管那一個。brand_id＝預設品牌（必須在 brand_ids 內）
    let ids;
    if (b.brand_ids !== undefined) {
      if (!Array.isArray(b.brand_ids)) throw new ApiError('BAD_INPUT', 'brand_ids 必須是陣列');
      ids = [...new Set(b.brand_ids.map(String))];
    } else if (b.brand_id !== undefined && cur.id && cur.role === 'accountant' && brandIdsOf(cur.id).length) {
      ids = brandIdsOf(cur.id);       // 既有會計只給 brand_id＝改預設品牌，不縮減多品牌（要改清單請給 brand_ids）
      if (b.brand_id && !ids.includes(b.brand_id)) throw new ApiError('BAD_INPUT', '預設品牌必須在 brand_ids 內；要新增品牌請給 brand_ids');
    } else if (b.brand_id !== undefined) ids = b.brand_id ? [b.brand_id] : [];
    else ids = cur.id ? brandIdsOf(cur.id) : [];
    let brand = b.brand_id !== undefined && b.brand_id ? b.brand_id : cur.brand_id;
    if (role === 'admin') { brand = null; ids = []; }
    else {
      if (!ids.length || ids.some((x) => !brandExists(x))) throw new ApiError('BAD_INPUT', '會計帳號必須指定有效的品牌');
      if (!brand || !ids.includes(brand)) brand = ids[0];
    }
    return { role, brand, ids, touched: b.brand_ids !== undefined || b.brand_id !== undefined || b.role !== undefined };
  }
  const setUserBrands = (userId, ids) => {
    db.prepare('DELETE FROM user_brands WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO user_brands (user_id, brand_id) VALUES (?,?)');
    ids.forEach((x) => ins.run(userId, x));
  };
  route('GET', /^\/admin\/users$/, ['admin'], async () => db.prepare('SELECT * FROM users ORDER BY username').all().map(userOut));
  route('POST', /^\/admin\/users$/, ['admin'], async ({ req, p }) => {
    const b = await body(req);
    const username = String(b.username || '').trim();
    if (!USERNAME.test(username)) throw new ApiError('BAD_INPUT', '帳號需 3–40 字元（英數與 . _ -）');
    if (isStoreCode(username)) throw new ApiError('BAD_INPUT', '帳號不可與門市代號相同');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new ApiError('CONFLICT', '這個帳號已存在');
    const { role, brand, ids } = userRole(b, {});
    const pw = password(b.password);
    return db.tx(() => {
      const id = db.prepare('INSERT INTO users (username, role, brand_id, name, pass_hash, active) VALUES (?,?,?,?,?,?)')
        .run(username, role, brand, text(b.name, '姓名'), hashPassword(pw), bool(b.active, 1)).lastInsertRowid;
      setUserBrands(Number(id), ids);
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
      audit(db, who(p), 'admin_user_create', null, null, userOut(row));
      return userOut(row);
    });
  });
  route('PUT', /^\/admin\/users\/(\d+)$/, ['admin'], async ({ req, p, m }) => {
    const b = await body(req);
    return db.tx(() => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(m[1]));
      if (!u) throw new ApiError('NOT_FOUND', '找不到這個帳號');
      const set = {};
      if (b.username !== undefined) {
        const un = String(b.username).trim();
        if (!USERNAME.test(un) || isStoreCode(un)) throw new ApiError('BAD_INPUT', '帳號格式不正確（或與門市代號相同）');
        if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(un, u.id)) throw new ApiError('CONFLICT', '這個帳號已存在');
        set.username = un;
      }
      if (b.name !== undefined) set.name = text(b.name, '姓名');
      if (b.active !== undefined) set.active = bool(b.active);
      let newIds = null;
      if (b.role !== undefined || b.brand_id !== undefined || b.brand_ids !== undefined) { const r = userRole(b, u); set.role = r.role; set.brand_id = r.brand; newIds = r.ids; }
      if (p.kind === 'user' && p.id === u.id && (set.active === 0 || (set.role && set.role !== 'admin'))) throw new ApiError('BAD_INPUT', '不能停用或降級自己的帳號');
      if (b.password !== undefined) { set.pass_hash = hashPassword(password(b.password)); set.fail_count = 0; set.locked_until = null; }
      const cols = Object.keys(set);
      if (newIds) setUserBrands(u.id, newIds);
      if (cols.length) db.prepare(`UPDATE users SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), u.id);
      if (b.password !== undefined || set.active === 0) dropSessions('user', u.id);
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
      audit(db, who(p), 'admin_user_update', null, userOut(u), Object.assign(userOut(row), b.password !== undefined ? { password_changed: true } : {}));
      return userOut(row);
    });
  });

  // ---------- 廠商 ----------
  const vendorOut = (r) => ({ id: r.id, name: r.name, brand_id: r.brand_id, active: r.active ? 1 : 0 });
  const aliasesOf = (v) => {
    if (!Array.isArray(v)) throw new ApiError('BAD_INPUT', 'aliases 必須是字串陣列');
    return JSON.stringify([...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20));
  };
  route('POST', /^\/vendors$/, ['accountant', 'admin'], async ({ req, p }) => {
    const b = await body(req);
    const brand = brandOf(p, b.brand_id, true);
    const name = text(b.name, '廠商名稱');
    if (db.prepare('SELECT 1 FROM vendors WHERE brand_id = ? AND name = ?').get(brand, name)) throw new ApiError('CONFLICT', '這個廠商名稱已存在');
    return db.tx(() => {
      const id = db.prepare('INSERT INTO vendors (brand_id, name, aliases, active) VALUES (?,?,?,?)').run(brand, name, b.aliases === undefined ? '[]' : aliasesOf(b.aliases), bool(b.active, 1)).lastInsertRowid;
      const row = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(id));
      audit(db, who(p), 'vendor_create', null, null, vendorOut(row));
      return vendorOut(row);
    });
  });
  route('PUT', /^\/vendors\/(\d+)$/, ['accountant', 'admin'], async ({ req, p, m }) => {
    const b = await body(req);
    return db.tx(() => {
      const v = own(p, db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(m[1])), '廠商');
      const set = {};
      if (b.name !== undefined) {
        set.name = text(b.name, '廠商名稱');
        if (db.prepare('SELECT 1 FROM vendors WHERE brand_id = ? AND name = ? AND id <> ?').get(v.brand_id, set.name, v.id)) throw new ApiError('CONFLICT', '這個廠商名稱已存在');
      }
      if (b.active !== undefined) set.active = bool(b.active);
      if (b.aliases !== undefined) set.aliases = aliasesOf(b.aliases);
      const cols = Object.keys(set);
      if (cols.length) db.prepare(`UPDATE vendors SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), v.id);
      const row = db.prepare('SELECT * FROM vendors WHERE id = ?').get(v.id);
      audit(db, who(p), 'vendor_update', null, vendorOut(v), vendorOut(row));
      return vendorOut(row);
    });
  });

  // ---------- 品名表 ----------
  const itemOut = (r) => ({ id: r.id, name: r.name, category: r.category, base_unit: r.base_unit, active: r.active ? 1 : 0, brand_id: r.brand_id });
  const category = (v) => { if (!CATEGORIES.includes(v)) throw new ApiError('BAD_INPUT', `類別只能是 ${CATEGORIES.join('、')}`); return v; };

  route('GET', /^\/items$/, ['accountant', 'admin'], async ({ p, url }) => {
    const brand = brandOf(p, url.searchParams.get('brand_id') || undefined, false);
    const q = String(url.searchParams.get('q') || '').trim();
    const w = [], a = [];
    if (brand) { w.push('brand_id = ?'); a.push(brand); }
    if (q) { w.push("name LIKE ? ESCAPE '\\'"); a.push('%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
    return db.prepare(`SELECT * FROM items ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY brand_id, name`).all(...a).map(itemOut);
  });
  route('POST', /^\/items$/, ['accountant', 'admin'], async ({ req, p }) => {
    const b = await body(req);
    const brand = brandOf(p, b.brand_id, true);
    const name = text(b.name, '品名');
    if (db.prepare('SELECT 1 FROM items WHERE brand_id = ? AND name = ?').get(brand, name)) throw new ApiError('CONFLICT', '這個品名已存在');
    return db.tx(() => {
      const id = db.prepare('INSERT INTO items (brand_id, name, category, base_unit, active) VALUES (?,?,?,?,?)')
        .run(brand, name, category(b.category), text(b.base_unit, '統一單位', 20), bool(b.active, 1)).lastInsertRowid;
      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
      audit(db, who(p), 'item_create', null, null, itemOut(row));
      return itemOut(row);
    });
  });
  route('PUT', /^\/items\/(\d+)$/, ['accountant', 'admin'], async ({ req, p, m }) => {
    const b = await body(req);
    return db.tx(() => {
      const it = own(p, db.prepare('SELECT * FROM items WHERE id = ?').get(Number(m[1])), '品項');
      const set = {};
      if (b.name !== undefined) {
        set.name = text(b.name, '品名');
        if (db.prepare('SELECT 1 FROM items WHERE brand_id = ? AND name = ? AND id <> ?').get(it.brand_id, set.name, it.id)) throw new ApiError('CONFLICT', '這個品名已存在');
      }
      if (b.category !== undefined) set.category = category(b.category);
      if (b.base_unit !== undefined) set.base_unit = text(b.base_unit, '統一單位', 20);
      if (b.active !== undefined) set.active = bool(b.active);
      const cols = Object.keys(set);
      if (cols.length) db.prepare(`UPDATE items SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), it.id);
      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(it.id);
      if (set.category && set.category !== it.category) P.markForItem(db, it.id, new Date().toISOString());   // 類別變了 → 對到的損益科目可能不同，含此品項的店×月重推
      audit(db, who(p), 'item_update', null, itemOut(it), itemOut(row));
      return itemOut(row);
    });
  });

  const unitsOf = (id) => db.prepare('SELECT unit, factor_to_base factor FROM unit_conv WHERE item_id = ? ORDER BY unit').all(id);
  route('GET', /^\/items\/(\d+)\/units$/, ['accountant', 'admin'], async ({ p, m }) => {
    own(p, db.prepare('SELECT * FROM items WHERE id = ?').get(Number(m[1])), '品項');
    return unitsOf(Number(m[1]));
  });
  route('PUT', /^\/items\/(\d+)\/units$/, ['accountant', 'admin'], async ({ req, p, m }) => {
    const raw = await readBody(req, 64 * 1024);
    let arr;
    try { arr = raw && raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch (e) { arr = null; }
    if (!Array.isArray(arr)) throw new ApiError('BAD_INPUT', '請送 [{unit,factor}] 陣列');
    return db.tx(() => {
      const it = own(p, db.prepare('SELECT * FROM items WHERE id = ?').get(Number(m[1])), '品項');
      const seen = new Set();
      const rows = arr.map((x) => {
        if (!x || typeof x !== 'object') throw new ApiError('BAD_INPUT', '換算格式錯誤');
        const unit = normText(x.unit, 20);
        const factor = typeof x.factor === 'string' && x.factor.trim() !== '' ? Number(x.factor) : x.factor;
        if (!unit) throw new ApiError('BAD_INPUT', '單位不可空白');
        if (unit === it.base_unit) throw new ApiError('BAD_INPUT', `「${unit}」就是統一單位，不用設定換算`);
        if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) throw new ApiError('BAD_INPUT', `「${unit}」的換算係數必須大於 0`);
        if (seen.has(unit)) throw new ApiError('BAD_INPUT', `單位「${unit}」重複`);
        seen.add(unit);
        return { unit, factor };
      });
      const before = unitsOf(it.id);
      db.prepare('DELETE FROM unit_conv WHERE item_id = ?').run(it.id);
      const ins = db.prepare('INSERT INTO unit_conv (item_id, unit, factor_to_base) VALUES (?,?,?)');
      rows.forEach((r) => ins.run(it.id, r.unit, r.factor));
      const after = unitsOf(it.id);
      audit(db, who(p), 'item_units_update', null, before, after);
      return after;
    });
  });

  // 品名建議：同廠商曾對照過的寫法優先（score 1），其餘用字元二元組相似度＋包含關係
  const bigrams = (s) => { const t = String(s).replace(/\s/g, '').toLowerCase(); const g = new Set(); if (t.length === 1) g.add(t); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
  function similarity(a, b) {
    const x = String(a).replace(/\s/g, '').toLowerCase(), y = String(b).replace(/\s/g, '').toLowerCase();
    if (!x || !y) return 0;
    if (x === y) return 1;
    const A_ = bigrams(x), B_ = bigrams(y);
    let inter = 0; for (const g of A_) if (B_.has(g)) inter++;
    let s = (2 * inter) / (A_.size + B_.size);
    if ((x.includes(y) || y.includes(x)) && Math.min(x.length, y.length) >= 2) s = Math.max(s, 0.5 + 0.4 * Math.min(x.length, y.length) / Math.max(x.length, y.length));
    return s;
  }
  route('GET', /^\/items\/suggest$/, ['accountant', 'admin'], async ({ p, url }) => {
    const raw = normText(url.searchParams.get('raw'), 200);
    const vid = url.searchParams.get('vendor_id');
    let brand = null, vendorId = null;
    if (vid) {
      const v = own(p, db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(vid)), '廠商');
      brand = v.brand_id; vendorId = v.id;
    } else brand = brandOf(p, url.searchParams.get('brand_id') || undefined, true);
    if (!raw) return [];
    const items = db.prepare('SELECT id, name FROM items WHERE brand_id = ? AND active = 1').all(brand);
    const memo = vendorId ? db.prepare('SELECT item_id FROM item_aliases WHERE vendor_id = ? AND raw_name = ?').get(vendorId, raw) : null;
    const out = items.map((i) => ({ id: i.id, name: i.name, score: memo && memo.item_id === i.id ? 1 : Math.round(similarity(raw, i.name) * 100) / 100 }))
      .filter((x) => x.score > 0.2).sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
    return out.slice(0, 3);
  });
};
