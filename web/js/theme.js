/* 品牌主題（plan.md「P2 共用契約」品牌主題表）。applyTheme(brand_id) 設 :root CSS 變數並把 logo／品牌名放進側欄品牌區。 */
'use strict';
/* 品牌主題：比照薪資系統的深色側欄（2026-10-04 取代 Linen & Ledger）。
   各品牌只換 brand（選中膠囊／強調色）、ink（膠囊上的字）、側欄品牌區的 logo、品牌名與英文副名；admin／未登入＝金黃＋「鼎兆元」字。 */
var THEMES = {
  M: { name: '墨竹亭', en: 'MO ZHU TING', brand: '#86CBBF', ink: '#202B66', logos: ['mzt'] },
  C: { name: '央廚', en: 'CENTRAL KITCHEN', brand: '#1F4E8C', ink: '#FFFFFF', logos: ['mzt', 'mala'] },
  X: { name: '小辛辣', en: 'MADE SIAO SIN LA', brand: '#FABE00', ink: '#231815', logos: ['mala'], full: '麻的小辛辣' },
  _: { name: '鼎兆元', en: 'DING ZHAO YUAN', brand: '#FABE00', ink: '#231815', logos: [] }
};
var VAR_MAP = { brand: '--brand', ink: '--brand-ink' };

function applyTheme(brandId) {
  var t = THEMES[brandId] || THEMES._;
  var root = document.documentElement.style;
  Object.keys(VAR_MAP).forEach(function (k) { root.setProperty(VAR_MAP[k], t[k]); });
  document.documentElement.setAttribute('data-brand', THEMES[brandId] ? brandId : '_');
  var html = t.logos.length
    ? t.logos.map(function (k) { return '<span class="lg lg-' + k + '"><img src="img/emblem-' + k + '.png" alt="' + (k === 'mala' ? '麻的小辛辣' : '墨竹亭') + ' logo"></span>'; }).join('')
    : '<span class="txt">鼎兆元</span>';
  Array.prototype.forEach.call(document.querySelectorAll('.logos'), function (el) { el.innerHTML = html; });
  Array.prototype.forEach.call(document.querySelectorAll('.js-bt'), function (el) { el.textContent = t.full || t.name; });
  Array.prototype.forEach.call(document.querySelectorAll('.js-bs'), function (el) { el.textContent = t.en; });
  return t;
}
