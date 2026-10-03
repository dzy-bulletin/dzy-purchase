/* 四頁共用：小工具、登入閘門、頂端列（導覽依角色顯示）、下載。需先載入 config.js、api.js、theme.js。 */
'use strict';
var $ = function (id) { return document.getElementById(id); };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function num(v) { if (v === '' || v == null) return null; var n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; }
/* 金額顯示：千分位、小數為 0 時不顯示小數 */
function fmt(n) { if (n == null || n === '') return ''; return r2(+n).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
var CATS = ['食材', '包材', '雜貨', '其他'];
var BRAND_NAME = { M: '墨竹亭', C: '央廚', X: '小辛辣' };

var Common = (function () {
  var ADMIN_KEY = 'purchase_admin_brand';
  function isAdmin() { var s = API.session(); return !!(s && s.role === 'admin'); }
  /* admin 沒有自己的品牌：用頂端列選的品牌當工作品牌（假設後端接受 brand_id 查詢參數／body 欄位） */
  function adminBrand() {
    if (!isAdmin()) return null;
    try { return localStorage.getItem(ADMIN_KEY) || 'X'; } catch (e) { return 'X'; }
  }
  function workBrand() { var s = API.session(); return isAdmin() ? adminBrand() : (s && s.brand_id); }
  function qs(params, withBrand) {
    var p = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) { var v = params[k]; if (v !== '' && v != null) p.append(k, v); });
    if (withBrand !== false && isAdmin()) p.set('brand_id', adminBrand());
    var s = p.toString(); return s ? '?' + s : '';
  }
  /* 呼叫 API：path 不含查詢，params 物件；admin 自動帶 brand_id（opts.noBrand 可關） */
  function get(path, params, opts) { opts = opts || {}; return API.call(path + qs(params, !opts.noBrand), opts); }
  function send(method, path, body, opts) {
    opts = opts || {}; body = Object.assign({}, body || {});
    if (isAdmin() && !opts.noBrand && body.brand_id == null) body.brand_id = adminBrand();
    return API.call(path, Object.assign({ method: method, body: body }, opts));
  }

  function headerHTML(o, s) {
    var nav = '';
    if (o.nav && s && (s.role === 'accountant' || s.role === 'admin')) {
      nav = '<nav class="nav" aria-label="主選單">' + [['review.html', '核對', 'review'], ['reports.html', '報表', 'reports'], ['admin.html', '設定', 'admin']].map(function (n) {
        return '<a href="' + n[0] + '"' + (o.nav === n[2] ? ' class="on" aria-current="page"' : '') + '>' + n[1] + '</a>';
      }).join('') + '</nav>';
    }
    var picker = '';
    if (s && s.role === 'admin') {
      picker = '<select id="brandPick" aria-label="工作品牌">' + ['X', 'M', 'C'].map(function (b) { return '<option value="' + b + '"' + (adminBrand() === b ? ' selected' : '') + '>' + BRAND_NAME[b] + '</option>'; }).join('') + '</select>';
    }
    return '<div class="stripe"></div><header class="hdr"><div class="l"><div class="logos"></div><span class="ttl">' + esc(o.title) + '</span>' +
      (s ? '<span class="who">' + esc(o.who ? o.who(s) : (s.name || '')) + '</span>' : '') + '</div>' +
      '<div class="r">' + nav + picker + (s ? '<button id="logout" type="button">登出</button>' : '') + '</div></header>';
  }

  /* o: {title, nav, roles:[...], who(s), loginTitle, loginHint, accLabel, upper, previewBrand(accountValue), onReady(session)} */
  function gate(o) {
    var hdr = $('hdr'), loginBox = $('login'), app = $('app');
    function showLogin() {
      app.classList.add('hidden'); loginBox.classList.remove('hidden');
      hdr.innerHTML = headerHTML(o, null); applyTheme(null);
      loginBox.innerHTML = '<div class="page" style="max-width:440px;padding-top:2rem"><div class="card"><h1>' + esc(o.loginTitle || o.title) + '</h1>' +
        (o.loginHint ? '<p class="muted">' + esc(o.loginHint) + '</p>' : '') +
        '<label class="f" style="margin-top:.8rem">' + esc(o.accLabel || '帳號') + '<input id="acc" autocomplete="username" autocapitalize="none"></label>' +
        '<label class="f" style="margin-top:.8rem">密碼<input id="pw" type="password" autocomplete="current-password"></label>' +
        '<div id="loginMsg"></div><button id="loginBtn" class="primary" type="button" style="width:100%;margin-top:1rem;min-height:48px">登入</button></div></div>';
      $('acc').addEventListener('input', function () { if (o.previewBrand) applyTheme(o.previewBrand(this.value.trim())); });
      $('loginBtn').onclick = doLogin;
      $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    }
    async function doLogin() {
      $('loginMsg').innerHTML = '';
      try {
        var acc = $('acc').value.trim(); if (o.upper) acc = acc.toUpperCase();
        var d = await API.login(acc, $('pw').value);
        if (o.roles.indexOf(d.role) < 0) { API.logout(); throw new Error(o.roleError || '這個帳號不能用在這個頁面'); }
        start();
      } catch (e) { $('loginMsg').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; }
    }
    function start() {
      var s = API.session();
      loginBox.classList.add('hidden'); loginBox.innerHTML = ''; app.classList.remove('hidden');
      hdr.innerHTML = headerHTML(o, s);
      applyTheme(s.role === 'admin' ? null : s.brand_id);
      $('logout').onclick = function () { API.logout(); showLogin(); };
      if ($('brandPick')) $('brandPick').onchange = function () { try { localStorage.setItem(ADMIN_KEY, this.value); } catch (e) {} location.reload(); };
      o.onReady(s);
    }
    API.onUnauthorized = showLogin;
    var s0 = API.session();
    if (s0 && o.roles.indexOf(s0.role) >= 0) start(); else { if (s0) API.logout(); showLogin(); }
  }

  function download(blob, name) {
    var a = document.createElement('a'), u = URL.createObjectURL(blob);
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1000);
  }
  function monthNow() { var d = new Date(Date.now() + 8 * 3600e3); return d.toISOString().slice(0, 7); }
  function today() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
  function showMsg(boxId, text, cls) { $(boxId).innerHTML = text ? '<div class="msg ' + (cls || 'info') + '" role="status">' + esc(text) + '</div>' : ''; }

  return { isAdmin: isAdmin, adminBrand: adminBrand, workBrand: workBrand, qs: qs, get: get, send: send, gate: gate, download: download, monthNow: monthNow, today: today, showMsg: showMsg };
})();
