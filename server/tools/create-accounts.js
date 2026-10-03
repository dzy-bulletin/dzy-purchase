#!/usr/bin/env node
'use strict';
// 正式帳號建立工具（P4／T23）：在 Mac mini 的「終端機」App 由 Eason 互動執行。
//   node server/tools/create-accounts.js            建立／補齊：5 間門市、2 位會計（會計 A：央廚＋小辛辣；會計 B：墨竹亭）、1 位 admin；
//   會計與 admin 的帳號、姓名一律由執行者當場輸入（程式與手冊不寫死任何真名）
//   node server/tools/create-accounts.js --list     只列出目前狀態（不問密碼、不改任何東西）
//   node server/tools/create-accounts.js --only stores|accountants|admin   只做其中一類
// 密碼只在終端機輸入（不回顯、要輸入兩次），不寫檔、不印出、不進任何 log；Claude 不執行這支工具（密碼不經過 Claude）。
// 冪等：帳號已存在 → 預設跳過；問「要重設密碼嗎？」答 y 才會重設。門市損益代號請在管理頁「門市」設定。
const { loadConfig } = require('../config');
const { openDb, audit } = require('../db');
const { hashPassword } = require('../auth');

const BRANDS = [['X', '小辛辣'], ['M', '墨竹亭'], ['C', '央廚']];
// [代號, 品牌, 名稱]
const STORES = [
  ['CF', 'C', '中央廚房'],
  ['MDGF', 'X', '麻的小辛辣新竹光復'],
  ['MZTGF', 'M', '墨竹亭新竹光復'],
  ['MZTZS', 'M', '墨竹亭新竹金山'],
  ['MZTLZL', 'M', '墨竹亭台北六張犁']
];
// [角色代稱, 說明, 品牌（第一個＝預設品牌）]；帳號與姓名部署時輸入
const ACCOUNTANTS = [
  ['會計 A', '品牌：中央廚房＋小辛辣', ['C', 'X']],
  ['會計 B', '品牌：墨竹亭', ['M']]
];
const ADMIN = ['管理者', '系統管理者', []];
const MIN_PW = 6;
const USERNAME = /^[A-Za-z0-9._-]{3,40}$/;
const WHO = 'tool:create-accounts';

// 取得密碼（輸入兩次）。ask＝讀一般文字，askHidden＝讀不回顯文字（由呼叫端提供，測試時可注入）
async function askPassword(io, label) {
  for (;;) {
    const a = await io.askHidden(`  ${label} 密碼（至少 ${MIN_PW} 字元，輸入時不會顯示）：`);
    if (a.length < MIN_PW) { io.out(`  ✗ 至少 ${MIN_PW} 個字元，請重打`); continue; }
    const b = await io.askHidden('  再輸入一次確認：');
    if (a !== b) { io.out('  ✗ 兩次不一樣，請重打'); continue; }
    return a;
  }
}
const yes = async (io, q) => /^y(es)?$/i.test((await io.ask(q + ' (y/N) ')).trim());

