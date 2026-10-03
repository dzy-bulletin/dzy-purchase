'use strict';
// 辨識工人：一次一張。失敗重試 2 次 → failed；Ollama 不在時不卡住（連線失敗很快就會標 failed）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { audit, jobLog, nowIso } = require('./db');
const { postprocess } = require('./postprocess');
const { makeCtx, matchVendor, photoFile } = require('./slips-common');

// 提示詞照 spike 第 2 輪驗證過的版本
const PROMPT = `這是一張台灣餐廳收到的廠商貨單（出貨單／銷貨單／估價單／對帳單）照片。
請只輸出 JSON，不要其他文字，格式：
{"vendor":"開單廠商（印在抬頭的公司名，不是客戶名稱）","date":"照單上原樣抄寫","doc_no":"單號","lines":[{"name":"品名","qty":"數量","unit":"單位","unit_price":"單價","amount":"金額"}],"subtotal":"未稅合計","tax":"稅額","total":"總計（有手寫修正就用手寫的）","handwritten_changes":"手寫修改說明"}
所有值一律用字串（加雙引號），數字不要千分位逗號。看不清楚填空字串，不要猜。`;

const MAX_EDGE = 16 * 100;   // 長邊上限（像素）
// 長邊縮到 MAX_EDGE（macOS sips；沒有就用原圖，Ollama 自己也會縮）
function shrink(file) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `purchase-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    execFile('sips', ['-Z', String(MAX_EDGE), file, '--out', tmp], { timeout: 30000 }, (err) => {
      if (err) return resolve(fs.readFileSync(file));
      try { const b = fs.readFileSync(tmp); fs.unlinkSync(tmp); resolve(b); } catch (e) { resolve(fs.readFileSync(file)); }
    });
  });
}

// 預設辨識函式：呼叫 Ollama。回傳模型的原始文字
async function ollamaRecognize(cfg, files) {
  const images = [];
  for (const f of files) images.push((await shrink(f)).toString('base64'));
  const res = await fetch(`${cfg.OLLAMA_URL}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.MODEL, prompt: PROMPT, images, stream: false, format: 'json',
                           options: { temperature: 0, num_ctx: 16384, num_predict: 3000 } }),
    signal: AbortSignal.timeout(cfg.OLLAMA_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const j = await res.json();
  return String(j.response || '');
}

function parseAi(text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw new Error('模型回傳不是合法 JSON'); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.lines)) throw new Error('模型回傳缺少 lines');
  return o;
}

