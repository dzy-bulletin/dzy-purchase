'use strict';
// 會計從鼎兆元管理系統嵌入（dzy 倉庫 docs/purchase-fin/spec.md §4）
//   POST /sso         {ticket}  兌換管理系統入場券 → 對到 users.dzy_sub（沒有就自動建會計帳號）→ 發 12 小時嵌入 session（回應形狀同 /login，另帶 embed:true）
//   POST /sso/counts  {ticket}  首頁提醒用：兌換＋對帳號（不自動建、不發 session）→ {review, failed}
//   makeResolver：嵌入 session 每 5 分鐘向管理系統重查；連不上最多從 verified_at 起沿用 30 分鐘，之後 503
// .env DZY_PLATFORM_URL／DZY_PURCHASE_SVC_KEY 沒設＝功能關閉，/sso、/sso/counts 一律 FORBIDDEN。
const crypto = require('crypto');
const { ApiError } = require('./http-util');
const { audit } = require('./db');
const { sha256, principalOf, whoOf } = require('./auth');
const { TICKET_RE, BUSINESS_CODES } = require('./dzy');

const EMBED_MS = 12 * 3600e3;          // 嵌入 session 有效期
const RECHECK_MS = 5 * 60e3;           // 超過 5 分鐘沒成功確認就向管理系統重查
const STALE_OK_MS = 30 * 60e3;         // 連不上時從 verified_at 起最多沿用 30 分鐘
const RETRY_BACKOFF_MS = 30e3;         // 上次嘗試失敗後 30 秒內不再重試（避免連不上時每個請求都卡 8 秒）
const SSO_ONLY_HASH = '!sso';          // 自動建的帳號：不是 scrypt 格式，密碼登入永遠失敗（admin 之後設了密碼才可以）

const RATE_MAX = 20;                   // 同一來源每分鐘最多 20 次 /sso＋/sso/counts（合計），超過不打平台（平台兌換要拿全域鎖，防灑券拖慢）
const RATE_WINDOW_MS = 60e3;

const MSG_OFF = '尚未開通從管理系統進入，請洽 Eason';
const MSG_DOWN = '暫時連不上管理系統，請稍後再試';
const MSG_CHANGED = '你在管理系統的權限已變更，請回管理系統重新進入';
const MSG_NO_PERM = '你在管理系統沒有「貨單核對」權限，請洽 Eason';
const MSG_TICKET = '入場券無效或已過期，請回管理系統重新整理';
const MSG_DISABLED = '你的貨單帳號已停用，請洽 Eason';

// 兌券失敗 → 錯誤（/sso 與 /sso/counts 共用）
function failFor(r) {
  if (r.kind === 'unreachable') throw new ApiError('UPSTREAM', MSG_DOWN);
  if (r.kind === 'inactive') throw new ApiError('FORBIDDEN', '你的管理系統帳號已停用，不能進入貨單核對');
  if (r.kind === 'denied') throw new ApiError('FORBIDDEN', MSG_NO_PERM);
  if (r.error === 'unauthorized') { console.error('貨單系統兌換入場券被管理系統拒絕（服務金鑰不一致）'); throw new ApiError('UPSTREAM', '貨單系統與管理系統的連線設定有問題，請洽 Eason'); }
  if (r.error === 'no_perm') throw new ApiError('FORBIDDEN', MSG_NO_PERM);
  if (r.error === 'no_emp') throw new ApiError('FORBIDDEN', '這個管理系統帳號不是同仁，不能使用貨單核對');
  if (r.error !== 'ticket_invalid' && r.error !== 'bad_aud') console.error('管理系統兌換入場券回覆異常：' + String(r.error));
  throw new ApiError('AUTH', MSG_TICKET);
}

// 自動建帳的帳號名稱：dzy-<sub>（冒號換成 -、超過 40 字截斷加尾碼；撞名加尾碼）
function autoUsername(db, sub) {
  const base = ('dzy-' + sub.replace(/:/g, '-')).slice(0, 40);
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const u = base.slice(0, 40 - String(i).length - 1) + '-' + i;
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(u)) return u;
  }
  return 'dzy-' + crypto.randomBytes(8).toString('hex');
}

// 來源 IP：socket remoteAddress；peer 是本機（Tailscale Funnel 進來都是 loopback）才信 X-Forwarded-For 最後一段
function clientIp(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || '');
  if (/^(127\.|::1$|::ffff:127\.)/.test(peer)) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1].slice(0, 64);
  }
  return peer || 'unknown';
}