async function run(db, io, opts) {
  opts = opts || {};
  const only = opts.only || 'all';
  const sum = { created: [], reset: [], skipped: [], brandsFixed: [] };
  if (!opts.list) db.tx(() => { for (const [id, name] of BRANDS) db.prepare('INSERT OR IGNORE INTO brands (id, name) VALUES (?,?)').run(id, name); });   // --list 完全唯讀

  if (opts.list) {
    io.out('門市：');
    for (const [code, brand, name] of STORES) { const r = db.prepare('SELECT active, pnl_unit_code FROM stores WHERE code = ?').get(code); io.out(`  ${code}\t${name}\t品牌 ${brand}\t${r ? (r.active ? '已建立' : '已停用') + (r.pnl_unit_code ? '' : '（未設損益代號）') : '尚未建立'}`); }
    io.out('帳號：');
    const users = db.prepare('SELECT id, username, role, active FROM users ORDER BY role, username').all();
    const accs = users.filter((r) => r.role === 'accountant'); const adm = users.filter((r) => r.role === 'admin');
    const bsOf = (r) => db.prepare('SELECT brand_id FROM user_brands WHERE user_id = ? ORDER BY brand_id').all(r.id).map((x) => x.brand_id).join('＋');
    io.out(`  會計 ${accs.length} 位（期望 ${ACCOUNTANTS.length}）：` + (accs.map((r) => `${r.username}（品牌 ${bsOf(r)}${r.active ? '' : '，已停用'}）`).join('、') || '尚未建立'));
    io.out(`  管理者 ${adm.length} 位（期望 1）：` + (adm.map((r) => r.username + (r.active ? '' : '（已停用）')).join('、') || '尚未建立'));
    return sum;
  }

  if (only === 'all' || only === 'stores') {
    io.out('\n== 門市');
    for (const [code, brand, name] of STORES) {
      const ex = db.prepare('SELECT id FROM stores WHERE code = ?').get(code);
      if (!ex && db.prepare('SELECT 1 FROM users WHERE UPPER(username) = ?').get(code)) { io.out(`✗ 門市代號 ${code} 與既有帳號名稱相同，略過（請到管理頁處理）`); sum.skipped.push(code); continue; }
      if (!ex) {
        io.out(`${code}（${name}，品牌 ${brand}）尚未建立`);
        const pw = await askPassword(io, code);
        db.tx(() => {
          db.prepare('INSERT INTO stores (brand_id, code, name, pass_hash, active) VALUES (?,?,?,?,1)').run(brand, code, name, hashPassword(pw));
          audit(db, WHO, 'admin_store_create', null, null, { code, name, brand_id: brand });
        });
        sum.created.push(code); io.out(`  ✓ 已建立 ${code}`);
      } else if (await yes(io, `${code} 已存在，要重設密碼嗎？`)) {
        const pw = await askPassword(io, code);
        db.tx(() => {
          db.prepare('UPDATE stores SET pass_hash = ?, fail_count = 0, locked_until = NULL WHERE id = ?').run(hashPassword(pw), ex.id);
          db.prepare('DELETE FROM sessions WHERE who = ?').run(`store:${ex.id}`);
          audit(db, WHO, 'admin_store_update', null, null, { code, password_changed: true });
        });
        sum.reset.push(code); io.out(`  ✓ 已重設 ${code} 的密碼`);
      } else { sum.skipped.push(code); io.out(`  － 略過 ${code}`); }
    }
  }

  const people = [];
  if (only === 'all' || only === 'accountants') ACCOUNTANTS.forEach((a) => people.push({ role: 'accountant', label: a[0], note: a[1], brands: a[2] }));
  if (only === 'all' || only === 'admin') people.push({ role: 'admin', label: ADMIN[0], note: ADMIN[1], brands: [] });
  if (people.length) io.out('\n== 會計與管理者');
  for (const p of people) {
    io.out(`${p.label}（${p.note}${p.brands.length ? '，' + p.brands.join('＋') : ''}）`);
    const username = (await io.ask('  帳號（英數 . _ -，3–40 字；必填，留空＝略過這一位）：')).trim();
    if (!username) { io.out('  － 略過'); sum.skipped.push(p.label); continue; }
    if (!USERNAME.test(username)) { io.out('  ✗ 帳號格式不對，略過這一位（請重跑工具）'); sum.skipped.push(username); continue; }
    if (db.prepare('SELECT 1 FROM stores WHERE code = ?').get(username.toUpperCase())) { io.out('  ✗ 帳號不可與門市代號相同，略過'); sum.skipped.push(username); continue; }
    const ex = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);
    if (ex && ex.role !== p.role) { io.out(`  ✗ ${username} 已存在但角色不同（${ex.role}），略過；請到管理頁處理`); sum.skipped.push(username); continue; }
    let uid;
    if (!ex) {
      const dname = (await io.ask('  姓名（必填）：')).trim();
      if (!dname) { io.out('  ✗ 姓名不可空白，略過這一位（請重跑工具）'); sum.skipped.push(username); continue; }
      const pw = await askPassword(io, username);
      db.tx(() => {
        uid = Number(db.prepare('INSERT INTO users (username, role, brand_id, name, pass_hash, active) VALUES (?,?,?,?,?,1)')
          .run(username, p.role, p.brands[0] || null, dname, hashPassword(pw)).lastInsertRowid);
        p.brands.forEach((b) => db.prepare('INSERT INTO user_brands (user_id, brand_id) VALUES (?,?)').run(uid, b));
        audit(db, WHO, 'admin_user_create', null, null, { username, name: dname, role: p.role, brand_ids: p.brands });
      });
      sum.created.push(username); io.out(`  ✓ 已建立 ${username}`);
    } else {
      uid = ex.id;
      if (await yes(io, `  ${username} 已存在，要重設密碼嗎？`)) {
        const pw = await askPassword(io, username);
        db.tx(() => {
          db.prepare('UPDATE users SET pass_hash = ?, fail_count = 0, locked_until = NULL WHERE id = ?').run(hashPassword(pw), uid);
          db.prepare('DELETE FROM sessions WHERE who = ?').run(`user:${uid}`);
          audit(db, WHO, 'admin_user_update', null, null, { username, password_changed: true });
        });
        sum.reset.push(username); io.out(`  ✓ 已重設 ${username} 的密碼`);
      } else { sum.skipped.push(username); io.out(`  － 略過 ${username} 的密碼`); }
    }
    if (p.role === 'accountant') {                                    // 品牌權限補齊到契約的清單（只補不減）
      const have = db.prepare('SELECT brand_id FROM user_brands WHERE user_id = ?').all(uid).map((x) => x.brand_id);
      const miss = p.brands.filter((b) => !have.includes(b));
      if (miss.length) {
        db.tx(() => { miss.forEach((b) => db.prepare('INSERT INTO user_brands (user_id, brand_id) VALUES (?,?)').run(uid, b)); audit(db, WHO, 'admin_user_update', null, null, { username, brand_ids_added: miss }); });
        sum.brandsFixed.push(`${username}+${miss.join('')}`); io.out(`  ✓ 已補上品牌權限 ${miss.join('、')}`);
      }
    }
  }
  io.out(`\n完成：新建 ${sum.created.length}、重設密碼 ${sum.reset.length}、略過 ${sum.skipped.length}${sum.brandsFixed.length ? '、補品牌 ' + sum.brandsFixed.length : ''}。密碼沒有存到任何地方。`);
  return sum;
}

