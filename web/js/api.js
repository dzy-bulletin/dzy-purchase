/* 共用 API 包裝：帶 Bearer token、解 {ok,data}、401 回登入。 */
'use strict';
var API = (function () {
  /* 嵌入鼎兆元管理系統（?embed=dzy，而且真的被嵌在別的頁面裡）：登入來自管理系統的入場券，token 存 sessionStorage（分頁關掉就沒了），key 與一般登入分開 */
  var EMBED = (function () { try { return new URLSearchParams(location.search).get('embed') === 'dzy' && window.parent !== window; } catch (e) { return false; } })();
  // 門市頁與會計頁分開存登入狀態，同一台電腦先後登入兩種帳號才不會互相蓋掉
  var KEY = EMBED ? 'purchase_embed_session' : 'purchase_session_' + (window.PAGE_ROLE || 'default');
  function store() { return EMBED ? sessionStorage : localStorage; }
  function session() { try { return JSON.parse(store().getItem(KEY) || 'null'); } catch (e) { return null; } }
  function setSession(s) { try { store().setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function clearSession() { try { store().removeItem(KEY); } catch (e) {} }

  function ApiError(code, message, status, data) {
    var e = new Error(message || code); e.code = code; e.status = status; e.data = data; return e;
  }

  // opts: {method, body (object|FormData), raw (回 Blob), noAuthRedirect}
  async function call(path, opts) {
    opts = opts || {};
    var s = session();
    var headers = {};
    if (s && s.token) headers['Authorization'] = 'Bearer ' + s.token;
    var body = opts.body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    if (CFG.UNCONFIGURED) throw ApiError('NETWORK', '尚未設定伺服器網址（部署時要把 config.js 的 __FUNNEL__ 換成實際網址）', 0);
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, opts.timeout || CFG.TIMEOUT);
    var res;
    try {
      res = await fetch(CFG.API_BASE + path, { method: opts.method || 'GET', headers: headers, body: body, signal: ctl.signal });
    } catch (e) {
      throw ApiError('NETWORK', '連不上伺服器，請檢查網路', 0);
    } finally { clearTimeout(timer); }
    if (opts.raw && res.ok) return res.blob();
    var j = null;
    try { j = await res.json(); } catch (e) {}
    if (res.status === 401 && !opts.noAuthRedirect) {
      clearSession();
      if (typeof API.onUnauthorized === 'function') API.onUnauthorized(j && j.message);
    }
    if (j && j.error === 'PASSWORD_CHANGE_REQUIRED' && typeof API.onPasswordRequired === 'function') API.onPasswordRequired();
    if (!j || j.ok !== true) {
      throw ApiError((j && j.error) || 'INTERNAL', (j && j.message) || ('伺服器錯誤 ' + res.status), res.status, j);
    }
    return j.data;
  }

  async function login(account, password) {
    var d = await call('/login', { method: 'POST', body: { account: account, password: password }, noAuthRedirect: true });
    setSession(d);   // 假設 data = {token, role, name, brand, store_id}
    return d;
  }
  /* 自己改密碼：成功後換新 token（舊 session 已作廢）、旗標清掉 */
  async function changePassword(oldPw, newPw) {
    var d = await call('/password', { method: 'POST', body: { old_password: oldPw, new_password: newPw }, noAuthRedirect: true });
    var s = session(); if (s) setSession(Object.assign({}, s, { token: d.token, expires_at: d.expires_at, must_change_password: false }));
    return d;
  }
  /* 嵌入：用管理系統給的入場券換貨單系統的登入 */
  async function sso(ticket) {
    var d = await call('/sso', { method: 'POST', body: { ticket: ticket }, noAuthRedirect: true });
    setSession(d);
    return d;
  }
  function logout() { var s = session(); clearSession(); if (s && s.token) { try { fetch(CFG.API_BASE + '/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + s.token } }).catch(function () {}); } catch (e) {} } }
  function update(patch) { var s = session(); if (s) setSession(Object.assign({}, s, patch)); }

  return { embed: EMBED, sso: sso, call: call, login: login, changePassword: changePassword, onPasswordRequired: null, logout: logout, update: update, session: session, onUnauthorized: null };
})();

/* 伺服器存 UTC（ISO），畫面一律顯示台灣時間 YYYY-MM-DD HH:mm */
function twTime(iso) {
  if (!iso) return '';
  var d = new Date(iso); if (isNaN(d)) return String(iso);
  var p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return p.replace('T', ' ');
}
