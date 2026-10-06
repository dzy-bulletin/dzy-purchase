'use strict';
// 帳號：scrypt 加鹽雜湊、session（token 只存 SHA-256）、連錯 5 次鎖 15 分、角色檢查
const crypto = require('crypto');
const { ApiError } = require('./http-util');

const STORE_DAYS = 90, USER_DAYS = 30;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 3 || p[0] !== 'scrypt') return false;
  const want = Buffer.from(p[2], 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(p[1], 'hex'), want.length);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const DUMMY = hashPassword('dummy-not-a-real-password');   // 帳號不存在時也跑一次雜湊，回應時間不洩漏帳號是否存在

function findAccount(db, account) {
  const acc = String(account || '').trim();
  if (/^[A-Za-z0-9]{2,10}$/.test(acc)) {          // 門市代號：大寫英數 2–10 字（登入時不分大小寫）；找不到再當會計帳號
    const r = db.prepare('SELECT * FROM stores WHERE code = ?').get(acc.toUpperCase());
    if (r) return { kind: 'store', row: r };
  }
  const r = db.prepare('SELECT * FROM users WHERE username = ?').get(acc);
  return r ? { kind: 'user', row: r } : null;
}

// 會計有權的品牌（user_brands）；目前品牌＝session 記的那個（必須仍在清單內），否則退回預設品牌、再不然清單第一個
function brandsOf(db, userId) {
  return db.prepare('SELECT b.id, b.name FROM user_brands ub JOIN brands b ON b.id = ub.brand_id WHERE ub.user_id = ? ORDER BY b.id').all(userId);
}
function currentBrand(brands, sessionBrand, defaultBrand) {
  const ids = brands.map((b) => b.id);
  if (sessionBrand && ids.includes(sessionBrand)) return sessionBrand;
  if (defaultBrand && ids.includes(defaultBrand)) return defaultBrand;
  return ids[0] || null;
}
function principalOf(kind, row, db, sessionBrand) {
  if (kind === 'store') return { kind, role: 'store', must_change_password: !!row.must_change_password, id: row.id, store_id: row.id, brand_id: row.brand_id, brands: [], name: row.name, code: row.code };
  const brands = row.role === 'accountant' ? brandsOf(db, row.id) : [];
  const brand = row.role === 'accountant' ? currentBrand(brands, sessionBrand, row.brand_id) : row.brand_id;
  return { kind, role: row.role, id: row.id, store_id: null, must_change_password: !!row.must_change_password, brand_id: brand, brands, name: row.name, username: row.username };
}
const whoOf = (p) => `${p.kind}:${p.id}`;

const STORE_LOGIN_OFF_MSG = '門市請改用門市營運系統登入';

function login(db, account, password, now, opts) {
  now = now || new Date();
  if (typeof account !== 'string' || typeof password !== 'string' || !account || !password) throw new ApiError('BAD_INPUT', '請輸入帳號與密碼');
  const found = findAccount(db, account);
  if (!found) { verifyPassword(password, DUMMY); throw new ApiError('AUTH', '帳號或密碼錯誤'); }
  const { kind, row } = found;
  if (kind === 'store' && opts && opts.storeLoginOff) throw new ApiError('FORBIDDEN', STORE_LOGIN_OFF_MSG);
  const table = kind === 'store' ? 'stores' : 'users';
  if (row.locked_until && new Date(row.locked_until) > now) throw new ApiError('LOCKED', '密碼錯誤次數過多，已鎖定 15 分鐘，請稍後再試');
  if (!row.active || !verifyPassword(password, row.pass_hash)) {
    if (!row.active) throw new ApiError('AUTH', '帳號或密碼錯誤');
    const fails = row.fail_count + 1;
    if (fails >= 5) db.prepare(`UPDATE ${table} SET fail_count = 0, locked_until = ? WHERE id = ?`).run(new Date(now.getTime() + 15 * 60e3).toISOString(), row.id);
    else db.prepare(`UPDATE ${table} SET fail_count = ? WHERE id = ?`).run(fails, row.id);
    throw new ApiError('AUTH', '帳號或密碼錯誤');
  }
  db.prepare(`UPDATE ${table} SET fail_count = 0, locked_until = NULL WHERE id = ?`).run(row.id);
  const p = principalOf(kind, row, db, null);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(now.getTime() + (kind === 'store' ? STORE_DAYS : USER_DAYS) * 86400e3).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, who, expires_at, created_at, brand_id) VALUES (?,?,?,?,?)').run(sha256(token), whoOf(p), expires, now.toISOString(), p.role === 'accountant' ? p.brand_id : null);
  return { principal: p, token, expires_at: expires };
}

