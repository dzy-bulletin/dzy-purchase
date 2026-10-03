/* 鼎兆元｜進貨金額備份 — Apps Script 橋接（T19）
 * 正本在 repo ~/mala-purchase/gas/。Mac mini 的 server/backup.js 每天帶金鑰 POST 進來，這裡把「已入帳貨單＋明細」整頁覆蓋寫進試算表。
 *   doPost { action:'backup', key, month:'YYYY-MM', slips:[…], lines:[…] }
 *   - 金鑰：Script Property BACKUP_KEY；沒設（或空字串）一律拒絕（AUTH）。比對用等長逐字元（不提早結束）；10 分鐘內錯 20 次鎖 10 分鐘。
 *   - 一個月一個分頁（分頁名＝YYYY-MM），每次整頁清空重寫：跑兩次結果相同，後來取消入帳的資料也會被清掉。
 *   - 只收固定欄位（SLIP_COLS_／LINE_COLS_），其他欄位一律忽略；只收文字與數字。試算表是副本，手動改不會回寫，下次備份蓋回去。
 *   - 試算表由 setup() 建立、ID 存在 Script Property SHEET_ID；不分享給任何人。 */
'use strict';

var SHEET_TITLE_ = '鼎兆元｜進貨金額備份';
var MAX_SLIPS_ = 5000, MAX_LINES_ = 50000, MAX_CELL_ = 300;
var FAIL_LIMIT_ = 20, FAIL_WINDOW_S_ = 600, LOCK_S_ = 600;

// 欄位：[key, 表頭, 型別]（t＝文字、n＝數字）
var SLIP_COLS_ = [['id', '貨單ID', 't'], ['doc_date', '進貨日期', 't'], ['store_code', '門市代號', 't'], ['store_name', '門市', 't'], ['brand_id', '品牌', 't'],
  ['vendor_name', '廠商', 't'], ['doc_no', '單號', 't'], ['subtotal', '未稅合計', 'n'], ['tax', '稅額', 'n'], ['total', '總額', 'n'], ['confirmed_at', '入帳時間', 't']];
var LINE_COLS_ = [['slip_id', '貨單ID', 't'], ['seq', '序', 'n'], ['raw_name', '品名（單上寫的）', 't'], ['item_name', '統一品名', 't'], ['category', '類別', 't'],
  ['qty', '數量', 'n'], ['unit', '單位', 't'], ['unit_price', '單價', 'n'], ['amount', '金額', 'n']];