// 每來源固定一分鐘窗的計數（記憶體 Map；每分鐘順手清掉過期的）
function makeLimiter(now) {
  const hits = new Map();
  let lastSweep = 0;
  return function hit(ip) {
    const t = now().getTime();
    if (t - lastSweep > RATE_WINDOW_MS) { for (const [k, v] of hits) if (t - v.start >= RATE_WINDOW_MS) hits.delete(k); lastSweep = t; }
    let e = hits.get(ip);
    if (!e || t - e.start >= RATE_WINDOW_MS) { e = { start: t, n: 0 }; hits.set(ip, e); }
    e.n++;
    if (e.n > RATE_MAX) throw new ApiError('TOO_MANY', '嘗試太頻繁，請稍後再試');
  };
}

function register(route, { db, dzy, now, readBody, parseJson }) {
  const limit = makeLimiter(now);
  const body = async (req) => parseJson(await readBody(req, 16 * 1024));
  // 先記一次（含格式不對的券），超過上限直接 429；券格式不對直接 BAD_INPUT，兩者都不打平台
  const ticketFrom = async (req) => {
    limit(clientIp(req));
    const b = await body(req);
    if (typeof b.ticket !== 'string' || !b.ticket) throw new ApiError('BAD_INPUT', '缺少入場券');
    if (!TICKET_RE.test(b.ticket)) throw new ApiError('BAD_INPUT', '入場券格式不正確，請回管理系統重新整理');
    return b.ticket;
  };
  const dropSub = (sub) => db.prepare('DELETE FROM sessions WHERE sub = ?').run(sub);

  route('POST', /^\/sso$/, null, async ({ req }) => {
    if (!dzy.enabled()) throw new ApiError('FORBIDDEN', MSG_OFF);
    const ticket = await ticketFrom(req);
    const r = await dzy.redeem(ticket);
    if (r.kind === 'inactive' || r.kind === 'denied') { if (r.ident) dropSub(r.ident.sub); }
    if (r.kind !== 'ok') failFor(r);
    const ident = r.ident;
    const t = now(), iso = t.toISOString();
    let u = db.prepare('SELECT * FROM users WHERE dzy_sub = ?').get(ident.sub);
    if (u && !u.active) { dropSub(ident.sub); throw new ApiError('FORBIDDEN', MSG_DISABLED); }
    const out = db.tx(() => {
      if (!u) {
        const username = autoUsername(db, ident.sub);
        const id = Number(db.prepare("INSERT INTO users (username, role, brand_id, name, pass_hash, active, must_change_password, dzy_sub) VALUES (?, 'accountant', NULL, ?, ?, 1, 0, ?)")
          .run(username, ident.name, SSO_ONLY_HASH, ident.sub).lastInsertRowid);
        u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        audit(db, whoOf({ kind: 'user', id }), 'sso_user_create', null, null, { id, username, name: ident.name, sub: ident.sub, role: 'accountant' });
      }
      const p = principalOf('user', u, db, null);
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(t.getTime() + EMBED_MS).toISOString();
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(iso);
      // 同一個人在管理系統「登出全部裝置／改密碼」之前的嵌入 session 一併作廢
      db.prepare('DELETE FROM sessions WHERE sub = ? AND token_after < ?').run(ident.sub, ident.token_after);
      db.prepare('INSERT INTO sessions (token_hash, who, expires_at, created_at, brand_id, sub, verified_at, tried_at, token_after) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(sha256(token), whoOf(p), expires, iso, p.role === 'accountant' ? p.brand_id : null, ident.sub, iso, iso, ident.token_after);
      audit(db, whoOf(p), 'sso_login', null, null, { sub: ident.sub, emp_no: ident.emp_no });
      return { token, expires_at: expires, role: p.role, must_change_password: false, name: p.name, brand: p.brand_id, brand_id: p.brand_id, brands: p.brands, store_id: null, store: null, embed: true };
    });
    return out;
  });

  // 首頁提醒：會計＝自己全部品牌加總；admin＝全部。帳號還沒建（沒進來過）＝0
  route('POST', /^\/sso\/counts$/, null, async ({ req }) => {
    if (!dzy.enabled()) throw new ApiError('FORBIDDEN', MSG_OFF);
    const ticket = await ticketFrom(req);
    const r = await dzy.redeem(ticket);
    if (r.kind !== 'ok') failFor(r);
    const u = db.prepare('SELECT * FROM users WHERE dzy_sub = ?').get(r.ident.sub);
    if (u && !u.active) throw new ApiError('FORBIDDEN', MSG_DISABLED);
    if (!u) return { review: 0, failed: 0 };
    const cnt = (st) => (u.role === 'admin'
      ? db.prepare('SELECT COUNT(*) c FROM slips WHERE status = ?').get(st).c
      : db.prepare('SELECT COUNT(*) c FROM slips WHERE status = ? AND brand_id IN (SELECT brand_id FROM user_brands WHERE user_id = ?)').get(st, u.id).c);
    return { review: cnt('review'), failed: cnt('failed') };
  });
}

// 嵌入 session 的重查：authenticate 回的 principal（p.embed）在每個請求進路由前跑一次
function makeResolver(db, dzy) {
  const inflight = new Map();
  const drop = (th) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th);
  async function recheck(th, sub, nowDate) {
    const r = await dzy.who(sub);
    const iso = nowDate.toISOString();
    if (r.kind === 'ok') {
      const cur = db.prepare('SELECT token_after FROM sessions WHERE token_hash = ?').get(th);
      if (cur && r.ident.token_after > cur.token_after) { drop(th); return { kind: 'token_changed' }; }   // 在管理系統登出全部裝置／改密碼／被重設
      db.prepare('UPDATE sessions SET verified_at = ?, tried_at = ? WHERE token_hash = ?').run(iso, iso, th);
    } else if (r.kind === 'unreachable' || (r.kind === 'rejected' && !BUSINESS_CODES.has(r.error))) {
      // 連不上，或平台回 200 但不是 JSON／形狀不對（BAD_JSON／BAD_SHAPE／BAD_SCHEMA／SUB_MISMATCH）：不是業務錯誤，當連不上（沿用 30 分鐘規則）
      if (r.kind === 'rejected') console.error('管理系統重查回覆格式異常（' + String(r.error) + '），暫當連不上處理');
      db.prepare('UPDATE sessions SET tried_at = ? WHERE token_hash = ?').run(iso, th);
      return { kind: 'unreachable' };
    } else {
      drop(th);
      if (r.kind === 'rejected') console.error('管理系統重查被拒絕（' + String(r.error) + '），已登出該使用者');
    }
    return r;
  }
  return async function resolve(p, nowDate) {
    const s = p._session;
    delete p._session;
    const th = s.token_hash;
    if (!dzy.enabled()) { drop(th); throw new ApiError('AUTH', MSG_OFF); }
    // admin 把這個帳號的管理系統同仁編號改掉或清掉：嵌入 session 立即失效
    const u = db.prepare('SELECT dzy_sub FROM users WHERE id = ?').get(p.id);
    if (!u || u.dzy_sub !== s.sub) { drop(th); throw new ApiError('AUTH', MSG_CHANGED); }
    let row = s;
    if (nowDate.getTime() - Date.parse(s.verified_at) > RECHECK_MS) {
      const lastTry = Date.parse(s.tried_at || s.verified_at);
      if (nowDate.getTime() - lastTry >= RETRY_BACKOFF_MS || lastTry <= Date.parse(s.verified_at)) {
        let pr = inflight.get(th);
        if (!pr) { pr = recheck(th, s.sub, nowDate).finally(() => inflight.delete(th)); inflight.set(th, pr); }
        const r = await pr;
        if (r.kind !== 'ok' && r.kind !== 'unreachable') throw new ApiError('AUTH', MSG_CHANGED);   // inactive／denied（沒有貨單核對權限）／token_changed／rejected：已刪 session
        row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(th);
        if (!row) throw new ApiError('AUTH', MSG_CHANGED);
      }
    }
    if (nowDate.getTime() - Date.parse(row.verified_at) > STALE_OK_MS) throw new ApiError('UPSTREAM', MSG_DOWN);
    p.verified_at = row.verified_at;
    return p;
  };
}

module.exports = { clientIp, RATE_MAX, register, makeResolver, SSO_ONLY_HASH, EMBED_MS, RECHECK_MS, STALE_OK_MS, MSG_CHANGED, MSG_DOWN };