function createWorker({ db, cfg, recognize, log }) {
  const say = log || (() => {});
  const rec = recognize || ((files) => ollamaRecognize(cfg, files));
  let timer = null, running = false, stopped = false, kicked = false, started = false, chain = Promise.resolve(), runP = Promise.resolve();

  function requeueStuck() {      // 重啟時：上次當機留下的辨識中／已上傳（還沒排隊）→ 重新排隊
    db.exec("UPDATE slips SET status = 'queued' WHERE status IN ('recognizing','uploaded') AND EXISTS (SELECT 1 FROM slip_photos p WHERE p.slip_id = slips.id)");
  }

  function claim() {
    return db.tx(() => {
      // 處理全部串成一條鏈，輪到這裡時不可能有別張正在辨識：殘留的 recognizing 一定是卡住的，重新排隊
      db.prepare("UPDATE slips SET status = 'queued' WHERE status = 'recognizing'").run();
      const s = db.prepare("SELECT * FROM slips WHERE status = 'queued' ORDER BY uploaded_at, id LIMIT 1").get();
      if (!s) return null;
      db.prepare("UPDATE slips SET status = 'recognizing', error = NULL WHERE id = ?").run(s.id);
      return s;
    });
  }

  function saveResult(slip, text, seconds) {
    const ai = parseAi(text);
    db.tx(() => {
      const cur = db.prepare('SELECT vendor_id, vendor_name_raw FROM slips WHERE id = ?').get(slip.id);
      const shot = `${slip.id.slice(1, 5)}-${slip.id.slice(5, 7)}-${slip.id.slice(7, 9)}`;
      const ctx = makeCtx(db, slip.brand_id, cur.vendor_id);
      const r = postprocess(ai, shot, ctx);
      let vendorId = cur.vendor_id, vendorRaw = cur.vendor_name_raw;
      if (!vendorId) {
        vendorId = matchVendor(db, slip.brand_id, r.vendor_name);
        if (!vendorId && !vendorRaw && r.vendor_name) vendorRaw = r.vendor_name;
      }
      db.prepare(`UPDATE slips SET status='review', vendor_id=?, vendor_name_raw=?, doc_date=?, doc_no=?, subtotal=?, tax=?, total=?,
                  total_handwritten=?, handwritten_note=?, flags=?, ai_raw=?, ai_model=?, ai_seconds=?, error=NULL WHERE id=?`)
        .run(vendorId, vendorRaw, r.doc_date, r.doc_no, r.subtotal, r.tax, r.total, r.total_handwritten, r.handwritten_note,
             JSON.stringify(r.flags), text, cfg.MODEL, Math.round(seconds * 10) / 10, slip.id);
      db.prepare('DELETE FROM slip_lines WHERE slip_id = ?').run(slip.id);
      const ins = db.prepare('INSERT INTO slip_lines (slip_id, seq, raw_name, item_id, qty, unit, unit_price, amount, flags, checked, edited_by_human) VALUES (?,?,?,?,?,?,?,?,?,0,0)');
      for (const l of r.lines) ins.run(slip.id, l.seq, l.raw_name, l.item_id, l.qty, l.unit, l.unit_price, l.amount, JSON.stringify(l.flags));
      audit(db, 'system:worker', 'recognize', slip.id, null, { status: 'review', lines: r.lines.length, flags: r.flags });
    });
  }

  // 任何錯誤路徑都不可把貨單留在 recognizing：外層兜底改標 failed
  function markFailed(id, msg) {
    const m = String(msg || '').slice(0, 500);
    try {
      db.tx(() => {
        db.prepare("UPDATE slips SET status = 'failed', error = ? WHERE id = ?").run(m, id);
        audit(db, 'system:worker', 'recognize_failed', id, null, { error: m });
      });
    } catch (e) {
      try { db.prepare("UPDATE slips SET status = 'failed', error = ? WHERE id = ?").run(m, id); } catch (e2) { say('[worker] markFailed error ' + e2.message); }
    }
  }

  async function processOne() {
    const slip = claim();
    if (!slip) return false;
    let lastErr = '';
    try {
      const files = db.prepare('SELECT path FROM slip_photos WHERE slip_id = ? ORDER BY seq').all(slip.id).map((p) => photoFile(cfg, p.path));
      for (let attempt = 1; attempt <= 3; attempt++) {       // 第 1 次＋重試 2 次
        const t0 = Date.now();
        try {
          const text = await rec(files, slip);
          saveResult(slip, text, (Date.now() - t0) / 1000);
          try { jobLog(db, 'recognize', true, `${slip.id} attempt=${attempt} ${Math.round((Date.now() - t0) / 1000)}s`); } catch (e3) { /* 已存好，記錄失敗不重來 */ }
          say(`[worker] ${slip.id} -> review (${Math.round((Date.now() - t0) / 1000)}s)`);
          return true;
        } catch (e) {
          lastErr = String((e && e.cause && e.cause.code) || '') + ' ' + String((e && e.message) || e);
          lastErr = lastErr.trim();
          try { db.prepare('UPDATE slips SET attempts = ? WHERE id = ?').run(attempt, slip.id); jobLog(db, 'recognize', false, `${slip.id} attempt=${attempt} ${lastErr}`); } catch (e2) { /* 記錄失敗不影響後續 */ }
          say(`[worker] ${slip.id} attempt ${attempt} failed: ${lastErr}`);
          if (attempt < 3 && !stopped) await new Promise((r) => setTimeout(r, cfg.RETRY_DELAY_MS));
          else break;
        }
      }
    } catch (e) { lastErr = 'worker: ' + String((e && e.message) || e); }
    markFailed(slip.id, lastErr || 'unknown');
    return true;
  }

  // 所有處理排成一條鏈：不管誰呼叫 drain，同時只會有一張在辨識（32GB 一次只跑一個模型）
  function drain() {
    const p = chain.then(async () => { while (!stopped && await processOne()) { /* 一次一張 */ } });
    chain = p.catch(() => {});
    return p;
  }

  async function loop() {
    if (running || stopped) return;
    running = true;
    let done; runP = new Promise((r) => { done = r; });
    try { do { kicked = false; await drain(); } while (kicked && !stopped); }
    catch (e) { say('[worker] loop error ' + e.message); jobLog(db, 'recognize', false, 'loop ' + e.message); }
    finally { running = false; done(); }
  }

  return {
    start() { stopped = false; started = true; requeueStuck(); loop(); timer = setInterval(loop, 5000); timer.unref && timer.unref(); },
    stop() { stopped = true; if (timer) clearInterval(timer); return Promise.all([runP, chain]); },
    kick() { if (!started) return; kicked = true; setImmediate(loop); },
    drain, processOne, requeueStuck,
    isBusy: () => running
  };
}

module.exports = { createWorker, PROMPT, ollamaRecognize, parseAi };
