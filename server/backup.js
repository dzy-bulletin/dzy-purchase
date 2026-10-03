#!/usr/bin/env node
'use strict';
// T19：每日金額備份（Mac mini → Apps Script → Google 試算表「鼎兆元｜進貨金額備份」）。
// 手動執行：node server/backup.js（P4 再由 launchd 03:40 觸發）。只送「本月＋上月＋上次成功備份後有入帳／取消入帳異動的月份」已入帳貨單與明細，只有文字與數字——沒有照片、沒有路徑、沒有 AI 原文。
// 一個月一個分頁，整頁覆蓋（跑兩次結果相同）。成功才寫 logs/backup-last.json；失敗不動它（/health 看它的時間判紅燈），並記一筆 jobs_log、結束碼非 0。
const fs = require('fs');
const path = require('path');

const pad = (n) => String(n).padStart(2, '0');
// 台北時間的「本月、上月」
function monthsOf(date) {
  const t = new Date(date.getTime() + 8 * 3600e3);
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  return [`${y}-${pad(m)}`, `${py}-${pad(pm)}`];
}

// 上次成功備份（backup-last.json）之後，有「入帳／取消入帳」異動的貨單，依進貨日期（doc_date）算出的月份（P3 審查 #6）。
// 遲到入帳、或跨月後才取消入帳的舊貨單，月份落在本月／上月以外，也要重寫那一頁才不會與資料庫不一致。從沒成功過 → 全部有異動過的月份。
function changedMonths(db, sinceIso) {
  const rows = sinceIso
    ? db.prepare("SELECT DISTINCT substr(s.doc_date,1,7) m FROM audit a JOIN slips s ON s.id = a.slip_id WHERE a.action IN ('confirm','unconfirm') AND a.at > ? AND s.doc_date IS NOT NULL").all(sinceIso)
    : db.prepare("SELECT DISTINCT substr(s.doc_date,1,7) m FROM audit a JOIN slips s ON s.id = a.slip_id WHERE a.action IN ('confirm','unconfirm') AND s.doc_date IS NOT NULL").all();
  return rows.map((r) => r.m).filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m));
}
function lastBackupAt(cfg) {
  try { const j = JSON.parse(fs.readFileSync(path.join(cfg.LOG_DIR, 'backup-last.json'), 'utf8')); return j && j.ok !== false && typeof j.at === 'string' ? j.at : null; }
  catch (e) { return null; }
}

// 某月（依進貨日期 doc_date）已入帳的貨單＋明細。欄位全是文字或數字。
function collect(db, month) {
  const from = `${month}-01`, to = `${month}-31`;           // 字串比較：doc_date 是 YYYY-MM-DD，月內任何一天都落在 [01, 31]
  const slips = db.prepare(`SELECT s.id, s.doc_date, st.code store_code, st.name store_name, s.brand_id, COALESCE(v.name, s.vendor_name_raw, '') vendor_name,
      COALESCE(s.doc_no, '') doc_no, s.subtotal, s.tax, s.total, COALESCE(s.confirmed_at, '') confirmed_at
    FROM slips s JOIN stores st ON st.id = s.store_id LEFT JOIN vendors v ON v.id = s.vendor_id
    WHERE s.status = 'confirmed' AND s.doc_date >= ? AND s.doc_date <= ? ORDER BY s.doc_date, s.id`).all(from, to).map((r) => Object.assign({}, r));
  const lines = db.prepare(`SELECT l.slip_id, l.seq, l.raw_name, COALESCE(i.name, '') item_name, COALESCE(i.category, '') category, l.qty, COALESCE(l.unit, '') unit, l.unit_price, l.amount
    FROM slip_lines l JOIN slips s ON s.id = l.slip_id LEFT JOIN items i ON i.id = l.item_id
    WHERE s.status = 'confirmed' AND s.doc_date >= ? AND s.doc_date <= ? ORDER BY l.slip_id, l.seq`).all(from, to).map((r) => Object.assign({}, r));
  return { slips, lines };
}

async function post(cfg, doFetch, payload) {
  let text;
  try {
    const res = await doFetch(cfg.BACKUP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload),
      redirect: 'follow', signal: AbortSignal.timeout(cfg.BACKUP_TIMEOUT_MS || 90000) });
    text = await res.text();
  } catch (e) { throw new Error((e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'TIMEOUT' : 'NETWORK'); }
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error('NOT_JSON'); }
  if (!j || j.ok !== true) throw new Error(String((j && (j.code || j.error)) || 'REJECTED').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'REJECTED');
  return j.data || {};
}

// opts: { db, cfg, now(), fetchImpl } → { ok, months:[], slips, lines } ；失敗時 throw
async function runBackup(opts) {
  const { db, cfg } = opts;
  const now = (opts.now || (() => new Date()))();
  const doFetch = opts.fetchImpl || ((...a) => fetch(...a));
  if (!cfg.BACKUP_URL || !cfg.BACKUP_KEY) throw new Error('NOT_CONFIGURED');
  let nSlips = 0, nLines = 0;
  const base = monthsOf(now);
  const months = base.concat([...new Set(changedMonths(db, lastBackupAt(cfg)))].filter((m) => !base.includes(m)).sort().reverse());   // 本月、上月，再加有異動的其他月份（新到舊）
  try {
    for (const month of months) {                      // 即使該月現在是空的也要送：整頁覆蓋才能把「後來取消入帳」的資料清掉
      const d = collect(db, month);
      await post(cfg, doFetch, { action: 'backup', key: cfg.BACKUP_KEY, month, slips: d.slips, lines: d.lines });
      nSlips += d.slips.length; nLines += d.lines.length;
    }
  } catch (e) {
    try { db.prepare('INSERT INTO jobs_log (at, job, ok, detail) VALUES (?,?,?,?)').run(now.toISOString(), 'backup', 0, String(e.message).slice(0, 200)); } catch (x) { /* ignore */ }
    throw e;
  }
  const rec = { ok: true, at: now.toISOString(), months, slips: nSlips, lines: nLines };
  fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
  const file = path.join(cfg.LOG_DIR, 'backup-last.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(rec) + '\n'); fs.renameSync(file + '.tmp', file);
  try { db.prepare('INSERT INTO jobs_log (at, job, ok, detail) VALUES (?,?,?,?)').run(now.toISOString(), 'backup', 1, `months=${months.join(',')} slips=${nSlips} lines=${nLines}`); } catch (x) { /* ignore */ }
  return rec;
}

module.exports = { runBackup, collect, monthsOf, changedMonths };

if (require.main === module) {
  const { loadConfig } = require('./config');
  const { openDb } = require('./db');
  const cfg = loadConfig();
  const db = openDb(cfg.DATA_DIR);
  runBackup({ db, cfg }).then((r) => { console.log(`備份完成：${r.months.join('、')}，貨單 ${r.slips} 張、明細 ${r.lines} 列`); db.close(); })
    .catch((e) => { console.error('備份失敗：' + (e.message === 'NOT_CONFIGURED' ? '未設定 BACKUP_URL／BACKUP_KEY' : e.message)); try { db.close(); } catch (x) { /* ignore */ } process.exit(e.message === 'NOT_CONFIGURED' ? 2 : 1); });
}
