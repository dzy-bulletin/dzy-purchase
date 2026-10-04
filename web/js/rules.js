/* 前後端共用規則（plan.md 共用契約「數字」）。瀏覽器掛 window.Rules，Node 用 require。 */
(function (root) {
  'use strict';
  function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
  function near(a, b) { return Math.abs(a - b) < 0.01; }
  /* 總額規則（一張單只套一條式子，不准 OR）：
     taxIncluded=0（預設）：各列金額加總 ＋ 稅額（空白＝0）＝ 總額；subtotal 有值時只核對 ≈ 各列加總。
     taxIncluded=1（品項金額已含稅，Eason 2026-10-04）：各列金額加總 ＝ 總額；
       subtotal 與 tax 都有值時須 subtotal ＋ tax ＝ 總額，只有其中一個有值或都空白時不核對。
     缺總額、無明細或任一列缺金額＝不相符。 */
  function sumCheck(amounts, subtotal, tax, total, taxIncluded) {
    var missing = total == null || !amounts.length || amounts.some(function (a) { return a == null; });
    var sum = round2(amounts.reduce(function (s, a) { return s + (a == null ? 0 : a); }, 0));
    var ok;
    if (taxIncluded) ok = !missing && near(sum, total) && (tax == null || (tax >= 0 && tax < total)) && (subtotal == null || tax == null || near(round2(subtotal + tax), total));
    else ok = !missing && near(round2(sum + (tax == null ? 0 : tax)), total) && (subtotal == null || near(sum, subtotal));
    return { sum: sum, ok: ok, missing: missing };
  }
  var Rules = { round2: round2, near: near, sumCheck: sumCheck };
  if (typeof module !== 'undefined' && module.exports) module.exports = Rules; else root.Rules = Rules;
})(typeof window !== 'undefined' ? window : this);
