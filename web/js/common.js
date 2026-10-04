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

  var NAV_GROUPS = [
    { label: '核對', items: [['review.html', 'review', '待核對', 'review'], ['review.html', 'returned', '退回', 'cnt'], ['review.html', 'confirmed', '已入帳', 'cnt'], ['review.html', 'failed', '辨識失敗', 'cnt']] },
    { label: '報表', items: [['reports.html', 'cost', '食材成本'], ['reports.html', 'price', '單價走勢'], ['reports.html', 'daily', '每日進貨'], ['reports.html', 'alerts', '價格變動提醒']] },
    { label: '設定', items: [['admin.html', 'items', '品項'], ['admin.html', 'vendors', '廠商'], ['admin.html', 'pnl', '損益對照'], ['admin.html', 'stores', '門市', 'admin'], ['admin.html', 'users', '帳號', 'admin']] }
  ];
  var NAV_DEFAULT = { 'review.html': 'review', 'reports.html': 'cost', 'admin.html': 'items' };
  var ROLE_TEXT = { admin: '管理員', accountant: '會計' };
  function curPage() { return (location.pathname.split('/').pop() || '') || 'review.html'; }
  /* 目前所在項目高亮（aria-current）；頁內換分頁只改 hash，所以 hashchange 也要呼叫 */
  function syncNav() {
    var page = curPage(), key = (location.hash || '').slice(1) || NAV_DEFAULT[page];
    Array.prototype.forEach.call(document.querySelectorAll('#snav a[data-page]'), function (a) {
      if (a.dataset.page === page && a.dataset.key === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  /* 核對各狀態筆數（counts: {review:n, returned:n, ...}） */
  function setCounts(counts) {
    Array.prototype.forEach.call(document.querySelectorAll('#snav [data-cnt]'), function (el) {
      var v = counts[el.dataset.cnt]; el.textContent = v == null ? '' : v;
    });
  }
  function sideHTML(s) {
    var groups = NAV_GROUPS.map(function (g) {
      var items = g.items.filter(function (i) { return i[3] !== 'admin' || s.role === 'admin'; }).map(function (i) {
        var cnt = g.label === '核對' ? '<span class="cnt" data-cnt="' + i[1] + '"></span>' : '';
        return '<a href="' + i[0] + '#' + i[1] + '" data-page="' + i[0] + '" data-key="' + i[1] + '" title="' + i[2] + '"><span class="ic" aria-hidden="true">' + esc(String(i[2]).charAt(0)) + '</span><span class="tx">' + i[2] + '</span>' + cnt + '</a>';
      }).join('');
      return '<div class="sgrp" role="group" aria-label="' + g.label + '"><div class="slabel">' + g.label + '</div>' + items + '</div>';
    }).join('');
    var picker = s.role === 'admin' ? '<label class="spick">工作品牌<select id="brandPick">' + ['X', 'M', 'C'].map(function (b) { return '<option value="' + b + '"' + (adminBrand() === b ? ' selected' : '') + '>' + BRAND_NAME[b] + '</option>'; }).join('') + '</select></label>' : '';
    if (s.role === 'accountant' && (s.brands || []).length > 1) {      // 多品牌會計：側欄上方品牌切換（單品牌不顯示）
      picker = '<label class="spick">目前品牌<select id="brandSwitch">' + s.brands.map(function (b) { return '<option value="' + esc(b.id) + '"' + (s.brand_id === b.id ? ' selected' : '') + '>' + esc(b.name || BRAND_NAME[b.id] || b.id) + '</option>'; }).join('') + '</select></label>';
    }
    return '<div id="sidein"><div id="sidew">' + picker + '<nav id="snav" aria-label="主選單">' + groups + '</nav>' +
      '<div class="suser"><div class="who"><div class="nm">' + esc(s.name || '') + '</div><div class="rl">' + esc(ROLE_TEXT[s.role] || s.role) + '</div></div><button id="chpw" type="button">改密碼</button><button id="logout" type="button">登出</button></div></div></div>';
  }

  function headerHTML(o, s) {
    return '<header class="hdr"><div class="logos"></div><span class="ttl">' + esc(o.title) + '</span>' +
      (s && !o.nav ? '<button id="chpw" type="button" class="hout">改密碼</button><button id="logout" type="button" class="hout">登出</button>' : '') + '</header>';
  }

  /* o: {title, nav, roles:[...], loginTitle, loginHint, accLabel, upper, onHash(key), onReady(session)}
     o.nav：核對／報表／設定頁，登入後在視窗左側加側欄（上傳頁不給 nav，只有品牌色標題列） */
  function gate(o) {
    var hdr = $('hdr'), loginBox = $('login'), app = $('app'), shell = null;
    function ensureShell() {
      if (shell || !o.nav) return shell;
      shell = document.createElement('div'); shell.id = 'shell';
      var side = document.createElement('aside'); side.id = 'side';
      app.parentNode.insertBefore(shell, app); shell.appendChild(side); shell.appendChild(app);
      return shell;
    }
    function showLogin() {
      if (shell) shell.classList.add('hidden');
      app.classList.add('hidden'); loginBox.classList.remove('hidden');
      hdr.innerHTML = headerHTML(o, null); applyTheme(null);
      loginBox.innerHTML = '<div class="page" style="max-width:440px;padding-top:2rem"><div class="card"><h1>' + esc(o.loginTitle || o.title) + '</h1>' +
        (o.loginHint ? '<p class="muted">' + esc(o.loginHint) + '</p>' : '') +
        '<label class="f" style="margin-top:.8rem">' + esc(o.accLabel || '帳號') + '<input id="acc" autocomplete="username" autocapitalize="none"></label>' +
        '<label class="f" style="margin-top:.8rem">密碼<input id="pw" type="password" autocomplete="current-password"></label>' +
        '<p class="muted" style="font-size:.85rem;margin:.4rem 0 0">' + esc(o.pwHint || '第一次使用：請輸入管理者給你的臨時密碼，登入後系統會請你設定自己的新密碼。') + '</p>' +
        '<div id="loginMsg"></div><button id="loginBtn" class="primary" type="button" style="width:100%;margin-top:1rem;min-height:48px">登入</button></div></div>';
      $('loginBtn').onclick = doLogin;
      $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    }
    async function doLogin() {
      $('loginMsg').innerHTML = '';
      try {
        var acc = $('acc').value.trim(); if (o.upper) acc = acc.toUpperCase();
        if (!acc) throw new Error('請輸入' + (o.accLabel || '帳號'));
        if (!$('pw').value) throw new Error('請輸入密碼');
        var d = await API.login(acc, $('pw').value);
        if (o.roles.indexOf(d.role) < 0) { API.logout(); throw new Error(o.roleError || '這個帳號不能用在這個頁面'); }
        start();
      } catch (e) { $('loginMsg').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; }
    }
    /* 改密碼畫面。forced＝第一次登入（或後端回 PASSWORD_CHANGE_REQUIRED）：不能略過；否則可取消回原頁 */
    function showChange(forced) {
      var s = API.session() || {};
      if (shell) shell.classList.add('hidden');
      app.classList.add('hidden'); loginBox.classList.remove('hidden');
      hdr.innerHTML = headerHTML(o, null); applyTheme(s.role === 'admin' ? null : s.brand_id);
      loginBox.innerHTML = '<div class="page" style="max-width:440px;padding-top:2rem"><div class="card"><h1>' + (forced ? '第一次登入請設定你自己的密碼' : '改密碼') + '</h1>' +
        '<p class="muted">' + (forced ? '目前的密碼是管理者給的臨時密碼，請改成只有你自己知道的密碼（至少 6 個字）。' : '新密碼至少 6 個字，不可與舊密碼相同。') + '</p>' +
        '<label class="f" style="margin-top:.8rem">舊密碼' + (forced ? '（臨時密碼）' : '') + '<input id="pwOld" type="password" autocomplete="current-password"></label>' +
        '<label class="f" style="margin-top:.8rem">新密碼<input id="pwNew" type="password" autocomplete="new-password"></label>' +
        '<label class="f" style="margin-top:.8rem">確認新密碼<input id="pwNew2" type="password" autocomplete="new-password"></label>' +
        '<div id="pwMsg"></div><button id="pwBtn" class="primary" type="button" style="width:100%;margin-top:1rem;min-height:48px">' + (forced ? '設定密碼並進入' : '儲存新密碼') + '</button>' +
        (forced ? '<button id="pwOut" type="button" style="width:100%;margin-top:.6rem;min-height:44px">登出</button>' : '<button id="pwCancel" type="button" style="width:100%;margin-top:.6rem;min-height:44px">取消</button>') + '</div></div>';
      async function submit() {
        var a = $('pwOld').value, b = $('pwNew').value, c = $('pwNew2').value;
        var err = !a || !b ? '請輸入舊密碼與新密碼' : b.length < 6 ? '新密碼至少 6 個字' : b === a ? '新密碼不可與舊密碼相同' : b !== c ? '兩次輸入的新密碼不一樣' : '';
        if (err) { $('pwMsg').innerHTML = '<div class="msg err">' + esc(err) + '</div>'; return; }
        $('pwBtn').disabled = true;
        try { await API.changePassword(a, b); start(); }
        catch (e) { $('pwBtn').disabled = false; $('pwMsg').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; }
      }
      $('pwBtn').onclick = submit;
      $('pwNew2').addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      if ($('pwOut')) $('pwOut').onclick = function () { API.logout(); showLogin(); };
      if ($('pwCancel')) $('pwCancel').onclick = function () { start(true); };
    }
    var started = false;
    function start(resume) {
      var s = API.session();
      if (s.must_change_password) { showChange(true); return; }
      loginBox.classList.add('hidden'); loginBox.innerHTML = ''; app.classList.remove('hidden');
      hdr.innerHTML = headerHTML(o, s);
      applyTheme(s.role === 'admin' ? null : s.brand_id);
      if (o.nav) { ensureShell().classList.remove('hidden'); $('side').innerHTML = sideHTML(s); syncNav(); }
      $('logout').onclick = function () { API.logout(); showLogin(); };
      $('chpw').onclick = function () { showChange(false); };
      if ($('brandSwitch')) $('brandSwitch').onchange = async function () {
        var sel = this, want = sel.value, cur = s.brand_id;
        try {
          var r = await API.call('/session/brand', { method: 'POST', body: { brand_id: want } });
          API.update({ brand_id: r.brand_id, brand: r.brand_id, brands: r.brands });
          location.reload();                                   // 重新載入：所有清單、計數、報表都以新品牌重抓
        } catch (e) { sel.value = cur; alert(e.message); }
      };
      if ($('brandPick')) $('brandPick').onchange = function () { try { localStorage.setItem(ADMIN_KEY, this.value); } catch (e) {} location.reload(); };
      if (resume && started) return;                        // 取消改密碼回到原頁：不重跑 onReady
      started = true; o.onReady(s);
    }
    API.onUnauthorized = showLogin;
    API.onPasswordRequired = function () { API.update({ must_change_password: true }); showChange(true); };
    window.addEventListener('hashchange', function () { syncNav(); if (o.onHash && API.session()) o.onHash((location.hash || '').slice(1)); });
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

  return { isAdmin: isAdmin, adminBrand: adminBrand, workBrand: workBrand, qs: qs, get: get, send: send, gate: gate, syncNav: syncNav, setCounts: setCounts, download: download, monthNow: monthNow, today: today, showMsg: showMsg };
})();
