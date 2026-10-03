# 進貨金額備份 — Apps Script 橋接（T19）

Mac mini 的 `server/backup.js` 每天把「本月＋上月」已入帳的貨單與明細（只有文字與數字）POST 到這支 Apps Script，
它整頁覆蓋寫進試算表「鼎兆元｜進貨金額備份」（一個月一個分頁）。試算表是**副本**：手動改不會回寫，下次備份會蓋回去。

## 部署步驟（Eason 在 madesiaosinla 帳號下做；Claude 不執行 clasp create／push／deploy）
1. 到 script.google.com 以 **madesiaosinla** 帳號建立新專案，名稱「鼎兆元｜進貨金額備份」。
2. 專案設定 → 勾「在編輯器中顯示 appsscript.json」。
3. 把本資料夾的 `Code.js` 貼進 `Code.gs`（或改名 Code.js）、`appsscript.json` 內容貼進 appsscript.json（時區 Asia/Taipei、權限只要試算表）。
   （要用 clasp 也可以：你自己在這個資料夾 `clasp create --type standalone`、`clasp push`——這一步由你執行。）
4. 在編輯器選函式 **`setup`** → 執行 → 同意授權（試算表）。它會建立備份用試算表，把 ID 存進指令碼屬性 `SHEET_ID`；重複執行不會再建第二份。
   到「執行記錄」會看到試算表連結——**不要分享給任何人**。
5. 專案設定 → 指令碼屬性 → 新增 `BACKUP_KEY`＝一串長的隨機字串（自己產生，Claude 不經手）。**沒設＝所有請求一律被拒絕。**
6. 部署 → 新增部署 → 類型「網頁應用程式」→ 執行身分「我」、存取權「所有人」→ 部署，複製網址（`…/exec`）。
7. 在 Mac mini 的 `.env`（不進版控）加：
   ```
   BACKUP_URL=<上面的 /exec 網址>
   BACKUP_KEY=<同一串金鑰>
   ```
8. 手動測：`cd ~/mala-purchase && node server/backup.js`，成功會印「備份完成」並寫 `logs/backup-last.json`；打開試算表應看到 `YYYY-MM` 分頁。再跑一次，內容不變、分頁數不增加。
9. 抽查：某筆品名若以 `=` 開頭，試算表裡應顯示為純文字、不是公式；進貨日期顯示 `2026-10-01` 文字、不是日期型別。

## 安全
- 金鑰比對等長逐字元；10 分鐘錯 20 次鎖 10 分鐘。
- 只收固定欄位（見 `Code.js` 的 `SLIP_COLS_`／`LINE_COLS_`），其他欄位一律忽略；布林、物件、陣列一律拒絕整份。
- 不要把 `BACKUP_KEY` 寫進任何檔案或貼進對話。
