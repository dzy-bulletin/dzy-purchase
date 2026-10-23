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
  /* 單色 stroke 圖示（24 viewBox，stroke=currentColor）；不用 emoji */
  var ICONS = {
    review: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="m9 13 2 2 4-4"/>',
    returned: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    confirmed: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
    failed: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    cost: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
    price: '<path d="m3 17 6-6 4 4 8-9"/><path d="M15 6h6v6"/>',
    daily: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    alerts: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
    items: '<path d="M20.5 13.5 13 21l-9-9V4h8z"/><circle cx="8" cy="8" r="1.3"/>',
    vendors: '<path d="M4 9.5 5.5 4h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5 12.5V20h14v-7.5"/><path d="M10 20v-4.5h4V20"/>',
    pnl: '<path d="M12 3v18M7 21h10"/><path d="M5 7h14"/><path d="m5 7-3 7a3.2 3.2 0 0 0 6 0zM19 7l-3 7a3.2 3.2 0 0 0 6 0z"/>',
    stores: '<path d="M3 11 12 4l9 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18 14a6.5 6.5 0 0 1 3.5 6"/>'
  };
  function icon(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[k] || '') + '</svg>'; }
  var NAV_DEFAULT = { 'review.html': 'review', 'reports.html': 'cost', 'admin.html': 'items' };
  var ROLE_TEXT = { admin: '管理員', accountant: '會計' };
  function curPage() { return (location.pathname.split('/').pop() || '') || 'review.html'; }
  /* 目前所在項目高亮（aria-current）；頁內換分頁只改 hash，所以 hashchange 也要呼叫 */
  function syncNav() {
    var page = curPage(), key = (location.hash || '').slice(1) || NAV_DEFAULT[page];
    Array.prototype.forEach.call(document.querySelectorAll('#snav a[data-page]'), function (a) {
      if (a.dataset.page === page && a.dataset.key === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (Embed) Embed.sync();
  }
  /* 核對各狀態筆數（counts: {review:n, returned:n, ...}） */
  function setCounts(counts) {
    Array.prototype.forEach.call(document.querySelectorAll('#snav [data-cnt]'), function (el) {
      var v = counts[el.dataset.cnt]; el.textContent = v == null ? '' : v;
    });
    if (Embed) Embed.badges(counts);
  }
  /* 品牌切換：admin＝工作品牌、多品牌會計＝目前品牌（單品牌不顯示）。一般模式放側欄，嵌入模式放主欄頂部 */
  function pickerHTML(s) {
    var picker = s.role === 'admin' ? '<label class="spick">工作品牌<select id="brandPick">' + ['X', 'M', 'C'].map(function (b) { return '<option value="' + b + '"' + (adminBrand() === b ? ' selected' : '') + '>' + BRAND_NAME[b] + '</option>'; }).join('') + '</select></label>' : '';
    if (s.role === 'accountant' && (s.brands || []).length > 1) {
      picker = '<label class="spick">目前品牌<select id="brandSwitch">' + s.brands.map(function (b) { return '<option value="' + esc(b.id) + '"' + (s.brand_id === b.id ? ' selected' : '') + '>' + esc(b.name || BRAND_NAME[b.id] || b.id) + '</option>'; }).join('') + '</select></label>';
    }
    return picker;
  }
  function sideHTML(s) {
    var groups = NAV_GROUPS.map(function (g) {
      var items = g.items.filter(function (i) { return i[3] !== 'admin' || s.role === 'admin'; }).map(function (i) {
        var cnt = g.label === '核對' ? '<span class="cnt" data-cnt="' + i[1] + '"></span>' : '';
        return '<a href="' + i[0] + (API.embed ? location.search : '') + '#' + i[1] + '" data-page="' + i[0] + '" data-key="' + i[1] + '" title="' + i[2] + '"><span class="ic" aria-hidden="true">' + icon(i[1]) + '</span><span class="tx">' + i[2] + '</span>' + cnt + '</a>';
      }).join('');
      return '<div class="sgrp" role="group" aria-label="' + g.label + '"><div class="slabel">' + g.label + '</div>' + items + '</div>';
    }).join('');
    var picker = API.embed ? '' : pickerHTML(s);
    var brand = '<div class="brand"><div class="blogo"><div class="logos"></div></div><div><div class="bt js-bt"></div><div class="bs js-bs"></div></div></div>';
    var nm = String(s.name || '');
    return '<div id="sidein"><div id="sidew">' + brand + picker + '<nav id="snav" aria-label="主選單">' + groups + '</nav>' +
      '<div class="suser"><div class="who"><div class="av" aria-hidden="true">' + esc(nm.charAt(0) || '?') + '</div><div class="wt"><div class="nm">' + esc(nm) + '</div><div class="rl">' + esc(ROLE_TEXT[s.role] || s.role) + '</div></div></div><button id="chpw" type="button">改密碼</button><button id="logout" type="button">登出</button></div></div></div>';
  }


  /* ---------- 嵌入鼎兆元管理系統（?embed=dzy；dzy docs/purchase-fin/spec.md §1、§3、§5）----------
     ‧沒 token：不顯示登入框，送 dzy-purchase-ready 給 parent，等 dzy-purchase-sso 帶入場券來兌換。
     ‧只理會 source＝window.parent 且 origin 在白名單內的訊息；送出時 targetOrigin 一律寫死（白名單逐一送，瀏覽器只會投遞給相符的那個），不用 '*'。
     ‧九個分頁交給管理系統畫在頁頂（dzy-purchase-nav）；點分頁收到 dzy-purchase-go；頁內小切換（待核對｜退回、品項｜廠商｜損益對照、帳號｜門市）放主欄頂部。 */
  var Embed = null;
  var DZY_ORIGINS = ['https://dzy.mozhuting.com'].concat(/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? ['http://localhost:8777', 'http://127.0.0.1:8777'] : []);
  var EMBED_TABS = [['review', '待核對'], ['confirmed', '已入帳'], ['failed', '辨識失敗'], ['alerts', '價格提醒'], ['price', '單價走勢'], ['cost', '食材成本'], ['daily', '每日進貨'], ['items', '品項廠商'], ['users', '帳號', 'admin']];
  var EMBED_GO = { review: ['review.html', 'review'], confirmed: ['review.html', 'confirmed'], failed: ['review.html', 'failed'], alerts: ['reports.html', 'alerts'], price: ['reports.html', 'price'],
    cost: ['reports.html', 'cost'], daily: ['reports.html', 'daily'], items: ['admin.html', 'items'], users: ['admin.html', 'users'] };
  var EMBED_OF = { returned: 'review', vendors: 'items', pnl: 'items', stores: 'users' };          // 頁內小切換 → 屬於哪個分頁
  var EMBED_SUB = { review: [['review', '待核對'], ['returned', '退回']], items: [['items', '品項'], ['vendors', '廠商'], ['pnl', '損益對照']], users: [['users', '帳號'], ['stores', '門市']] };
  function makeEmbed(h) {      // h: {start(), wait(msg, err)}
    var parentOrigin = null, badge = {}, busy = false, lastReady = 0;
    function post(m) {
      (parentOrigin ? [parentOrigin] : DZY_ORIGINS).forEach(function (o) { try { window.parent.postMessage(m, o); } catch (e) { /* parent 不接受就算了 */ } });
    }
    function ready() { lastReady = Date.now(); post({ type: 'dzy-purchase-ready', v: 1 }); }
    function key() { return (location.hash || '').slice(1) || NAV_DEFAULT[curPage()]; }
    function curId() { var k = key(); return EMBED_OF[k] || (EMBED_GO[k] ? k : ''); }
    function isAdminS() { var s = API.session(); return !!(s && s.role === 'admin'); }
    function postNav() {
      if (!API.session()) return;
      var items = EMBED_TABS.filter(function (t) { return t[2] !== 'admin' || isAdminS(); }).map(function (t) {
        return { id: t[0], label: t[1], badge: (t[0] === 'review' || t[0] === 'failed') ? (badge[t[0]] || 0) : 0 };
      });
      post({ type: 'dzy-purchase-nav', v: 1, items: items, cur: curId() });
    }
    function renderSub() {
      var box = $('esub'); if (!box) return;
      var id = curId(), k = key(), subs = (EMBED_SUB[id] || []).filter(function (x) { return x[0] !== 'stores' || isAdminS(); });
      box.innerHTML = subs.length > 1 ? subs.map(function (x) { return '<button type="button" role="tab" data-sub="' + x[0] + '" aria-selected="' + (x[0] === k) + '">' + esc(x[1]) + '</button>'; }).join('') : '';
      Array.prototype.forEach.call(box.querySelectorAll('[data-sub]'), function (b) { b.onclick = function () { if (b.dataset.sub !== key()) location.hash = b.dataset.sub; }; });
    }
    function go(id) {
      if (typeof id !== 'string' || !EMBED_GO.hasOwnProperty(id) || (id === 'users' && !isAdminS())) return;
      if (id === curId()) return;
      var t = EMBED_GO[id];
      if (t[0] === curPage()) location.hash = t[1];                                  // 同一頁：改 hash，由各頁的 onHash 接手
      else location.href = t[0] + location.search + '#' + t[1];                   // 跨頁：保留 ?embed=dzy（與 ?api= 等）
    }
    async function redeem(ticket) {
      if (busy) return;
      busy = true;
      var had = !!API.session();
      try {
        await API.sso(ticket);
        if (had) location.reload(); else h.start();
      } catch (e) {
        if (!had) h.wait(e.message, true);
      } finally { busy = false; }
    }
    function logout() { API.logout(); h.wait('已登出貨單核對。', false); }
    async function loadBadges() {        // 非核對頁也要有待核對／辨識失敗的數字
      var out = {};
      await Promise.all(['review', 'failed'].map(async function (st) { try { out[st] = (await Common.get('/review', { status: st })).length; } catch (e) {} }));
      if (badge.review == null) badge.review = out.review;
      if (badge.failed == null) badge.failed = out.failed;
      postNav();
    }
    window.addEventListener('message', function (e) {
      if (e.source !== window.parent || DZY_ORIGINS.indexOf(e.origin) < 0) return;
      var m = e.data;
      if (!m || typeof m !== 'object' || m.v !== 1) return;
      parentOrigin = e.origin;
      if (m.type === 'dzy-purchase-sso' && typeof m.ticket === 'string' && /^[0-9a-f]{64}$/.test(m.ticket)) redeem(m.ticket);
      else if (m.type === 'dzy-purchase-go') go(m.id);
      else if (m.type === 'dzy-purchase-tabs') document.documentElement.classList.add('embed-tabs');     // 管理系統回覆「已畫好選單」：只記下，不再回送（否則來回無限循環）
      else if (m.type === 'dzy-purchase-logout') logout();
    });
    return {
      ready: ready, loadBadges: loadBadges,
      sinceReady: function () { return Date.now() - lastReady; },
      sync: function () { renderSub(); postNav(); },
      badges: function (c) { if (c.review != null) badge.review = c.review; if (c.failed != null) badge.failed = c.failed; postNav(); }
    };
  }

  /* 操作教學連結：門市頁連 #store，其他頁連 #acc；新分頁開啟 */
  function guideLink() {
    return '<p class="guide-link" style="text-align:center;margin:1rem 0 0"><a href="guide.html#' + (window.PAGE_ROLE === 'store' ? 'store' : 'acc') + '" target="_blank" rel="noopener">第一次使用？看操作教學</a></p>';
  }

  /* 深色頂條（上傳頁、登入／改密碼畫面）：品牌 logo＋標題；上傳頁登入後多放改密碼／登出 */
  function headerHTML(o, s) {
    return '<header class="hdr"><div class="logos"></div><span class="ttl">' + esc(o.title) + '</span>' +
      (s && !o.nav ? '<button id="chpw" type="button" class="hout">改密碼</button><button id="logout" type="button" class="hout">登出</button>' : '') + '</header>';
  }
  /* 頁面頂部大標題＋副標（核對／報表／設定頁，放在主欄最上方；品牌由側欄品牌區呈現） */
  function topbarHTML(o, s) {
    var b = s.role === 'admin' ? null : s.brand_id, nm = (BRAND_NAME[b]) || '';
    if (API.embed) return '<header class="topbar"><div class="ehead"><h1>' + esc(o.title) + '</h1><div class="sub">貨單辨識系統' + (nm ? '｜' + esc(nm) : '') + '</div></div>' + pickerHTML(s) + '<div id="esub" class="esub" role="tablist" aria-label="頁內切換"></div></header>';
    return '<header class="topbar"><h1>' + esc(o.title) + '</h1><div class="sub">貨單辨識系統' + (nm ? '｜' + esc(nm) : '') + '</div></header>';
  }

  /* o: {title, nav, roles:[...], loginTitle, loginHint, accLabel, upper, onHash(key), onReady(session)}
     o.nav：核對／報表／設定頁，登入後在視窗左側加深色側欄＋主欄頂部大標題（上傳頁不給 nav，只有深色頂條） */
  function gate(o) {
    var hdr = $('hdr'), loginBox = $('login'), app = $('app'), shell = null;
    var col = null;
    function ensureShell() {
      if (shell || !o.nav) return shell;
      shell = document.createElement('div'); shell.id = 'shell';
      var side = document.createElement('aside'); side.id = 'side';
      col = document.createElement('div'); col.id = 'col';
      app.parentNode.insertBefore(shell, app); shell.appendChild(side); shell.appendChild(col); col.appendChild(hdr); col.appendChild(app);
      return shell;
    }
    /* 標題區：登入／改密碼＝頁面最上方的深色頂條；登入後的導覽頁＝主欄頂部大標題 */
    function hdrToTop() { if (col && hdr.parentNode === col) shell.parentNode.insertBefore(hdr, shell); }
    /* 嵌入：等管理系統的入場券（或顯示兌換失敗的原因） */
    function showEmbedWait(text, err) {
      hdrToTop(); if (shell) shell.classList.add('hidden');
      app.classList.add('hidden'); loginBox.classList.remove('hidden');
      hdr.innerHTML = ''; applyTheme(null);
      loginBox.innerHTML = '<div class="page" style="max-width:440px;padding-top:2rem"><div class="card"><h1>' + esc(o.title) + '</h1>' +
        '<p class="' + (err ? 'msg err' : 'muted') + '" role="status">' + esc(text || '正在從鼎兆元管理系統登入…') + '</p>' +
        (err ? '<p class="muted">請回管理系統重新整理頁面後再進入。</p>' : '') +
        '<button id="embedRetry" type="button" style="width:100%;margin-top:.6rem;min-height:44px">重新連線</button></div></div>';
      $('embedRetry').onclick = function () { showEmbedWait(); Embed.ready(); };
    }
    function showLogin() {
      if (Embed) { showEmbedWait(); Embed.ready(); return; }
      hdrToTop(); if (shell) shell.classList.add('hidden');
      app.classList.add('hidden'); loginBox.classList.remove('hidden');
      hdr.innerHTML = headerHTML(o, null); applyTheme(null);
      loginBox.innerHTML = '<div class="page" style="max-width:440px;padding-top:2rem"><div class="card"><h1>' + esc(o.loginTitle || o.title) + '</h1>' +
        (o.loginHint ? '<p class="muted">' + esc(o.loginHint) + '</p>' : '') +
        '<label class="f" style="margin-top:.8rem">' + esc(o.accLabel || '帳號') + '<input id="acc" autocomplete="username" autocapitalize="none"></label>' +
        '<label class="f" style="margin-top:.8rem">密碼<input id="pw" type="password" autocomplete="current-password"></label>' +
        '<p class="muted" style="font-size:.85rem;margin:.4rem 0 0">' + esc(o.pwHint || '第一次使用的預設密碼是 000000，登入後系統會請你設定自己的新密碼。') + '</p>' +
        '<div id="loginMsg"></div><button id="loginBtn" class="primary" type="button" style="width:100%;margin-top:1rem;min-height:48px">登入</button>' + guideLink() + '</div></div>';
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
      hdrToTop(); if (shell) shell.classList.add('hidden');
      app.classList.add('hidden'); loginBox.classList.remove('hidden');
      hdr.innerHTML = headerHTML(o, null); applyTheme(s.role === 'admin' ? null : s.brand_id);
      loginBox.innerHTML = '<div class="page" style="max-width:440px;padding-top:2rem"><div class="card"><h1>' + (forced ? '第一次登入請設定你自己的密碼' : '改密碼') + '</h1>' +
        '<p class="muted">' + (forced ? '目前的密碼是管理者給的臨時密碼，請改成只有你自己知道的密碼（至少 6 個字）。' : '新密碼至少 6 個字，不可與舊密碼相同。') + '</p>' +
        '<label class="f" style="margin-top:.8rem">舊密碼' + (forced ? '（臨時密碼）' : '') + '<input id="pwOld" type="password" autocomplete="current-password"></label>' +
        '<label class="f" style="margin-top:.8rem">新密碼<input id="pwNew" type="password" autocomplete="new-password"></label>' +
        '<label class="f" style="margin-top:.8rem">確認新密碼<input id="pwNew2" type="password" autocomplete="new-password"></label>' +
        '<div id="pwMsg"></div><button id="pwBtn" class="primary" type="button" style="width:100%;margin-top:1rem;min-height:48px">' + (forced ? '設定密碼並進入' : '儲存新密碼') + '</button>' +
        (forced ? '<button id="pwOut" type="button" style="width:100%;margin-top:.6rem;min-height:44px">登出</button>' : '<button id="pwCancel" type="button" style="width:100%;margin-top:.6rem;min-height:44px">取消</button>') + guideLink() + '</div></div>';
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
    var started = false, noBrand = false;
    function start(resume) {
      var s = API.session();
      if (s.must_change_password && !Embed) { showChange(true); return; }
      loginBox.classList.add('hidden'); loginBox.innerHTML = ''; app.classList.remove('hidden');
      if (o.nav) {
        ensureShell().classList.remove('hidden'); col.insertBefore(hdr, app);
        hdr.innerHTML = topbarHTML(o, s); $('side').innerHTML = sideHTML(s); syncNav();
      } else hdr.innerHTML = headerHTML(o, s);
      applyTheme(s.role === 'admin' ? null : s.brand_id);
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
      started = true;
      if (s.role === 'accountant' && !(s.brands || []).length) {      // 從管理系統自動建的會計帳號，還沒指派品牌
        noBrand = true;
        app.classList.add('hidden');                          // 不動頁面原本的 DOM（各頁腳本載入時會綁按鈕），另放一塊提示
        var nb = $('noBrand') || document.createElement('div'); nb.id = 'noBrand'; nb.className = 'page';
        nb.innerHTML = '<div class="card"><h2>尚未指派品牌，請找 Eason</h2><p class="muted">你的帳號已建立，但還沒設定可以核對哪個品牌的貨單。Eason 在貨單系統「帳號」頁替你勾選品牌後，重新整理就能使用。</p></div>';
        if (!nb.parentNode) app.parentNode.insertBefore(nb, app);
        if (Embed) Embed.sync();
        return;
      }
      if (Embed) Embed.loadBadges();
      o.onReady(s);
    }
    if (API.embed) {
      document.documentElement.classList.add('embed');
      Embed = makeEmbed({ start: function () { start(); }, wait: showEmbedWait });
    }
    API.onUnauthorized = !Embed ? showLogin : function (text) {
      // 嵌入 session 失效（過期、權限變更）：顯示原因；1 分鐘內沒要過入場券就自動再要一次（過期的會無感重新進入）
      showEmbedWait(text || '登入已失效', true);
      if (Embed.sinceReady() > 60e3) Embed.ready();
    };
    API.onPasswordRequired = function () { API.update({ must_change_password: true }); showChange(true); };
    window.addEventListener('hashchange', function () { syncNav(); if (o.onHash && API.session() && !noBrand) o.onHash((location.hash || '').slice(1)); });
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
