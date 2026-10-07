#!/usr/bin/env node
'use strict';
// 清空某一間門市的全部貨單（含品項明細、價格提醒、照片），並讓損益端該店各月的進貨金額跟著重算（刪光＝歸零）。
// 在 Mac mini 的「終端機」由 Eason 執行：
//   node server/tools/delete-store-slips.js MDGF            只預覽：列出張數、月份、已入帳金額，不改任何東西
//   node server/tools/delete-store-slips.js MDGF --apply    真的刪
// --apply 會先做兩件保險：
//   1. 整個資料庫備份到 DATA_DIR/before-delete-<代號>-<時間>.db（VACUUM INTO，可直接拿來還原）
//   2. 照片不刪，整批搬到 DATA_DIR/deleted-photos/<代號>-<時間>/
// 損益：刪除後對「曾有已入帳貨單的月份」＋「曾推送過的月份」呼叫 markDirty，貨單伺服器的推送迴圈（60 秒內）會重算並推送，
// 該店該月進貨科目變 0。伺服器不用重啟。已定稿的月份損益端會拒收，會出現在損益推送異常裡，需到損益系統解除定稿後重推。
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config');
const { openDb, audit } = require('../db');
const { markDirty } = require('../pnl-push');
const { photoFile } = require('../slips-common');

const code = process.argv[2];
const apply = process.argv.includes('--apply');
if (!code || code.startsWith('-')) { console.error('用法：node server/tools/delete-store-slips.js <門市代號> [--apply]'); process.exit(2); }

const cfg = loadConfig();
const db = openDb(cfg.DATA_DIR);
const store = db.prepare('SELECT id, code, name FROM stores WHERE code = ?').get(code);
if (!store) { console.error(`找不到門市代號 ${code}`); process.exit(1); }

const slips = db.prepare('SELECT id, status, doc_date, total FROM slips WHERE store_id = ? ORDER BY uploaded_at').all(store.id);
const confirmed = slips.filter((s) => s.status === 'confirmed');
const months = new Set();
confirmed.forEach((s) => { if (s.doc_date) months.add(String(s.doc_date).slice(0, 7)); });
db.prepare('SELECT DISTINCT month FROM pnl_pushed WHERE store_id = ?').all(store.id).forEach((r) => months.add(r.month));
db.prepare('SELECT month FROM pnl_outbox WHERE store_id = ?').all(store.id).forEach((r) => months.add(r.month));
const photos = db.prepare('SELECT p.slip_id, p.seq, p.path FROM slip_photos p JOIN slips s ON s.id = p.slip_id WHERE s.store_id = ?').all(store.id);
const lineCount = db.prepare('SELECT COUNT(*) c FROM slip_lines l JOIN slips s ON s.id = l.slip_id WHERE s.store_id = ?').get(store.id).c;
const byStatus = {};
slips.forEach((s) => { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
const sum = confirmed.reduce((a, s) => a + (Number(s.total) || 0), 0);

console.log(`門市：${store.code} ${store.name}`);
console.log(`貨單 ${slips.length} 張（${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join('、') || '無'}），品項明細 ${lineCount} 列，照片 ${photos.length} 張`);
console.log(`已入帳 ${confirmed.length} 張，合計 ${sum.toLocaleString()} 元`);
console.log(`損益要重算的月份：${[...months].sort().join('、') || '無'}`);
if (!apply) { console.log('\n（預覽，沒有改任何東西。確認無誤後加 --apply 執行）'); process.exit(0); }
if (!slips.length) { console.log('沒有貨單可刪。'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const backup = path.join(cfg.DATA_DIR, `before-delete-${store.code}-${stamp}.db`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`\n已備份資料庫：${backup}`);

const trash = path.join(cfg.DATA_DIR, 'deleted-photos', `${store.code}-${stamp}`);
let moved = 0;
for (const p of photos) {
  const src = photoFile(cfg, p.path);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(trash, p.slip_id, path.basename(src));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst); moved++;
}
console.log(`照片已搬到：${trash}（${moved} 張）`);

const at = new Date().toISOString();
const sub = 'SELECT id FROM slips WHERE store_id = ?';
db.exec('BEGIN');
try {
  db.prepare(`DELETE FROM price_alerts WHERE line_id IN (SELECT id FROM slip_lines WHERE slip_id IN (${sub}))`).run(store.id);
  db.prepare(`DELETE FROM slip_lines WHERE slip_id IN (${sub})`).run(store.id);
  db.prepare(`DELETE FROM slip_photos WHERE slip_id IN (${sub})`).run(store.id);
  const n = db.prepare('DELETE FROM slips WHERE store_id = ?').run(store.id).changes;
  for (const m of months) markDirty(db, store.id, m, at);
  audit(db, 'tool:delete-store-slips', 'delete_store_slips', null, { store: store.code, slips: n, confirmed: confirmed.length, total: sum, backup }, { months: [...months].sort() });
  db.exec('COMMIT');
  console.log(`已刪除 ${n} 張貨單；損益已排入重算 ${months.size} 個月份（貨單伺服器 60 秒內推送）。`);
} catch (e) { db.exec('ROLLBACK'); console.error('刪除失敗，已全部還原：', e.message); process.exit(1); }
db.close();
