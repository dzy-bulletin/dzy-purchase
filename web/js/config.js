/* 設定。API_BASE 預設本機；測試時可用 ?api=http://localhost:8794/purchase/api 覆寫（僅限本機開頁時生效）。 */
'use strict';
var CFG = (function () {
  var c = { VERSION: '0.1.0', API_BASE: 'http://localhost:8794/purchase/api', TIMEOUT: 60000 };
  try {
    var api = new URLSearchParams(location.search).get('api');
    if (api && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/purchase\/api\/?$/.test(api)) {
      c.API_BASE = api.replace(/\/$/, '');
    }
  } catch (e) {}
  return c;
})();
