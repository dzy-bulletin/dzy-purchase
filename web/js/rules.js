/* 前後端共用規則（plan.md 共用契約「數字」）。瀏覽器掛 window.Rules，Node 用 require。 */
(function (root) {
  'use strict';
  function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
  function near(a, b) { return Math.abs(a - b) < 0.01; }
  /* 總額規則（Eason 2026-10-03 定案）：各列金額加總 ＋ 稅額（空白＝0）＝ 總額；
     subtotal 有值時只核對 ≈ 各列加總，不參與總額計算。缺總額、無明細或任一列缺金額＝不相符。 */
  function sumCheck(amounts, subtotal, tax, total) {
    var missing = total == null || !amounts.length || amounts.some(function (a) { return a == null; });
    var sum = round2(amounts.reduce(function (s, a) { return s + (a == null ? 0 : a); }, 0));
    var ok = !missing && near(round2(sum + (tax == null ? 0 : tax)), total) && (subtotal == null || near(sum, subtotal));
    return { sum: sum, ok: ok, missing: missing };
  }
  var Rules = { round2: round2, near: near, sumCheck: sumCheck };
  if (typeof module !== 'undefined' && module.exports) module.exports = Rules; else root.Rules = Rules;
})(typeof window !== 'undefined' ? window : this);
