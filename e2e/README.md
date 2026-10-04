# 貨單辨識系統 資料帶入測試（e2e）

把一整套隨機資料帶進系統實跑一遍：門市拍照上傳 → 假 AI 辨識（刻意注入各種錯）→ 會計逐張核對入帳 →
報表／Excel／損益推送／備份，每個數字都用測試自己的獨立算式驗，每顆按鈕都稽核點過。規則見 skill `data-drive-test`。

## 跑法

```bash
cd e2e && python3 run.py              # 約 8～10 分鐘，不需要網路
E2E_SEED=12345 python3 run.py          # 重現某一次的資料（失敗時會印出種子）
```

結尾印「共 N 項檢查，通過 N，失敗 0」與按鈕稽核數字（掃到／驗證／漏測）。有失敗時結束碼為 1。

### 第一次安裝
- Node 24 以上（`node --version`）、`npm ci`（專案根目錄，系統本身的相依套件）。
- Python 3.10+ 與 Playwright：`pip3 install playwright && python3 -m playwright install chromium`
- 讀 Excel 用 openpyxl。系統 Python 受 PEP 668 保護時用專案內的虛擬環境（已加進 .gitignore）：
  `python3 -m venv --system-site-packages e2e/.venv && e2e/.venv/bin/pip install openpyxl`
  （`run.py` 偵測到沒有 openpyxl 且存在 `e2e/.venv` 會自動改用它重新啟動。）
- 照片用 macOS 內建的 `sips` 轉 JPEG，所以只能在 macOS 跑（伺服器的辨識工人本來也用 sips）。

## 架構
- **真後端**：每次在 `/private/tmp/purchase-e2e-*` 建全新 DATA_DIR，`node server/index.js` 自選空埠；
  `bootstrap.js` 只建品牌與 admin，其餘（門市、會計、廠商、品項、單位換算）全走 admin API。密碼每次隨機。
- **前端**：`python3 -m http.server -d web`（不印存取紀錄）。側欄連結不帶 `?api=`，所以用 Playwright route
  改寫 `js/config.js` 的預設後端位址指向測試後端；其他外部網址（Google Fonts）一律擋掉。`web/`、`server/` 原檔不動。
- **假 Ollama**（`fake_ollama.py`）：用「照片寬高比」認出是哪張貨單（伺服器的 `sips -Z 1600` 會等比放大，尺寸本身會變），
  回傳該張的辨識 JSON（值全是字串）。指定的貨單前 3 次回 500 → 辨識失敗，之後「重新辨識」才成功。
- **假損益端／假備份端**（`fake_ext.py`）：記下收到的 payload，用獨立算式驗；損益端可指定某店×月先回 LOCKED 一次。
- 照片（`photos.py`）：測試即時產生的虛構圖，不讀 spike 任何檔案。

## 檔案
| 檔案 | 內容 |
|---|---|
| `run.py` | 主流程（Playwright）與所有檢查 |
| `dataset.py` | 隨機資料（品牌／門市／會計／廠商／品項／換算／貨單／價格走勢／注入的錯）＋獨立算式 `Model`（成本、加權平均、漲跌提醒、legacy.xlsx、損益推送） |
| `fake_ollama.py` `fake_ext.py` `photos.py` `bootstrap.js` | 假外部服務與初始化 |
| `clickmap.py` | 按鈕與連結覆蓋稽核（複製自 mala-clock-in，key 規則補了：側欄連結用 data-key、建議鈕固定 key、輸入用 data-k） |
| `common.py` | 檢查登記、API 小工具、對話框處理 |
| `artifacts/` | 存證截圖（不進版控） |

## 每次隨機抽的東西
三品牌（順序隨機）各 1～3 家門市；兩位會計（一位多品牌、一位單品牌）＋ admin；每品牌 4～8 家廠商（含稅／未稅／無稅單）、
6～9 個統一品名與單位換算；每家使用中的廠商 2～4 張貨單、日期分散在 3 個月；價格有漲有跌；
每種錯至少出現一次：漏零、數量×單價不符、缺單價、民國年／兩位數年／讀不出日期／年份錯一年、手寫修改（保留與清除）、
含稅單、手打的未知廠商、未對照品名、AI 多讀「合計」「稅額」列、AI 漏讀一列、總額讀錯、全形空白品名、運費列、
辨識失敗、退回重拍、取消入帳再入帳。

## 預期值怎麼來
`dataset.py` 照 `docs/plan.md` 規格重寫：不 import `server/calc.js`、`web/js/rules.js`。
JS 的 `Math.round` 是 .5 進位，Python `round` 是銀行家捨入，所以全部用 `floor(x+0.5)`；`toFixed` 也用 Decimal 重做。
逐筆比對內容與排序（不只筆數）。

## 失敗時
- 先看印出的種子，用 `E2E_SEED` 重現；截圖在 `artifacts/`。
- 測試本身的錯自己修；系統真的錯不要在這裡改 `server/`、`web/`，另行處理。
