# dzy-purchase｜廠商貨單拍照建檔

鼎兆元集團內部用：門市拍廠商貨單 → 公司 Mac mini 本機 AI 辨識 → 會計核對入帳 → 食材成本、單價走勢、推進損益系統。

- 後端：Node 24（`node:sqlite`、`node:http`），跑在公司 Mac mini
- 辨識：本機 Ollama 視覺模型，照片與數字不出公司
- 前端：`web/` 純靜態頁面（GitHub Pages）

本 repo 不含任何真實貨單、帳目或金鑰。

## 行為備註（P1 階段關修正）
- 上傳防重複：同一批照片只產生一次 client_id（`web/upload.html` 的 batchCid），送出鈕處理中 disable；即使連點，後端同 client_id 只會有一筆。
- 數量、單價、金額、總額必須大於 0（P1 不支援退貨負數）；入帳要求總額與每列數量／單價／金額都有值。
- 「退回重拍」的貨單會計不能直接改，需先 `POST /slips/:id/reopen`（保留退回原因、寫 audit）。
- 「辨識失敗」的貨單會計可 `POST /slips/:id/retry`（會計／admin，同品牌，僅 failed 可用）：回到排隊、重試次數歸零、清除錯誤、寫 audit `retry`。
- 會計在核對畫面輸入的日期只收 `YYYY-MM-DD` 與民國 `YYY-MM-DD`／`YYY/MM/DD`，其他回 BAD_INPUT「日期格式看不懂，請重新輸入」；儲存送出的日期視為人工確認，移除 DATE_FIXED。總額規則（**一張單只套一條式子，不是 OR**，前後端共用 `web/js/rules.js` 的 `sumCheck`）：`slips.tax_included=0`（預設）＝各列金額加總＋稅額（空白＝0）＝總額，未稅合計只核對≈各列加總；`tax_included=1`（品項金額已含稅）＝各列金額加總＝總額，且未稅合計與稅額**都有值**時須未稅合計＋稅額＝總額（只填其中一個或都空白時不核對）。細節見下方「品項金額已含稅」。
- 辨識單次逾時 `OLLAMA_TIMEOUT_S`（預設 300 秒，可設小數）。

## 帳號與密碼（首次登入強制改密碼）
帳號由管理者開、密碼由使用者自己設。
- 欄位 `must_change_password`（stores、users；migration v8）。遷移時**既有門市與會計＝1、admin＝0**。`create-accounts.js` 建立或重設門市／會計密碼＝1、admin＝0；管理頁（`POST/PUT /admin/stores|users`）建立帳號或給 `password` 重設＝1（admin 改自己的除外）。
- 登入成功回 `data.must_change_password`。為 `true` 的 session **只能呼叫** `POST /password` 與 `POST /logout`，其他 API 一律回 HTTP 403、錯誤代碼 `PASSWORD_CHANGE_REQUIRED`（「第一次登入請先設定你自己的密碼」）。
- `POST /password`：body `{old_password, new_password}`，**所有角色（含 admin）隨時可用**。新密碼至少 6 字、不可與舊密碼相同、舊密碼要對（皆回 `BAD_INPUT`）。成功：旗標清 0、該帳號**所有** session 作廢、回新的 `{token, expires_at, must_change_password:false}`（前端換掉 token 即可繼續使用）。
- 密碼與雜湊不進 log、不進 audit（audit 只記 `password_change`／`password_changed: true`）。
- 前端四頁（upload／review／reports／admin）：登入後或任一 API 回 `PASSWORD_CHANGE_REQUIRED` 會顯示「第一次登入請設定你自己的密碼」；側欄底部與上傳頁標題列有「改密碼」。

## 品項金額已含稅（migration v9，Eason 2026-10-04）
有些廠商的貨單各列金額已含稅（各列加總＝含稅總額，單上另印未稅合計與稅額）。每張貨單有旗標 `tax_included`（0／1，核對頁稅額旁的勾選框「品項金額已含稅」，勾選即重算、隨 `PUT /slips/:id` 送出；只接受 0／1，其他回 BAD_INPUT）。
- **廠商記憶**：`vendors.tax_included`。入帳時把該單旗標寫回廠商；辨識後處理新單時以廠商的值為預設，會計可改。
- **成本**：兩種都以總額為成本；`tax_included=1` 時稅額**不再分攤**到各類別（類別合計＝總額）。報表、`legacy.xlsx`、損益推送、備份的總額都走 `calc.js`／`slips.total`，結果一致。
- **單價比較一律未稅**：`tax_included=1` 的列，未稅金額＝金額 × (總額−稅額)÷總額（稅額空白或總額 0 → 1:1）；`unit_cost`、加權平均、價格變動提醒都用未稅金額，含稅與未稅廠商同品項不會產生假漲跌。每日明細的 `amount` 仍是單上原始金額。
- **升級**：`git pull` ＋重啟即可，開庫時自動跑 v9（兩個 `ALTER TABLE ADD COLUMN ... DEFAULT 0`，交易內執行，失敗會回滾）；既有貨單與廠商一律 0＝原規則，不改任何既有數字。

