/* 共用 API 包裝：帶 Bearer token、解 {ok,data}、401 回登入。 */
'use strict';
var API = (function () {
  // 門市頁與會計頁分開存登入狀態，同一台電腦先後登入兩種帳號才不會互相蓋掉
  var KEY = 'purchase_session_' + (window.PAGE_ROLE || 'default');
  function session() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function setSession(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(KEY); } catch (e) {} }

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
      if (typeof API.onUnauthorized === 'function') API.onUnauthorized();
    }
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
  function logout() { clearSession(); }
  function update(patch) { var s = session(); if (s) setSession(Object.assign({}, s, patch)); }

  return { call: call, login: login, logout: logout, update: update, session: session, onUnauthorized: null };
})();

/* 伺服器存 UTC（ISO），畫面一律顯示台灣時間 YYYY-MM-DD HH:mm */
function twTime(iso) {
  if (!iso) return '';
  var d = new Date(iso); if (isNaN(d)) return String(iso);
  var p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return p.replace('T', ' ');
}
