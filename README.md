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
- 辨識單次逾時 `OLLAMA_TIMEOUT_S`（預設 300 秒，可設小數）。
