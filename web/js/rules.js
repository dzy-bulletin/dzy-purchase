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
  /* 名稱比對與自動建檔門檻（前後端共用，Eason 2026-10-04）。
     nameKey：控制字元→空白→trim→NFKC（全形轉半形）→去所有空白→去括號 （）()［］[] 與「・·」→小寫。廠商、品項同一支。 */
  function cleanName(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim(); }
  function nameKey(s) { return cleanName(s).normalize('NFKC').replace(/[\s()\[\]・·･]/g, '').toLowerCase(); }
  var PURE_NUM_RE = /^[\d\s.,\-+*\/%$]+$/;
  var ITEM_STOP_WORDS = ['合計', '小計', '總計', '總額', '稅額', '營業稅', '折扣', '折讓', '運費', '備註', '找零'];
  /* 自動建立門檻：長度 2–60、非純數字／標點；品項另外不可等於或包含合計類字樣 */
  function okAutoVendorName(name) { var n = cleanName(name); return n.length >= 2 && n.length <= 60 && !PURE_NUM_RE.test(n); }
  function okAutoItemName(name) { var n = cleanName(name); return okAutoVendorName(n) && !ITEM_STOP_WORDS.some(function (w) { return n.indexOf(w) >= 0; }); }
  var Rules = { round2: round2, near: near, sumCheck: sumCheck, nameKey: nameKey, okAutoVendorName: okAutoVendorName, okAutoItemName: okAutoItemName };
  if (typeof module !== 'undefined' && module.exports) module.exports = Rules; else root.Rules = Rules;
})(typeof window !== 'undefined' ? window : this);