## 計算說明（P2）
- 統一單位：只有單位與品項的統一單位**完全相同**時才當 1；單位空白或沒設換算 → 標 `UNIT_UNCONVERTED`，不進加權平均與價格比較，金額照計入成本。
- 價格變動提醒「不回頭重算」：只在入帳當下，與「排在本張之前、最近一筆已入帳」比一次。若較晚日期的貨單先入帳、較早日期的後入帳，先入帳的那張不會被重算，提醒反映的是入帳當下的狀態。
- 稅額「逐張分攤」：每張貨單的稅額依該張各列金額比例分攤回類別（最後一類吃尾差），再把各張加總成月報；不是整月合併後一次分攤。每張的類別合計＝該張總額，月層級與整月一次分攤相比可能差 1 分。
- 廠商記憶進提示詞前會去掉換行與控制字元、反引號、大括號，每個品名截 40 字；核對畫面存的品名一律去頭尾空白。
- 匯出 `legacy.xlsx`：admin 須指定品牌（`brand_id`）或門市（`store_id`），否則回「請選擇品牌」。

## 部署（P4）
Mac mini 部署手冊：`DEPLOY.md`（給 Mac mini 上的 Claude 逐步照做）；Eason 貼給它的開場白：`DEPLOY-prompt.txt`。
- 與電子佈告欄並存：埠 8794、launchd 名稱 `com.dzy.purchase`／`com.dzy.purchase.backup`（範本在 `server/launchd/`）、資料夾 `~/dzy-purchase-data`；Funnel 以路徑 `/purchase` 分流，部署前後都要對照佈告欄 `/health`。
- 工具：`server/tools/create-accounts.js`（建立正式門市／會計／admin，密碼只在終端機輸入）、`server/tools/ollama-bench.js`（用示範照片量辨識秒數，超過 300 秒改 7b）。
- 門市代號：大寫英數 2–10 字（`CF`、`MDGF`、`MZTGF`、`MZTZS`、`MZTLZL`），不再綁品牌字首；登入時不分大小寫。品牌色與 logo 依登入後後端回傳的品牌決定。
- 會計可管多個品牌（`user_brands`）：登入後 session 帶「目前品牌」，`POST /session/brand {brand_id}` 切換（不在清單內回 403），所有依品牌過濾的 API 都用目前品牌；多品牌會計的側欄上方有「目前品牌」切換，單品牌會計看不到。admin 管理頁帳號表單可勾多個品牌。
- `PUT /admin/users/:id`：只給 `brand_id`＝只改預設品牌，**不會縮減**多品牌清單（`brand_id` 不在清單內回 BAD_INPUT）；給 `brand_ids` 才會整份覆蓋。`/health` 的 `model` 是 `.env` 的設定值，不代表 Ollama 已載入該模型（以 `ollama list` 為準）。
- 前端 `web/js/config.js`：本機開頁預設連 `http://localhost:8794`；其他網址連部署的 Funnel 網址（倉庫存佔位字串，部署時依 DEPLOY.md 第 9 步取代，沒取代會顯示「尚未設定伺服器網址」）。`?api=` 覆寫只在本機開頁時生效。

## 部署順序（P3 損益推送）
**必須先部署損益系統（mala-pnl-auto，PR #66 的 `purchasePush` 端點）再上線 Mac mini（本 repo）。**
原因：定稿月遇到新進貨時，本系統靠損益端 LOCKED 回應附帶的 `live`（各科目目前活著的進貨系統列合計）與 `manual`（有活著人工列的科目）判斷要不要亮「進貨金額變動」黃燈、以及待撤回工作能不能直接結案。舊版損益端不回這兩個欄位時，本系統視為 `live` 全 0、`manual` 空，會讓所有定稿月份誤亮黃燈或卡在 locked 終態。

## 示範資料（全部虛構，可放心截圖）
產生一份完全虛構的示範資料（3 品牌 5 間門市、虛構廠商／品項、近 3 個月已入帳貨單、本月待核對各種旗標、辨識失敗／退回／辨識中、價格變動提醒、待補對照、一個已定稿終態黃燈），用來看各畫面有資料時的樣子：

```
DEMO_PASS='自訂密碼' DATA_DIR=spike/demodata node server/dev/demo-seed.js   # 會先整個清空 DATA_DIR 再重建；沒給 DEMO_PASS 就隨機產生並只印在終端機
DATA_DIR=spike/demodata PORT=8794 node server/index.js                      # 用示範資料起伺服器
```
- 帳號：門市 X01 X02 M01 M02 C01、會計 acc-x acc-m acc-c、多品牌會計 acc-cx（央廚＋小辛辣）、管理者 admin，全部共用同一組 `DEMO_PASS`。
- 需要 macOS（照片用內建 `qlmanage`＋`sips` 產生 JPEG）；不呼叫任何外部服務、不需要 Ollama；`DATA_DIR` 路徑必須含 `demo`（防誤刪）。
- 入帳走正式 API，所以廠商記憶、價格變動提醒、成本、損益推送排程都是正式邏輯算出來的。
