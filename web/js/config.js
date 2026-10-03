/* 設定。
   API_BASE：本機（localhost／127.0.0.1）開頁預設連本機 8794；其他網址連部署的後端（Mac mini 經 Tailscale Funnel 的 /purchase 路徑）。
   部署時把 DEPLOY_BASE 那一行開頭的佔位字串（兩個底線、FUNNEL、兩個底線）換成 Funnel 網址（https://主機名，不含結尾斜線）——
   指令見 DEPLOY.md「第 9 步　前端正式設定」。倉庫裡存的是佔位字串；沒換就上線的話，畫面會直接顯示「尚未設定伺服器網址」，不會悄悄打到別的地方。
   （這段註解刻意不寫出佔位字串本身，免得部署時的取代連註解一起改到。）
   ?api= 覆寫：只有在本機開頁時生效，而且只收 http://localhost|127.0.0.1:埠/purchase/api。 */
'use strict';
var CFG = (function () {
  var DEPLOY_BASE = '__FUNNEL__/purchase/api';
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var c = { VERSION: '0.2.0', API_BASE: local ? 'http://localhost:8794/purchase/api' : DEPLOY_BASE, TIMEOUT: 60000, UNCONFIGURED: false };
  if (!local && DEPLOY_BASE.indexOf('__FUN' + 'NEL__') === 0) { c.API_BASE = ''; c.UNCONFIGURED = true; }   // 佔位字串還沒換（比對字串拆開寫，免得部署時的全域取代連它一起換掉）
  try {
    var api = new URLSearchParams(location.search).get('api');
    if (api && local && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/purchase\/api\/?$/.test(api)) {
      c.API_BASE = api.replace(/\/$/, ''); c.UNCONFIGURED = false;
    }
  } catch (e) {}
  return c;
})();