/** 第一次部署：在編輯器手動執行一次（授權試算表權限）。建立備份用試算表並把 ID 存進 Script Property。重複執行不會再建第二份。 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) {
    try { SpreadsheetApp.openById(id); Logger.log('試算表已存在：' + id + '（沒有重建）'); return id; } catch (e) { Logger.log('原本記的試算表打不開，重建一份'); }
  }
  var ss = SpreadsheetApp.create(SHEET_TITLE_);
  props.setProperty('SHEET_ID', ss.getId());
  Logger.log('已建立試算表：' + ss.getUrl() + '（不分享給任何人）');
  Logger.log(props.getProperty('BACKUP_KEY') ? 'BACKUP_KEY 已設定' : '⚠ BACKUP_KEY 還沒設定——到 專案設定 → 指令碼屬性 自己加（沒設一律拒絕所有請求）');
  return ss.getId();
}

function doGet() { return json_({ ok: true, data: { app: 'purchase-backup' } }); }

function doPost(e) {
  var req;
  try { req = JSON.parse(e && e.postData ? e.postData.contents : '{}'); }
  catch (x) { return json_({ ok: false, code: 'BAD_REQ', message: '格式錯誤' }); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return json_({ ok: false, code: 'BAD_REQ', message: '格式錯誤' });
  if (String(req.action || '') !== 'backup') return json_({ ok: false, code: 'BAD_REQ', message: '不支援的動作' });
  var auth = checkKey_(req.key);
  if (auth) return json_(auth);
  try {
    var month = String(req.month || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json_({ ok: false, code: 'BAD_REQ', message: '月份格式錯誤' });
    if (!Array.isArray(req.slips) || !Array.isArray(req.lines)) return json_({ ok: false, code: 'BAD_REQ', message: 'slips／lines 必須是陣列' });
    if (req.slips.length > MAX_SLIPS_ || req.lines.length > MAX_LINES_) return json_({ ok: false, code: 'BAD_REQ', message: '資料筆數太多' });
    var slipRows = rows_(req.slips, SLIP_COLS_), lineRows = rows_(req.lines, LINE_COLS_);
    if (!slipRows || !lineRows) return json_({ ok: false, code: 'BAD_REQ', message: '資料只能是文字或數字' });
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) return json_({ ok: false, code: 'SERVER', message: '尚未執行 setup()' });
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return json_({ ok: false, code: 'SERVER', message: '系統忙碌，請稍後再試' });
    try { writeMonth_(SpreadsheetApp.openById(id), month, slipRows, lineRows); }
    finally { lock.releaseLock(); }
    return json_({ ok: true, data: { month: month, slips: slipRows.length, lines: lineRows.length } });
  } catch (x) {
    console.error('backup: ' + (x && x.stack || x));
    return json_({ ok: false, code: 'SERVER', message: '系統忙碌，請稍後再試' });
  }
}

/* 金鑰檢查：回 null＝通過；否則回要送出的錯誤物件 */
function checkKey_(given) {
  var cache = null; try { cache = CacheService.getScriptCache(); } catch (x) { cache = null; }
  var failKey = 'bk_fail', lockKey = 'bk_lock';
  if (cache && cache.get(lockKey)) return { ok: false, code: 'LOCKED', message: '錯誤次數過多，請稍後再試' };
  var key = PropertiesService.getScriptProperties().getProperty('BACKUP_KEY');
  var good = !!key && String(key).length > 0 && typeof given === 'string' && safeEq_(String(key), given);
  if (good) return null;
  if (cache) {
    var n = Number(cache.get(failKey) || 0) + 1;
    if (n >= FAIL_LIMIT_) { cache.put(lockKey, '1', LOCK_S_); cache.remove(failKey); } else cache.put(failKey, String(n), FAIL_WINDOW_S_);
  }
  return { ok: false, code: 'AUTH', message: '驗證失敗' };
}
function safeEq_(a, b) {                       // 長度不同也走完整個迴圈
  var n = Math.max(a.length, b.length), d = a.length ^ b.length;
  for (var i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

/* 依固定欄位取值；遇到不是純量（物件、陣列、布林）→ 回 null（整筆拒絕）。文字截 MAX_CELL_，數字必須是有限數字或空白 */
function rows_(list, cols) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    var row = [];
    for (var c = 0; c < cols.length; c++) {
      var v = r[cols[c][0]];
      if (v === null || v === undefined || v === '') { row.push(''); continue; }
      if (cols[c][2] === 'n') {
        if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) v = Number(v);
        if (typeof v !== 'number' || !isFinite(v)) return null;
        row.push(v);
      } else {
        var wasNum = typeof v === 'number' && isFinite(v);
        if (wasNum) v = String(v);
        if (typeof v !== 'string') return null;
        v = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAX_CELL_);
        if (!wasNum && /^[=+\-@]/.test(v)) v = "'" + v;      // 防公式注入雙保險：=、+、-、@ 開頭的文字前面加 '（欄位同時設成純文字格式）
        row.push(v);
      }
    }
    out.push(row);
  }
  return out;
}

/* 整頁覆蓋：清掉整個分頁（內容與格式）再重寫；先把格式設成純文字／數字，避免 "2026-10-01" 被轉成日期或 "=…" 被當成公式 */
function writeMonth_(ss, month, slipRows, lineRows) {
  var sh = ss.getSheetByName(month) || ss.insertSheet(month);
  sh.clear();
  var width = Math.max(SLIP_COLS_.length, LINE_COLS_.length);
  var matrix = [], fmts = [];
  function pad_(arr, fill) { var a = arr.slice(); while (a.length < width) a.push(fill); return a; }
  function block_(title, cols, rows) {
    matrix.push(pad_([title + '（' + month + '，共 ' + rows.length + ' 筆；本頁由系統自動備份，手動修改會在下次備份被蓋掉）'], '')); fmts.push(pad_(['@'], '@'));
    matrix.push(pad_(cols.map(function (c) { return c[1]; }), '')); fmts.push(pad_(cols.map(function () { return '@'; }), '@'));
    var f = cols.map(function (c) { return c[2] === 'n' ? '#,##0.##' : '@'; });
    rows.forEach(function (r) { matrix.push(pad_(r, '')); fmts.push(pad_(f, '@')); });
  }
  block_('貨單', SLIP_COLS_, slipRows);
  matrix.push(pad_([], '')); fmts.push(pad_([], '@'));
  block_('明細', LINE_COLS_, lineRows);
  var range = sh.getRange(1, 1, matrix.length, width);
  range.setNumberFormats(fmts);
  range.setValues(matrix);
  sh.setFrozenRows(0);
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
