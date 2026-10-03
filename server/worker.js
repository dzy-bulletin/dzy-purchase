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

// 廠商記憶（spec 4.2）：同廠商最近 3 張已入帳貨單的「品名、數量、單位、單價」附在提示詞後，只當參考。
// 沒有廠商或沒有歷史 → 原樣回傳基本提示詞。
const EXAMPLE_SLIPS = 3, EXAMPLE_LINES = 15;
function buildPrompt(db, brandId, vendorId) {
  if (!vendorId) return PROMPT;
  const slips = db.prepare("SELECT id FROM slips WHERE status = 'confirmed' AND vendor_id = ? AND brand_id = ? ORDER BY confirmed_at DESC, id DESC LIMIT ?").all(vendorId, brandId, EXAMPLE_SLIPS);
  const blocks = [];
  for (const s of slips) {
    const ls = db.prepare('SELECT raw_name, qty, unit, unit_price FROM slip_lines WHERE slip_id = ? ORDER BY seq LIMIT ?').all(s.id, EXAMPLE_LINES);
    if (!ls.length) continue;
    blocks.push(`範例 ${blocks.length + 1}：\n` + ls.map((l) => `- ${l.raw_name}｜${l.qty == null ? '' : l.qty}${l.unit || ''}｜單價 ${l.unit_price == null ? '' : l.unit_price}`).join('\n'));
  }
  if (!blocks.length) return PROMPT;
  return `${PROMPT}\n\n這家廠商最近幾張貨單的品項大致長這樣（僅供參考，以照片為準；照片上沒有的品項不要寫）：\n${blocks.join('\n')}`;
}

const MAX_EDGE = 16 * 100;   // 長邊上限（像素）
// 長邊縮到 MAX_EDGE（macOS sips；沒有就用原圖，Ollama 自己也會縮）
// 任何錯誤（檔案不存在、sips 壞掉…）一律 reject，不可在 callback 內丟出未捕捉的同步例外（會讓整個 process 掛掉）
function readOriginal(file) {
  try { return fs.readFileSync(file); }
  catch (e) { throw new Error(e && e.code === 'ENOENT' ? '照片檔不存在' : '照片讀取失敗：' + ((e && e.message) || e)); }
}
function shrink(file) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(file)) throw new Error('照片檔不存在');
      const tmp = path.join(os.tmpdir(), `purchase-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
      execFile('sips', ['-Z', String(MAX_EDGE), file, '--out', tmp], { timeout: 30000 }, (err) => {
        try {
          if (err) return resolve(readOriginal(file));
          let b; try { b = fs.readFileSync(tmp); } catch (e) { return resolve(readOriginal(file)); }
          try { fs.unlinkSync(tmp); } catch (e) { /* 暫存檔清不掉不影響 */ }
          resolve(b);
        } catch (e) { reject(e); }
      });
    } catch (e) { reject(e); }
  });
}

// 預設辨識函式：呼叫 Ollama。回傳模型的原始文字
async function ollamaRecognize(cfg, files, prompt) {
  const images = [];
  for (const f of files) images.push((await shrink(f)).toString('base64'));
  const res = await fetch(`${cfg.OLLAMA_URL}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.MODEL, prompt: prompt || PROMPT, images, stream: false, format: 'json',
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
  const rec = recognize || ((files, slip, prompt) => ollamaRecognize(cfg, files, prompt));
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
      // 先決定廠商（店員選的優先，否則用模型讀到的名稱比對），再用該廠商的品名記憶做後處理
      const aiVendor = String(ai.vendor == null ? '' : ai.vendor).trim();
      let vendorId = cur.vendor_id, vendorRaw = cur.vendor_name_raw;
      if (!vendorId) {
        vendorId = matchVendor(db, slip.brand_id, aiVendor);
        if (!vendorId && !vendorRaw && aiVendor) vendorRaw = aiVendor;
      }
      const r = postprocess(ai, shot, makeCtx(db, slip.brand_id, vendorId, true));
      db.prepare(`UPDATE slips SET status='review', vendor_id=?, vendor_name_raw=?, doc_date=?, doc_no=?, subtotal=?, tax=?, total=?,
                  total_handwritten=?, handwritten_note=?, flags=?, date_note=?, ai_raw=?, ai_model=?, ai_seconds=?, error=NULL WHERE id=?`)
        .run(vendorId, vendorRaw, r.doc_date, r.doc_no, r.subtotal, r.tax, r.total, r.total_handwritten, r.handwritten_note,
             JSON.stringify(r.flags), r.date_note, text, cfg.MODEL, Math.round(seconds * 10) / 10, slip.id);
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
      if (!files.length || files.some((f) => !fs.existsSync(f))) throw new Error('照片檔不存在');   // 重試也不會好，直接標 failed、繼續下一張
      for (let attempt = 1; attempt <= 3; attempt++) {       // 第 1 次＋重試 2 次
        const t0 = Date.now();
        try {
          const text = await rec(files, slip, buildPrompt(db, slip.brand_id, slip.vendor_id));
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
    } catch (e) { lastErr = String((e && e.message) || e) === '照片檔不存在' ? '照片檔不存在' : 'worker: ' + String((e && e.message) || e); }
    markFailed(slip.id, lastErr || 'unknown');
    return true;
  }

  // 所有處理排成一條鏈：不管誰呼叫 drain，同時只會有一張在辨識（32GB 一次只跑一個模型）
  function drain() {
    const p = chain.then(async () => {
      while (!stopped) {
        let more = false;
        try { more = await processOne(); }
        catch (e) { say('[worker] unexpected ' + ((e && e.message) || e)); try { jobLog(db, 'recognize', false, 'unexpected ' + ((e && e.message) || e)); } catch (e2) { /* ignore */ } break; }   // 全域保險：不外溢
        if (!more) break;     // 一次一張
      }
    });
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

module.exports = { createWorker, PROMPT, buildPrompt, ollamaRecognize, parseAi, shrink };
