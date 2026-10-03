/* 品牌主題（plan.md「P2 共用契約」品牌主題表）。applyTheme(brand_id) 設 :root CSS 變數並把 logo 放進 .logos。 */
'use strict';
/* 品牌主題：Linen & Ledger（Stitch「AI Smart Invoice System」，2026-10-04 取代「紙」版）。
   版面共用同一套中性色；各品牌只換 微染底色 bg、整條頂端標題列底色 brand（文字色 ink）、logo。 */
var THEMES = {
  M: { name: '墨竹亭', bg: '#F6FAF8', brand: '#86CBBF', ink: '#202B66', logos: ['img/logo-mzt.png'] },
  C: { name: '央廚', bg: '#F6F8FB', brand: '#1F4E8C', ink: '#FFFFFF', logos: ['img/logo-mzt.png', 'img/logo-mala.jpg'] },
  X: { name: '小辛辣', bg: '#FBF7F4', brand: '#E94127', ink: '#FFFFFF', logos: ['img/logo-mala.jpg'] },
  _: { name: '鼎兆元', bg: '#FBFBF9', brand: '#2C2A29', ink: '#FFFFFF', logos: [] }
};
var VAR_MAP = { bg: '--bg', brand: '--brand', ink: '--brand-ink' };

function applyTheme(brandId) {
  var t = THEMES[brandId] || THEMES._;
  var root = document.documentElement.style;
  Object.keys(VAR_MAP).forEach(function (k) { root.setProperty(VAR_MAP[k], t[k]); });
  document.documentElement.setAttribute('data-brand', THEMES[brandId] ? brandId : '_');
  var meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t.brand);
  var html = t.logos.length
    ? t.logos.map(function (src) { return '<img src="' + src + '" alt="' + t.name + ' logo">'; }).join('')
    : '<span class="txt">鼎兆元</span>';
  Array.prototype.forEach.call(document.querySelectorAll('.logos'), function (el) { el.innerHTML = html; });
  return t;
}
