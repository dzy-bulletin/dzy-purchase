'use strict';
// 測試初始化：在全新 DATA_DIR 建 DB、三個品牌、一個 admin（密碼由環境變數 E2E_ADMIN_PW 給）。其餘一律走 API。
const { openDb } = require('../server/db');
const { hashPassword } = require('../server/auth');
const db = openDb(process.env.DATA_DIR);
for (const [id, n] of [['X', '小辛辣'], ['M', '墨竹亭'], ['C', '央廚']]) db.prepare('INSERT OR IGNORE INTO brands (id, name) VALUES (?,?)').run(id, n);
db.prepare("INSERT INTO users (username, role, brand_id, name, pass_hash) VALUES (?, 'admin', NULL, ?, ?)").run(process.env.E2E_ADMIN_USER, '測試管理者', hashPassword(process.env.E2E_ADMIN_PW));
db.close();