// 從 Authorization: Bearer 取出登入者；沒帶、過期、帳號停用都回 AUTH
function authenticate(db, req, now, opts) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
  if (!m) throw new ApiError('AUTH', '請先登入');
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(m[1].toLowerCase()));
  if (!s || new Date(s.expires_at) < (now || new Date())) throw new ApiError('AUTH', '登入已過期，請重新登入');
  const [kind, id] = s.who.split(':');
  if (kind === 'store' && opts && opts.storeLoginOff) throw new ApiError('AUTH', STORE_LOGIN_OFF_MSG);   // 舊門市 session 一併失效
  const row = db.prepare(`SELECT * FROM ${kind === 'store' ? 'stores' : 'users'} WHERE id = ?`).get(Number(id));
  if (!row || !row.active) throw new ApiError('AUTH', '帳號已停用');
  const p = principalOf(kind, row, db, s.brand_id); p.token_hash = s.token_hash;
  return p;
}

// 服務金鑰通道：X-Store-Key（等長常數時間比對）＋X-Store-Code → 該門市的 principal（形狀同門市登入）
// 回 null＝沒帶金鑰標頭（走一般登入）；通道關閉或金鑰錯、門市不存在／停用一律 AUTH
function authenticateServiceKey(db, req, svcKey) {
  const k = req.headers['x-store-key'];
  if (k === undefined) return null;
  const want = crypto.createHash('sha256').update(String(svcKey || '')).digest();
  const got = crypto.createHash('sha256').update(String(k)).digest();
  const ok = crypto.timingSafeEqual(want, got) && !!svcKey;      // 先雜湊成等長再比，不洩漏長度
  if (!ok) throw new ApiError('AUTH', '服務金鑰錯誤');
  const code = String(req.headers['x-store-code'] || '').trim().toUpperCase();
  const row = /^[A-Z0-9]{2,10}$/.test(code) ? db.prepare('SELECT * FROM stores WHERE code = ?').get(code) : null;
  if (!row || !row.active) throw new ApiError('AUTH', '門市代號不存在或已停用');
  const p = principalOf('store', row, db, null);
  p.must_change_password = false; p.via_service_key = true;
  return p;
}

// 會計切換目前品牌：必須在自己的 user_brands 內，否則 FORBIDDEN
function switchBrand(db, principal, brandId) {
  if (principal.role !== 'accountant') throw new ApiError('FORBIDDEN', '只有會計帳號可以切換品牌');
  if (typeof brandId !== 'string' || !principal.brands.some((b) => b.id === brandId)) throw new ApiError('FORBIDDEN', '沒有這個品牌的權限');
  db.prepare('UPDATE sessions SET brand_id = ? WHERE token_hash = ?').run(brandId, principal.token_hash);
  principal.brand_id = brandId;
  return principal;
}

// 自己改密碼（所有角色隨時可用；首次登入強制改密碼也走這裡）。成功：旗標清 0、該帳號所有 session 作廢、回新 token
function changePassword(db, principal, oldPw, newPw, now) {
  now = now || new Date();
  if (typeof oldPw !== 'string' || typeof newPw !== 'string' || !oldPw || !newPw) throw new ApiError('BAD_INPUT', '請輸入舊密碼與新密碼');
  if (newPw.length < 6 || newPw.length > 200) throw new ApiError('BAD_INPUT', '新密碼至少 6 個字');
  if (newPw === oldPw) throw new ApiError('BAD_INPUT', '新密碼不可與舊密碼相同');
  const table = principal.kind === 'store' ? 'stores' : 'users';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(principal.id);
  if (!verifyPassword(oldPw, row.pass_hash)) throw new ApiError('BAD_INPUT', '舊密碼不正確');
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(now.getTime() + (principal.kind === 'store' ? STORE_DAYS : USER_DAYS) * 86400e3).toISOString();
  db.tx(() => {
    db.prepare(`UPDATE ${table} SET pass_hash = ?, must_change_password = 0, fail_count = 0, locked_until = NULL WHERE id = ?`).run(hashPassword(newPw), principal.id);
    db.prepare('DELETE FROM sessions WHERE who = ?').run(whoOf(principal));
    db.prepare('INSERT INTO sessions (token_hash, who, expires_at, created_at, brand_id) VALUES (?,?,?,?,?)').run(sha256(token), whoOf(principal), expires, now.toISOString(), principal.role === 'accountant' ? principal.brand_id : null);
  });
  return { token, expires_at: expires };
}

function logout(db, principal) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(principal.token_hash); }

function requireRole(principal, ...roles) {
  if (!principal || !roles.includes(principal.role)) throw new ApiError('FORBIDDEN', '這個帳號沒有權限做這件事');
  return principal;
}

// 品牌隔離：admin 全部；會計只能碰自己品牌；門市只能碰自己門市
function canSeeSlip(p, slip, { storeOwn = true } = {}) {
  if (p.role === 'admin') return true;
  if (p.role === 'accountant') return !!p.brand_id && p.brand_id === slip.brand_id;
  if (p.role === 'store') return storeOwn && p.store_id === slip.store_id;
  return false;
}

module.exports = { authenticateServiceKey, changePassword, hashPassword, verifyPassword, login, authenticate, logout, switchBrand, requireRole, canSeeSlip, whoOf, sha256 };
