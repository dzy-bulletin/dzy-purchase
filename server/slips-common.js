'use strict';
// 貨單共用小函式：照片檔路徑、廠商比對、品名／單位解析（給 postprocess 的 ctx）
const path = require('path');

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

function makeCtx(db, brandId, vendorId) {
  return {
    resolveItem(line) {
      if (line.item_id) {
        const it = db.prepare('SELECT id, base_unit FROM items WHERE id = ? AND brand_id = ?').get(line.item_id, brandId);
        if (it) return it;
      }
      if (vendorId && line.raw_name) {
        return db.prepare('SELECT i.id, i.base_unit FROM item_aliases a JOIN items i ON i.id = a.item_id WHERE a.vendor_id = ? AND a.raw_name = ?').get(vendorId, line.raw_name) || null;
      }
      return null;
    },
    hasConv(itemId, unit) { return !!db.prepare('SELECT 1 FROM unit_conv WHERE item_id = ? AND unit = ?').get(itemId, unit); }
  };
}
module.exports = { photoFile, matchVendor, makeCtx };
