/* 品牌主題（plan.md「P2 共用契約」品牌主題表）。applyTheme(brand_id) 設 :root CSS 變數並把 logo 放進 .logos。 */
'use strict';
var THEMES = {
  M: { name: '墨竹亭', bg: '#EDF5F2', surface: '#F8FBFA', ink: '#202B66', sub: '#4F5A7A', line: '#C9DFD8', faint: '#DEECE7', accent: '#2C7A68', button: '#202B66', buttonInk: '#F8FBFA', logos: ['img/logo-mzt.png'] },
  C: { name: '央廚', bg: '#EDF1F6', surface: '#F8FAFC', ink: '#1F2A3A', sub: '#56627A', line: '#CFD9E5', faint: '#E2E8EF', accent: '#1F4E8C', button: '#1F4E8C', buttonInk: '#F8FAFC', logos: ['img/logo-mzt.png', 'img/logo-mala.jpg'] },
  X: { name: '小辛辣', bg: '#F7EEE9', surface: '#FCF8F5', ink: '#3A2E2A', sub: '#6E5F58', line: '#E6D3C9', faint: '#F0E2DA', accent: '#B9361F', button: '#B9361F', buttonInk: '#FCF8F5', logos: ['img/logo-mala.jpg'] },
  _: { name: '鼎兆元', bg: '#F3F0E8', surface: '#FBFAF6', ink: '#34312C', sub: '#6E6A62', line: '#DDD7CA', faint: '#E8E3D7', accent: '#1F4E8C', button: '#34312C', buttonInk: '#F3F0E8', logos: [] }
};
var VAR_MAP = { bg: '--bg', surface: '--surface', ink: '--ink', sub: '--sub', line: '--line', faint: '--faint', accent: '--accent', button: '--button', buttonInk: '--button-ink' };

function applyTheme(brandId) {
  var t = THEMES[brandId] || THEMES._;
  var root = document.documentElement.style;
  Object.keys(VAR_MAP).forEach(function (k) { root.setProperty(VAR_MAP[k], t[k]); });
  document.documentElement.setAttribute('data-brand', THEMES[brandId] ? brandId : '_');
  var meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t.bg);
  var html = t.logos.length
    ? t.logos.map(function (src) { return '<img src="' + src + '" alt="' + t.name + ' logo">'; }).join('')
    : '<span class="txt">鼎兆元</span>';
  Array.prototype.forEach.call(document.querySelectorAll('.logos'), function (el) { el.innerHTML = html; });
  return t;
}
