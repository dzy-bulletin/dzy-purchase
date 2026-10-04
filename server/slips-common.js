'use strict';
// 貨單共用小函式：照片檔路徑、廠商比對、品名／單位解析（給 postprocess 的 ctx）
const path = require('path');

// 共用文字正規化（#18）：控制字元→空白→trim→截長度。PUT 明細、辨識後處理、廠商記憶 alias、單位換算、品名建議全部走這一支，
// 才不會「存的」和「查的」差一個 tab 或差一個長度上限而對不上。
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
function normText(s, max) {
  const t = String(s == null ? '' : s).replace(CTRL_RE, ' ').trim();
  return max > 0 ? t.slice(0, max) : t;
}

// DB 裡的照片路徑照契約 data/photos/YYYYMM/<id>_<seq>.jpg；實際檔案在 DATA_DIR/photos/...
function photoFile(cfg, dbPath) { return path.join(cfg.DATA_DIR, dbPath.replace(/^data\//, '')); }

function matchVendor(db, brandId, name) {
  name = String(name || '').trim();
  if (!name) return null;
  const rows = db.prepare('SELECT id, name, aliases FROM vendors WHERE brand_id = ? AND active = 1').all(brandId);
  const norm = (s) => String(s).replace(/[\s（）()]/g, '').toLowerCase();
  const n = norm(name);
  for (const v of rows) {
    let al = []; try { al = JSON.parse(v.aliases || '[]'); } catch (e) { /* ignore */ }
    if ([v.name].concat(al).some((x) => x && norm(x) === n)) return v.id;
  }
  for (const v of rows) {               // 退而求其次：包含關係（至少 3 個字）
    const vn = norm(v.name);
    if (vn.length >= 3 && n.length >= 3 && (n.includes(vn) || vn.includes(n))) return v.id;
  }
  return null;
}

// useAlias＝辨識當下才用廠商記憶自動帶品名；之後會計核對（recheck）只認明確的 item_id，清掉就是清掉
function makeCtx(db, brandId, vendorId, useAlias) {
  return {
    resolveItem(line) {
      if (line.item_id) {
        const it = db.prepare('SELECT id, base_unit FROM items WHERE id = ? AND brand_id = ?').get(line.item_id, brandId);
        if (it) return it;
      }
      if (useAlias && vendorId && line.raw_name) {
        return db.prepare('SELECT i.id, i.base_unit FROM item_aliases a JOIN items i ON i.id = a.item_id WHERE a.vendor_id = ? AND a.raw_name = ? AND i.brand_id = ? AND i.active = 1').get(vendorId, normText(line.raw_name, 200), brandId) || null;
      }
      return null;
    },
    hasConv(itemId, unit) { return !!db.prepare('SELECT 1 FROM unit_conv WHERE item_id = ? AND unit = ?').get(itemId, unit); }
  };
}

// 入帳自動建檔（plan.md「廠商與品項自動建立」）：比對鍵＝normText 後去掉所有空白（含全形）、轉小寫
const nameKey = (s) => normText(s).replace(/\s+/g, '').toLowerCase();
// 同品牌找廠商：名稱或別名相同（含已停用）；找不到回 null
function findVendorByName(db, brandId, name) {
  const k = nameKey(name); if (!k) return null;
  for (const v of db.prepare('SELECT id, name, aliases, active FROM vendors WHERE brand_id = ? ORDER BY active DESC, id').all(brandId)) {
    let al = []; try { al = JSON.parse(v.aliases || '[]'); } catch (e) { /* ignore */ }
    if ([v.name].concat(al).some((x) => x && nameKey(x) === k)) return v.id;
  }
  return null;
}
// 同品牌找統一品名：normText 後完全相同（優先啟用中的）
function findItemByName(db, brandId, name) {
  const n = normText(name);
  if (!n) return null;
  const r = db.prepare('SELECT id FROM items WHERE brand_id = ? AND name = ? ORDER BY active DESC, id LIMIT 1').get(brandId, n);
  return r ? r.id : null;
}

module.exports = { findVendorByName, findItemByName, normText, photoFile, matchVendor, makeCtx };
