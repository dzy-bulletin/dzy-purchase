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
  if (/^[XMC]\d{2}$/i.test(acc)) {
    const r = db.prepare('SELECT * FROM stores WHERE code = ?').get(acc.toUpperCase());
    return r ? { kind: 'store', row: r } : null;
  }
  const r = db.prepare('SELECT * FROM users WHERE username = ?').get(acc);
  return r ? { kind: 'user', row: r } : null;
}

function principalOf(kind, row) {
  if (kind === 'store') return { kind, role: 'store', id: row.id, store_id: row.id, brand_id: row.brand_id, name: row.name, code: row.code };
  return { kind, role: row.role, id: row.id, store_id: null, brand_id: row.brand_id, name: row.name, username: row.username };
}
const whoOf = (p) => `${p.kind}:${p.id}`;

function login(db, account, password, now) {
  now = now || new Date();
  if (typeof account !== 'string' || typeof password !== 'string' || !account || !password) throw new ApiError('BAD_INPUT', '請輸入帳號與密碼');
  const found = findAccount(db, account);
  if (!found) { verifyPassword(password, DUMMY); throw new ApiError('AUTH', '帳號或密碼錯誤'); }
  const { kind, row } = found;
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
  const p = principalOf(kind, row);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(now.getTime() + (kind === 'store' ? STORE_DAYS : USER_DAYS) * 86400e3).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, who, expires_at, created_at) VALUES (?,?,?,?)').run(sha256(token), whoOf(p), expires, now.toISOString());
  return { principal: p, token, expires_at: expires };
}

// 從 Authorization: Bearer 取出登入者；沒帶、過期、帳號停用都回 AUTH
function authenticate(db, req, now) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
  if (!m) throw new ApiError('AUTH', '請先登入');
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(m[1].toLowerCase()));
  if (!s || new Date(s.expires_at) < (now || new Date())) throw new ApiError('AUTH', '登入已過期，請重新登入');
  const [kind, id] = s.who.split(':');
  const row = db.prepare(`SELECT * FROM ${kind === 'store' ? 'stores' : 'users'} WHERE id = ?`).get(Number(id));
  if (!row || !row.active) throw new ApiError('AUTH', '帳號已停用');
  const p = principalOf(kind, row); p.token_hash = s.token_hash;
  return p;
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

module.exports = { hashPassword, verifyPassword, login, authenticate, logout, requireRole, canSeeSlip, whoOf, sha256 };