// ---- 終端機輸入：不用 readline（它會自己回顯）；stdin 全程 raw mode，自己逐字讀、自己決定要不要回顯 ----
function makeTtyIo() {
  const stdin = process.stdin;
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  let queue = []; let waiter = null;
  stdin.on('data', (d) => { for (const c of d) queue.push(c); if (waiter) { const w = waiter; waiter = null; w(); } });
  const nextChar = async () => { while (!queue.length) await new Promise((r) => { waiter = r; }); return queue.shift(); };
  let skipLF = false;   // \r\n 算一次 Enter：\r 之後緊接的 \n 丟掉
  const cancel = () => { try { stdin.setRawMode(false); } catch (e) { /* ignore */ } process.stdout.write('\n已中止\n'); process.exit(130); };
  const readLine = async (q, echo) => {
    process.stdout.write(q);
    let buf = '';
    for (;;) {
      const c = await nextChar();
      if (c === '\n' && skipLF) { skipLF = false; continue; }
      skipLF = false;
      if (c === '\r' || c === '\n') { skipLF = c === '\r'; process.stdout.write('\n'); return buf; }
      if (c === '\u0003') cancel();
      if (c === '\u0004') { if (!buf) cancel(); continue; }   // Ctrl-D：空輸入＝取消，有字就忽略
      if (c === '\u001b') {   // 方向鍵等 ESC 序列整段忽略（ESC [ … 結尾字母／ESC O x）
        if (queue.length && (queue[0] === '[' || queue[0] === 'O')) {
          const intro = queue.shift();
          if (intro === 'O') { if (queue.length) queue.shift(); }
          else while (queue.length) { const f = queue.shift(); if (f >= '@' && f <= '~') break; }
        }
        continue;
      }
      if (c === '\u007f' || c === '\b') { if (buf.length) { buf = buf.slice(0, -1); if (echo) process.stdout.write('\b \b'); } continue; }
      if (c >= ' ') { buf += c; if (echo) process.stdout.write(c); }
    }
  };
  return { ask: (q) => readLine(q, true), askHidden: (q) => readLine(q, false), out: (s) => console.log(s), close: () => { try { stdin.setRawMode(false); } catch (e) { /* ignore */ } stdin.pause(); } };
}

if (require.main === module) {
  const major = parseInt(process.versions.node, 10);
  if (major < 24) { console.error(`需要 Node 24 以上，目前是 v${process.versions.node}`); process.exit(1); }
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const oi = args.indexOf('--only'); const only = oi >= 0 ? args[oi + 1] : 'all';
  if (!['all', 'stores', 'accountants', 'admin'].includes(only)) { console.error('--only 只能是 stores／accountants／admin'); process.exit(2); }
  if (!list && !(process.stdin.isTTY && process.stdout.isTTY)) { console.error('請在「終端機」App 直接執行（需要互動輸入密碼）；不要用管線或在 Claude 的工具裡跑。'); process.exit(2); }
  const cfg = loadConfig();
  console.log(`資料夾：${cfg.DATA_DIR}`);
  const db = openDb(cfg.DATA_DIR);
  const io = list ? { ask: async () => '', askHidden: async () => '', out: (s) => console.log(s) } : makeTtyIo();
  run(db, io, { only, list }).then(() => { if (io.close) io.close(); db.close(); process.exit(0); })
    .catch((e) => { console.error('失敗：' + (e && e.message)); process.exit(1); });
}
module.exports = { run, STORES, ACCOUNTANTS };
