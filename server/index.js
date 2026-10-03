#!/usr/bin/env node
'use strict';
// 廠商貨單拍照建檔 — 伺服器（Node 內建模組，無框架）。路徑前綴 /purchase/api
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { openDb, audit, jobLog, nowIso } = require('./db');
const A = require('./auth');
const { ApiError, sendJson, readBody, parseMultipart } = require('./http-util');
const { evaluate, parseNum, parseManualDate, hasRed } = require('./postprocess');
const calc = require('./calc');
const { createWorker } = require('./worker');
const { photoFile, matchVendor, makeCtx } = require('./slips-common');

const PREFIX = '/purchase/api';
const STATUSES = ['uploaded', 'queued', 'recognizing', 'review', 'confirmed', 'failed', 'returned'];
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RAW = Symbol('raw');
const parseFlags = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };

function makeApp(cfg, opts) {
  opts = opts || {};
  const now = opts.now || (() => new Date());
  const db = opts.db || openDb(cfg.DATA_DIR);
  const worker = createWorker({ db, cfg, recognize: opts.recognize, log: opts.log });

  // ---------- 小工具 ----------
  const taipeiDate = () => new Date(now().getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const isoNow = () => now().toISOString();

  function originAllowed(o) {
    if (!o) return false;
    if (o === 'https://dzy-bulletin.github.io') return true;
    if (/^http:\/\/localhost(:\d+)?$/.test(o)) return true;
    return cfg.EXTRA_ORIGINS.includes(o);
  }
  function corsHeaders(req) {
    const o = req.headers.origin;
    return originAllowed(o) ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '600' } : {};
  }

  // mode: 'pos'＝必須 > 0（數量／單價／金額／總額；P1 不允許負數與 0，退貨之後再議）、'nonneg'＝稅額可為 0
  const num = (v, field, mode) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseNum(v);
    if (n === null) throw new ApiError('BAD_INPUT', `${field} 不是數字`);
    if (mode === 'nonneg' ? n < 0 : n <= 0) throw new ApiError('BAD_INPUT', `${field} 必須${mode === 'nonneg' ? '大於或等於' : '大於'} 0`);
    return n;
  };
  // DATE_FIXED 的說明：存實際原因（date_note 欄位），旗標在才顯示
  const dateNote = (s) => (parseFlags(s.flags).includes('DATE_FIXED') ? (s.date_note || '日期已自動補上，請對照照片確認') : null);

  function slipRow(id) {
    const s = db.prepare('SELECT * FROM slips WHERE id = ?').get(id);
    if (!s) throw new ApiError('NOT_FOUND', '找不到這張貨單');
    return s;
  }
  function accessSlip(p, id, opt) {
    const s = slipRow(id);
    if (!A.canSeeSlip(p, s, opt)) throw new ApiError('FORBIDDEN', '沒有權限讀取這張貨單');
    return s;
  }
  const linesOf = (id) => db.prepare('SELECT * FROM slip_lines WHERE slip_id = ? ORDER BY seq').all(id).map((l) => Object.assign({}, l, { flags: parseFlags(l.flags) }));

  function vendorName(id) { const v = id && db.prepare('SELECT name FROM vendors WHERE id = ?').get(id); return v ? v.name : null; }

  function summary(s) {
    const st = db.prepare('SELECT code, name FROM stores WHERE id = ?').get(s.store_id) || {};
    return { id: s.id, status: s.status, brand_id: s.brand_id, store_id: s.store_id, store_code: st.code, store_name: st.name,
      vendor_id: s.vendor_id, vendor_name: vendorName(s.vendor_id) || s.vendor_name_raw || null, vendor_name_raw: s.vendor_name_raw, doc_date: s.doc_date, doc_no: s.doc_no,
      total: s.total, flags: parseFlags(s.flags), uploaded_at: s.uploaded_at, confirmed_at: s.confirmed_at, return_reason: s.return_reason,
      error: s.error, photo_count: db.prepare('SELECT COUNT(*) c FROM slip_photos WHERE slip_id = ?').get(s.id).c };
  }

  function lastPrice(s, l) {
    const r = db.prepare(`SELECT l.unit_price, l.unit, s.doc_date FROM slip_lines l JOIN slips s ON s.id = l.slip_id
      WHERE s.status = 'confirmed' AND s.brand_id = ? AND s.id <> ? AND l.unit_price IS NOT NULL AND
      ((? IS NOT NULL AND s.vendor_id = ? AND l.raw_name = ?) OR (? IS NOT NULL AND l.item_id = ?))
      ORDER BY s.confirmed_at DESC LIMIT 1`).get(s.brand_id, s.id, s.vendor_id, s.vendor_id, l.raw_name, l.item_id, l.item_id);
    return r || null;
  }

  function detail(s) {
    const o = summary(s);
    o.date_note = dateNote(s); o.doc_date = s.doc_date; o.subtotal = s.subtotal; o.tax = s.tax; o.total_handwritten = s.total_handwritten ? 1 : 0;
    o.handwritten_note = s.handwritten_note; o.confirmed_by = s.confirmed_by; o.ai_model = s.ai_model; o.ai_seconds = s.ai_seconds; o.attempts = s.attempts;
    o.photos = db.prepare('SELECT seq FROM slip_photos WHERE slip_id = ? ORDER BY seq').all(s.id).map((p) => ({ seq: p.seq, url: `${PREFIX}/photos/${s.id}/${p.seq}` }));
    o.lines = linesOf(s.id).map((l) => ({ id: l.id, seq: l.seq, raw_name: l.raw_name, item_id: l.item_id, qty: l.qty, unit: l.unit, unit_price: l.unit_price,
      amount: l.amount, flags: l.flags, checked: l.checked ? 1 : 0, edited_by_human: l.edited_by_human ? 1 : 0, last_price: lastPrice(s, l) }));
    return o;
  }
  const snapshot = (s) => { const d = detail(s); delete d.photos; return d; };

  // 重算檢核並寫回（PUT／confirm 共用）。回傳 {flags, red}
  function recheck(s) {
    const lines = linesOf(s.id);
    const ctx = makeCtx(db, s.brand_id, s.vendor_id);
    const r = evaluate({ total: s.total, subtotal: s.subtotal, tax: s.tax, handwritten_note: s.handwritten_note, flags: parseFlags(s.flags) }, lines, ctx);
    const up = db.prepare('UPDATE slip_lines SET flags = ? WHERE id = ?');
    r.lines.forEach((l) => up.run(JSON.stringify(l.flags), l.id));
    db.prepare('UPDATE slips SET flags = ? WHERE id = ?').run(JSON.stringify(r.flags), s.id);
    const all = r.flags.concat(...r.lines.map((l) => l.flags));
    return { flags: r.flags, lines: r.lines, red: all.filter((f) => hasRed([f])) };
  }

  // ---------- 路由 ----------
  const routes = [];
  const route = (method, re, roles, fn) => routes.push({ method, re, roles, fn });

  route('GET', /^\/health$/, null, async () => {
    let ollama = false;
    try { const r = await fetch(cfg.OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(1500) }); ollama = r.ok; } catch (e) { /* 沒開 */ }
    const q = db.prepare("SELECT status, COUNT(*) c FROM slips WHERE status IN ('queued','recognizing') GROUP BY status").all();
    const queue = { queued: 0, recognizing: 0 }; q.forEach((r) => { queue[r.status] = r.c; });
    return { server: true, ollama, model: cfg.MODEL, queue, time: isoNow() };
  });

  route('POST', /^\/login$/, null, async ({ req }) => {
    const raw = await readBody(req, 64 * 1024);
    const b = parseJson(raw);
    const r = A.login(db, b.account, b.password, now());
    const p = r.principal;
    return { token: r.token, expires_at: r.expires_at, role: p.role, name: p.name, brand: p.brand_id, brand_id: p.brand_id, store_id: p.store_id, store: p.kind === 'store' ? { id: p.id, code: p.code, name: p.name } : null };
  });
  route('POST', /^\/logout$/, ['store', 'accountant', 'admin'], async ({ p }) => { A.logout(db, p); return {}; });

  route('GET', /^\/vendors$/, ['store', 'accountant', 'admin'], async ({ p, url }) => {
    const all = url.searchParams.get('all') === '1';
    const givenBrand = url.searchParams.get('brand_id');
    if (all && p.role === 'accountant' && givenBrand && givenBrand !== p.brand_id) throw new ApiError('FORBIDDEN', '不能操作其他品牌的資料');
    if (all && p.role === 'store') throw new ApiError('FORBIDDEN', '這個帳號沒有權限做這件事');
    const act = all ? '' : ' AND active = 1';
    let rows;
    if (p.role === 'admin') {
      const b = url.searchParams.get('brand_id');
      rows = b ? db.prepare(`SELECT id, name, brand_id, active FROM vendors WHERE brand_id = ?${act} ORDER BY name`).all(b)
               : db.prepare(`SELECT id, name, brand_id, active FROM vendors WHERE 1 = 1${act} ORDER BY brand_id, name`).all();
    } else rows = db.prepare(`SELECT id, name, brand_id, active FROM vendors WHERE brand_id = ?${act} ORDER BY name`).all(p.brand_id);
    if (all) return rows.map((v) => ({ id: v.id, name: v.name, brand_id: v.brand_id, active: v.active ? 1 : 0 }));
    return rows.map((v) => (p.role === 'admin' ? { id: v.id, name: v.name, brand_id: v.brand_id } : { id: v.id, name: v.name }));
  });

  // 上傳（門市）
  route('POST', /^\/slips$/, ['store'], async ({ req, p }) => {
    const limit = cfg.MAX_PHOTOS * cfg.MAX_PHOTO_BYTES + 1024 * 1024;
    const buf = await readBody(req, limit);
    if (!buf) throw new ApiError('BAD_INPUT', '上傳內容太大（照片每張最大 8MB、最多 6 張）');
    const { fields, files } = parseMultipart(buf, req.headers['content-type']);
    const clientId = String(fields.client_id || '').trim();
    if (!UUID4.test(clientId)) throw new ApiError('BAD_INPUT', 'client_id 必須是小寫 UUID v4');
    const photos = files.filter((f) => f.data.length > 0);
    // 冪等：同一個 client_id 重送 → 回原本那張
    const dup = db.prepare('SELECT * FROM slips WHERE client_id = ?').get(clientId);
    if (dup) {
      if (dup.store_id !== p.store_id) throw new ApiError('CONFLICT', 'client_id 已被使用');
      return { id: dup.id, status: dup.status, duplicate: true };
    }
    if (!photos.length) throw new ApiError('BAD_INPUT', '至少要一張照片');
    if (photos.length > cfg.MAX_PHOTOS) throw new ApiError('BAD_INPUT', `一次最多 ${cfg.MAX_PHOTOS} 張照片`);
    for (const f of photos) {
      if (f.data.length > cfg.MAX_PHOTO_BYTES) throw new ApiError('BAD_INPUT', '單張照片最大 8MB');
      if (!(f.data[0] === 0xff && f.data[1] === 0xd8)) throw new ApiError('BAD_INPUT', '照片必須是 JPEG');
    }
    let vendorId = null, vendorRaw = null;
    if (fields.vendor_id !== undefined && String(fields.vendor_id).trim() !== '') {
      const v = db.prepare('SELECT id FROM vendors WHERE id = ? AND brand_id = ? AND active = 1').get(Number(fields.vendor_id), p.brand_id);
      if (!v) throw new ApiError('BAD_INPUT', 'vendor_id 不存在或不屬於這個品牌');
      vendorId = v.id;
    } else if (fields.vendor_name && fields.vendor_name.trim()) {
      vendorRaw = fields.vendor_name.trim().slice(0, 100);
      vendorId = matchVendor(db, p.brand_id, vendorRaw);
      if (vendorId) vendorRaw = null;                  // 對得到就不留原字串
    }
    const day = taipeiDate(); const ym = day.slice(0, 7).replace('-', ''); const dkey = day.replace(/-/g, '');
    const out = db.tx(() => {
      const last = db.prepare('SELECT id FROM slips WHERE id LIKE ? ORDER BY id DESC LIMIT 1').get(`S${dkey}-%`);
      const seqNo = last ? Number(last.id.slice(-4)) + 1 : 1;
      if (seqNo > 9999) throw new ApiError('INTERNAL', '今日貨單流水號已滿');
      const id = `S${dkey}-${String(seqNo).padStart(4, '0')}`;
      const dir = path.join(cfg.DATA_DIR, 'photos', ym);
      fs.mkdirSync(dir, { recursive: true });
      db.prepare("INSERT INTO slips (id, client_id, store_id, brand_id, vendor_id, vendor_name_raw, status, uploaded_at) VALUES (?,?,?,?,?,?, 'uploaded', ?)")
        .run(id, clientId, p.store_id, p.brand_id, vendorId, vendorRaw, isoNow());
      const insP = db.prepare('INSERT INTO slip_photos (slip_id, seq, path, sha256) VALUES (?,?,?,?)');
      photos.forEach((f, i) => {
        const rel = `data/photos/${ym}/${id}_${i + 1}.jpg`;
        const full = photoFile(cfg, rel);
        fs.writeFileSync(full + '.tmp', f.data); fs.renameSync(full + '.tmp', full);
        insP.run(id, i + 1, rel, crypto.createHash('sha256').update(f.data).digest('hex'));
      });
      db.prepare("UPDATE slips SET status = 'queued' WHERE id = ?").run(id);
      audit(db, A.whoOf(p), 'upload', id, null, { photos: photos.length, vendor_id: vendorId, vendor_name_raw: vendorRaw });
      return id;
    });
    worker.kick();
    return { id: out, status: 'queued', duplicate: false };
  });

  route('GET', /^\/slips$/, ['store'], async ({ p, url }) => {
    if (url.searchParams.get('mine') !== '1') throw new ApiError('BAD_INPUT', '需要 mine=1');
    const since = new Date(now().getTime() - 30 * 86400e3).toISOString();
    return db.prepare('SELECT * FROM slips WHERE store_id = ? AND uploaded_at >= ? ORDER BY uploaded_at DESC, id DESC').all(p.store_id, since).map(summary);
  });

  route('GET', /^\/review$/, ['accountant', 'admin'], async ({ p, url }) => {
    const st = url.searchParams.get('status') || 'review';
    if (!STATUSES.includes(st)) throw new ApiError('BAD_INPUT', '狀態值不正確');
    let rows;
    if (p.role === 'accountant') {
      if (!p.brand_id) return [];
      rows = db.prepare('SELECT * FROM slips WHERE status = ? AND brand_id = ? ORDER BY uploaded_at, id').all(st, p.brand_id);
    } else {
      const b = url.searchParams.get('brand_id');
      rows = b ? db.prepare('SELECT * FROM slips WHERE status = ? AND brand_id = ? ORDER BY uploaded_at, id').all(st, b)
               : db.prepare('SELECT * FROM slips WHERE status = ? ORDER BY uploaded_at, id').all(st);
    }
    return rows.map(summary);
  });

  route('GET', /^\/slips\/([^/]+)$/, ['accountant', 'admin'], async ({ p, m }) => detail(accessSlip(p, m[1])));

  route('GET', /^\/photos\/([^/]+)\/(\d+)$/, ['store', 'accountant', 'admin'], async ({ p, m, res, req }) => {
    const s = accessSlip(p, m[1]);                                       // 門市只能看自己門市的
    const ph = db.prepare('SELECT path FROM slip_photos WHERE slip_id = ? AND seq = ?').get(s.id, Number(m[2]));
    if (!ph) throw new ApiError('NOT_FOUND', '找不到這張照片');
    let data;
    try { data = fs.readFileSync(photoFile(cfg, ph.path)); } catch (e) { throw new ApiError('NOT_FOUND', '照片檔不存在'); }
    res.writeHead(200, Object.assign({ 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=300' }, corsHeaders(req)));
    res.end(data);
    return RAW;
  });

  route('PUT', /^\/slips\/([^/]+)$/, ['accountant', 'admin'], async ({ req, p, m }) => {
    const b = parseJson(await readBody(req, 1024 * 1024));
    return db.tx(() => {
      const s = accessSlip(p, m[1]);
      if (!['review', 'failed'].includes(s.status)) throw new ApiError('CONFLICT', s.status === 'confirmed' ? '已入帳的貨單要先取消入帳才能修改' : s.status === 'returned' ? '已退回的貨單要先「重新開放」才能修改' : '這張貨單目前不能修改');
      const before = snapshot(s);
      const set = {};
      if (b.vendor_id === undefined && b.vendor_name !== undefined) {      // vendor_name → 解析成 vendor_id，對不到存原字串
        const nm = String(b.vendor_name == null ? '' : b.vendor_name).trim().slice(0, 100);
        const vid = nm ? matchVendor(db, s.brand_id, nm) : null;
        set.vendor_id = vid; set.vendor_name_raw = vid || !nm ? null : nm;
      }
      if (b.vendor_id !== undefined) {
        if (b.vendor_id === null) set.vendor_id = null;
        else {
          const v = db.prepare('SELECT id FROM vendors WHERE id = ? AND brand_id = ?').get(Number(b.vendor_id), s.brand_id);
          if (!v) throw new ApiError('BAD_INPUT', 'vendor_id 不存在或不屬於這個品牌');
          set.vendor_id = v.id;
        }
      }
      if (b.doc_date !== undefined) {
        // 人工輸入日期：只收 YYYY-MM-DD／民國 YYY-MM-DD／YYY/MM/DD；其他一律 BAD_INPUT，不得改成拍照日。
        // 會計送出的日期（即使等於系統補的值）視為人工確認，移除 DATE_FIXED。
        const nd = parseManualDate(b.doc_date);
        if (!nd) throw new ApiError('BAD_INPUT', '日期格式看不懂，請重新輸入');
        set.doc_date = nd;
        set.flags = JSON.stringify(parseFlags(s.flags).filter((f) => f !== 'DATE_FIXED'));
        set.date_note = null;
      }
      if (b.doc_no !== undefined) set.doc_no = b.doc_no == null ? null : String(b.doc_no).slice(0, 60);
      if (b.total !== undefined) set.total = num(b.total, 'total', 'pos');
      if (b.tax !== undefined) set.tax = num(b.tax, 'tax', 'nonneg');
      if (b.subtotal !== undefined) set.subtotal = num(b.subtotal, 'subtotal', 'pos');
      if (b.handwritten_note !== undefined) {
        const hn = b.handwritten_note == null ? '' : String(b.handwritten_note).trim().slice(0, 500);
        set.handwritten_note = hn || null;
        if (!hn) set.total_handwritten = 0;                              // 清空說明＝取消手寫標記（旗標由 recheck 重算移除）
      }
      const cols = Object.keys(set);
      if (cols.length) db.prepare(`UPDATE slips SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), s.id);
      if (b.lines !== undefined) {
        if (!Array.isArray(b.lines)) throw new ApiError('BAD_INPUT', 'lines 必須是陣列');
        const old = new Map(linesOf(s.id).map((l) => [l.id, l]));
        const keep = new Set();
        const seenIds = new Set();
        b.lines.forEach((l, i) => {
          if (!l || typeof l !== 'object') throw new ApiError('BAD_INPUT', 'lines 格式錯誤');
          if (l.id !== undefined && l.id !== null) {
            if (seenIds.has(Number(l.id))) throw new ApiError('BAD_INPUT', `明細列 ${l.id} 重複出現`);
            seenIds.add(Number(l.id));
          }
          const nl = { raw_name: String(l.raw_name == null ? '' : l.raw_name).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 200), unit: String(l.unit == null ? '' : l.unit).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 20),
            qty: num(l.qty, `第 ${i + 1} 列數量`, 'pos'), unit_price: num(l.unit_price, `第 ${i + 1} 列單價`, 'pos'), amount: num(l.amount, `第 ${i + 1} 列金額`, 'pos'), item_id: null };
          if (l.item_id) {
            const it = db.prepare('SELECT id, active FROM items WHERE id = ? AND brand_id = ?').get(Number(l.item_id), s.brand_id);
            if (!it) throw new ApiError('BAD_INPUT', 'item_id 不存在或不屬於這個品牌');
            const prevOwn = l.id !== undefined && l.id !== null ? old.get(Number(l.id)) : null;
            if (!it.active && !(prevOwn && prevOwn.item_id === it.id)) throw new ApiError('BAD_INPUT', '這個品項已停用，請改選其他品項');   // 原本就掛著的列維持原樣不擋
            nl.item_id = it.id;
          }
          const o = l.id !== undefined && l.id !== null ? old.get(Number(l.id)) : null;
          if (l.id !== undefined && l.id !== null && !o) throw new ApiError('BAD_INPUT', `找不到明細列 ${l.id}`);
          const changed = !o || ['raw_name', 'unit', 'qty', 'unit_price', 'amount', 'item_id'].some((k) => (o[k] == null ? null : o[k]) !== (nl[k] == null ? null : nl[k]));
          let flags = o ? o.flags : [];
          if (o && o.amount !== nl.amount) flags = flags.filter((f) => f !== 'AMOUNT_FIXED');
          const checked = l.checked !== undefined ? (l.checked ? 1 : 0) : (changed ? 0 : (o ? o.checked : 0));
          if (o) {
            keep.add(o.id);
            db.prepare('UPDATE slip_lines SET seq=?, raw_name=?, item_id=?, qty=?, unit=?, unit_price=?, amount=?, flags=?, checked=?, edited_by_human=? WHERE id=?')
              .run(i + 1, nl.raw_name, nl.item_id, nl.qty, nl.unit, nl.unit_price, nl.amount, JSON.stringify(flags), checked, (o.edited_by_human || changed) ? 1 : 0, o.id);
          } else {
            db.prepare('INSERT INTO slip_lines (slip_id, seq, raw_name, item_id, qty, unit, unit_price, amount, flags, checked, edited_by_human) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
              .run(s.id, i + 1, nl.raw_name, nl.item_id, nl.qty, nl.unit, nl.unit_price, nl.amount, '[]', checked);
          }
        });
        for (const id of old.keys()) if (!keep.has(id)) db.prepare('DELETE FROM slip_lines WHERE id = ?').run(id);
      }
      if (s.status !== 'review') db.prepare("UPDATE slips SET status = 'review', error = NULL WHERE id = ?").run(s.id);
      const cur = slipRow(s.id);
      recheck(cur);
      const after = snapshot(slipRow(s.id));
      audit(db, A.whoOf(p), 'edit', s.id, before, after);
      return detail(slipRow(s.id));
    });
  });

  route('POST', /^\/slips\/([^/]+)\/confirm$/, ['accountant', 'admin'], async ({ p, m }) => db.tx(() => {
    const s = accessSlip(p, m[1]);
    if (s.status !== 'review') throw new ApiError('CONFLICT', '只有「待核對」的貨單可以入帳');
    const before = snapshot(s);
    const r = recheck(s);                                                // 後端重算，不信前端
    if (r.red.length) throw new ApiError('RED_FLAGS', `還有紅色檢核沒處理：${[...new Set(r.red)].join('、')}`);
    const cur = slipRow(s.id);
    if (!cur.doc_date) throw new ApiError('BAD_INPUT', '缺少進貨日期');
    if (!r.lines.length) throw new ApiError('BAD_INPUT', '沒有品項明細');
    if (cur.total == null) throw new ApiError('BAD_INPUT', '缺少總額');
    const miss = r.lines.findIndex((l) => l.qty == null || l.unit_price == null || l.amount == null);
    if (miss >= 0) throw new ApiError('BAD_INPUT', `第 ${miss + 1} 列的數量、單價、金額都要填`);
    if (r.lines.some((l) => !l.checked)) throw new ApiError('CONFLICT', '還有明細列沒打勾');
    db.prepare("UPDATE slips SET status='confirmed', confirmed_at=?, confirmed_by=? WHERE id=?").run(isoNow(), A.whoOf(p), s.id);
    // 廠商記憶：有對到統一品名的列，記下「廠商＋原始寫法 → 品名」；再算價格變動提醒（先清掉舊的，避免重複）
    if (cur.vendor_id) {
      const up = db.prepare('INSERT OR REPLACE INTO item_aliases (vendor_id, raw_name, item_id) VALUES (?,?,?)');
      for (const l of r.lines) { const rn = String(l.raw_name || '').trim(); if (l.item_id && rn) up.run(cur.vendor_id, rn, l.item_id); }
    }
    calc.clearPriceAlerts(db, s.id);
    calc.generatePriceAlerts(db, s.id, isoNow());
    audit(db, A.whoOf(p), 'confirm', s.id, before, snapshot(slipRow(s.id)));
    return detail(slipRow(s.id));
  }));

  route('POST', /^\/slips\/([^/]+)\/unconfirm$/, ['accountant', 'admin'], async ({ req, p, m }) => {
    const b = parseJson(await readBody(req, 64 * 1024));
    const reason = String(b.reason == null ? '' : b.reason).trim();
    return db.tx(() => {
      const s = accessSlip(p, m[1]);
      if (s.status !== 'confirmed') throw new ApiError('CONFLICT', '只有已入帳的貨單可以取消入帳');
      if (!reason) throw new ApiError('BAD_INPUT', '取消入帳必須寫原因');
      const before = snapshot(s);
      calc.clearPriceAlerts(db, s.id);                                   // 取消入帳 → 撤銷這張產生的價格提醒
      db.prepare("UPDATE slips SET status='review', confirmed_at=NULL, confirmed_by=NULL WHERE id=?").run(s.id);
      audit(db, A.whoOf(p), 'unconfirm', s.id, before, Object.assign(snapshot(slipRow(s.id)), { reason }));
      return detail(slipRow(s.id));
    });
  });

  // 退回後要重新開放，必須明確動作：回到待核對，保留退回原因，寫 audit
  route('POST', /^\/slips\/([^/]+)\/reopen$/, ['accountant', 'admin'], async ({ p, m }) => db.tx(() => {
    const s = accessSlip(p, m[1]);
    if (s.status !== 'returned') throw new ApiError('CONFLICT', '只有「退回重拍」的貨單可以重新開放');
    const before = snapshot(s);
    db.prepare("UPDATE slips SET status='review', error=NULL WHERE id=?").run(s.id);        // return_reason 保留；清掉殘留的辨識錯誤
    audit(db, A.whoOf(p), 'reopen', s.id, before, Object.assign(snapshot(slipRow(s.id)), { return_reason: s.return_reason }));
    return detail(slipRow(s.id));
  }));

  // 辨識失敗（含停機中途被標 failed）→ 重新辨識：回到 queued、重試次數歸零、清錯誤
  route('POST', /^\/slips\/([^/]+)\/retry$/, ['accountant', 'admin'], async ({ p, m }) => {
    const out = db.tx(() => {
      const s = accessSlip(p, m[1]);
      if (s.status !== 'failed') throw new ApiError('CONFLICT', '只有「辨識失敗」的貨單可以重新辨識');
      const before = snapshot(s);
      db.prepare("UPDATE slips SET status='queued', attempts=0, error=NULL WHERE id=?").run(s.id);
      audit(db, A.whoOf(p), 'retry', s.id, before, snapshot(slipRow(s.id)));
      return detail(slipRow(s.id));
    });
    worker.kick();
    return out;
  });

  route('POST', /^\/slips\/([^/]+)\/return$/, ['accountant', 'admin'], async ({ req, p, m }) => {
    const b = parseJson(await readBody(req, 64 * 1024));
    const reason = String(b.reason == null ? '' : b.reason).trim().slice(0, 300);
    return db.tx(() => {
      const s = accessSlip(p, m[1]);
      if (!['review', 'failed'].includes(s.status)) throw new ApiError('CONFLICT', '這張貨單目前不能退回');
      const before = snapshot(s);
      db.prepare("UPDATE slips SET status='returned', return_reason=? WHERE id=?").run(reason || '照片不清楚，請重拍', s.id);
      audit(db, A.whoOf(p), 'return', s.id, before, Object.assign(snapshot(slipRow(s.id)), { reason }));
      return detail(slipRow(s.id));
    });
  });

  function parseJson(buf) {
    if (buf === null) throw new ApiError('BAD_INPUT', '內容太大');
    if (!buf.length) return {};
    try { const o = JSON.parse(buf.toString('utf8')); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (e) { /* fallthrough */ }
    throw new ApiError('BAD_INPUT', '請求內容不是 JSON 物件');
  }

  // ---------- P2：管理、基本資料、報表 ----------
  const rctx = { route, db, A, now, readBody, parseJson, RAW, corsHeaders };
  require('./master')(rctx);
  require('./reports')(rctx);

  // ---------- 派送 ----------
  async function handle(req, res) {
    const cors = corsHeaders(req);
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith(PREFIX + '/')) throw new ApiError('NOT_FOUND', '找不到這個路徑');
      const sub = url.pathname.slice(PREFIX.length);
      let matched = false;
      for (const r of routes) {
        const m = r.re.exec(sub);
        if (!m) continue;
        matched = true;
        if (r.method !== req.method) continue;
        let p = null;
        if (r.roles) { p = A.authenticate(db, req, now()); A.requireRole(p, ...r.roles); }
        const out = await r.fn({ req, res, p, m, url });
        if (out === RAW) return;
        return sendJson(res, 200, { ok: true, data: out === undefined ? {} : out }, cors);
      }
      throw new ApiError('NOT_FOUND', matched ? '不支援這個方法' : '找不到這個路徑');
    } catch (e) {
      if (e instanceof ApiError) return sendJson(res, e.status, { ok: false, error: e.code, message: e.message }, cors);
      jobLog(db, 'http', false, `${req.method} ${req.url} ${e && e.stack || e}`);
      return sendJson(res, 500, { ok: false, error: 'INTERNAL', message: '伺服器發生錯誤' }, cors);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 120000;
  return {
    server, db, worker, cfg,
    listen(port, host) { return new Promise((r) => server.listen(port === undefined ? cfg.PORT : port, host || cfg.BIND, () => { if (cfg.WORKER) worker.start(); r(server.address()); })); },
    close() { return worker.stop().then(() => new Promise((r) => server.close(() => { try { db.close(); } catch (e) { /* ignore */ } r(); }))); }
  };
}

if (require.main === module) {
  const major = parseInt(process.versions.node, 10);
  if (major < 24) { console.error(`需要 Node 24 以上，目前是 v${process.versions.node}`); process.exit(1); }
  const cfg = loadConfig();
  const app = makeApp(cfg, { log: (m) => console.log(new Date().toISOString(), m) });
  app.listen().then((a) => console.log(`purchase server listening on ${a.address}:${a.port}, data=${cfg.DATA_DIR}, model=${cfg.MODEL}`));
  const bye = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
module.exports = { makeApp, PREFIX };
