'use strict';
// 鼎兆元管理系統（平台後端）客戶端：會計從管理系統嵌入進來時，兌換入場券、重查身分。
// 規格：dzy 倉庫 docs/purchase-fin/spec.md §2（平台契約）、§4（本系統）。寫法照門市營運系統 server/dzy.js，簡化成貨單需要的欄位。
// ‧POST、Content-Type text/plain、內文是 JSON 字串 {action, payload:{svc_key, ...}}；成功與業務錯誤一律 HTTP 200，包成 {ok:true,data}｜{ok:false,code|error}。
// ‧逾時 8 秒；redeem 絕不重送（券是一次性的，重送只會變成「券已用過」）。who 失敗也不在這裡重送。
// ‧回型別化結果：
//     {kind:'ok', ident}（active 且 allowed）｜{kind:'denied', ident}（active 但沒有「貨單核對」權限）｜{kind:'inactive', ident:{sub,active:false}}
//     {kind:'unreachable'}（逾時、連線失敗、HTTP 非 200、busy／internal）｜{kind:'rejected', error}（契約列的業務錯誤、壞 JSON、schema 不符、sub 不同）
//   只有 unreachable 可以沿用上次結果。
// ‧.env DZY_PLATFORM_URL、DZY_PURCHASE_SVC_KEY 任一沒設＝功能關閉（enabled() false，/sso 回 FORBIDDEN）。金鑰只放在 body，不進 log。

const SUB_RE = /^(DZY\d{3,}|U:[A-Za-z0-9_-]{1,64})$/;
const TICKET_RE = /^[0-9a-f]{64}$/;
const TIMEOUT_MS = 8000;
const TRANSIENT_CODES = new Set(['internal', 'readonly', 'mirror_readonly', 'busy']);                                // 小寫比對
const BUSINESS_CODES = new Set(['unauthorized', 'ticket_invalid', 'bad_aud', 'no_emp', 'no_perm', 'bad_input']);

const isStr = (v) => typeof v === 'string';
const rej = (error) => ({ kind: 'rejected', error });

// 驗證並整理身分（spec §2 purchaseIdent_）。通過回 ident，不通過回 null。只留契約欄位。
function parseIdent(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (!isStr(d.sub) || !SUB_RE.test(d.sub)) return null;
  if (typeof d.active !== 'boolean') return null;
  if (!d.active) return { sub: d.sub, active: false };
  if (typeof d.allowed !== 'boolean') return null;
  if (!isStr(d.name) || !d.name.trim()) return null;
  if (!isStr(d.emp_no) || (d.emp_no !== '' && !/^DZY\d{3,}$/.test(d.emp_no))) return null;
  if (!Number.isSafeInteger(d.token_after) || d.token_after < 0) return null;
  return { sub: d.sub, active: true, allowed: d.allowed, name: d.name.trim().slice(0, 60), emp_no: d.emp_no, token_after: d.token_after };
}

function create(cfg, overrides) {
  cfg = cfg || {};
  overrides = overrides || {};
  const key = String(cfg.DZY_PURCHASE_SVC_KEY || '').trim();
  const url = String(cfg.DZY_PLATFORM_URL || '').trim();
  const timeoutMs = overrides.timeoutMs || cfg.DZY_TIMEOUT_MS || TIMEOUT_MS;
  const doFetch = overrides.fetch || ((...a) => fetch(...a));
  const log = overrides.log || ((m) => console.error(m));
  const enabled = () => !!(key && url);

  // 一次呼叫。回 {unreachable:true}｜{rejected:error}｜{data}
  async function call(action, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, payload: Object.assign({ svc_key: key }, payload) }), signal: ctrl.signal });
      if (res.status !== 200) return { unreachable: true };
      text = await res.text();
    } catch (e) { return { unreachable: true }; } finally { clearTimeout(timer); }
    let j = null;
    try { j = JSON.parse(text); } catch (e) { return { rejected: 'BAD_JSON' }; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { rejected: 'BAD_SHAPE' };
    if (j.ok === false) {
      const raw = isStr(j.code) && j.code ? j.code : (isStr(j.error) && j.error ? j.error : '');
      const lc = raw.toLowerCase();
      if (TRANSIENT_CODES.has(lc)) return { unreachable: true };
      if (BUSINESS_CODES.has(raw)) return { rejected: raw };
      log('管理系統回了契約沒列的錯誤代碼，當暫時連不上處理：' + String(raw || '(空)').slice(0, 60));
      return { unreachable: true };
    }
    if (j.ok !== true || !j.data || typeof j.data !== 'object') return { rejected: 'BAD_SHAPE' };
    return { data: j.data };
  }

  function identResult(r, wantSub) {
    if (r.unreachable) return { kind: 'unreachable' };
    if (r.rejected) return rej(r.rejected);
    const id = parseIdent(r.data);
    if (!id) return rej('BAD_SCHEMA');
    if (wantSub !== undefined && id.sub !== wantSub) return rej('SUB_MISMATCH');
    if (!id.active) return { kind: 'inactive', ident: id };
    return id.allowed ? { kind: 'ok', ident: id } : { kind: 'denied', ident: id };
  }

  return {
    enabled,
    // 兌換入場券（只送一次）
    async redeem(ticket) {
      if (!enabled()) return { kind: 'unreachable' };
      if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return rej('ticket_invalid');
      return identResult(await call('svcPurchaseRedeem', { ticket, aud: 'purchase' }));
    },
    // 重查身分：回來的 sub 必須與要求的相同
    async who(sub) {
      if (!enabled()) return { kind: 'unreachable' };
      if (typeof sub !== 'string' || !SUB_RE.test(sub)) return rej('bad_input');
      return identResult(await call('svcPurchaseWho', { sub }), sub);
    }
  };
}

module.exports = { create, parseIdent, SUB_RE, TICKET_RE, TIMEOUT_MS };
