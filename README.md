# dzy-purchase｜廠商貨單拍照建檔

鼎兆元集團內部用：門市拍廠商貨單 → 公司 Mac mini 本機 AI 辨識 → 會計核對入帳 → 食材成本、單價走勢、推進損益系統。

- 後端：Node 24（`node:sqlite`、`node:http`），跑在公司 Mac mini
- 辨識：本機 Ollama 視覺模型，照片與數字不出公司
- 前端：`web/` 純靜態頁面（GitHub Pages）

本 repo 不含任何真實貨單、帳目或金鑰。
