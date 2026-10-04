# 鼎兆元｜廠商貨單拍照建檔 — Mac mini 部署手冊（P4／T22）

給 **Mac mini 上的 Claude** 從頭照做。做完＝伺服器在 Mac mini 常駐（埠 8794）、辨識模型在本機 Ollama、停電重開不碰鍵盤自己恢復、
手機用 4G 經 Tailscale Funnel 的 **`/purchase` 路徑**打得到 `/purchase/api/health`，而且**電子佈告欄（埠 8793，Funnel 根路徑 `/`）完全不受影響**。

本手冊照電子佈告欄搬到 Mac mini 的做法（`~/dzy-bulletin/server/DEPLOY.md`）；定案沿用：Node 24 裝在 `~/.local/node`、`.env` 不得打開、LaunchAgent（或佈告欄實機走的 LaunchDaemon，見第 0 步判斷）、FileVault／自動登入依佈告欄現況。
**本手冊只部署、不處理資料**：新系統是空資料庫；損益推送（`PNL_PUSH_URL`）部署當天**不開**，等 T23 前置設定完成後才開（第 10 步）。

---

## ⛔ 最前面：禁令（違反任一條＝部署失敗，要請 Eason 換金鑰）

`server/.env` 裝著 `BACKUP_KEY`、`PNL_PURCHASE_KEY`（以及兩個 Apps Script 網址）。Mac mini 的 Claude：

1. **不** `cat`／`less`／`head`／`tail`／`open`／`echo`／`Read` 這個檔，也不用任何工具「看一下內容」。
2. **不** 執行會把環境變數全印出來的指令：`env`、`printenv`、`set`、`export -p`、`launchctl getenv …`、`ps eww`。
3. **不** 把 `.env` 的內容或片段貼進對話、issue、留言、commit、檔案。
4. **不** 自己產生、也不經手任何金鑰與**任何帳號密碼**（門市密碼、會計密碼、admin 密碼）：一律由 Eason 在**他自己開的「終端機」App 視窗**裡輸入（建立工具 `server/tools/create-accounts.js` 讓他輸入，不回顯、不寫檔）。**Claude 不執行這支工具**（唯讀的 `--list` 除外，它不問也不印密碼）。
5. 要確認 `.env` 格式，只准用「回傳數字」的指令（例如 `grep -c '^MODEL=.' "$REPO/server/.env"`）。**時序規則（前後一致）：第 7 步 B2 的 Read 禁止規則生效之前（第 2、3 步），Claude 可以跑這種回傳數字的 grep；B2 生效之後，一律由 Eason 在終端機執行、回報數字。**（B2 只擋 Read／Edit 工具，擋不到 Bash；所以 B2 之後 Claude 仍只靠自己的紀律，不要用 Bash 去讀 `.env`。）
6. `.env` 不進 git（`.gitignore` 已列 `.env`），權限 `600`。
7. **不碰佈告欄**：不修改 `~/dzy-bulletin`、`~/dzy-bulletin-data`、`com.dzy.bulletin*` 任何 job、佈告欄的 `server/.env`、埠 8793；Funnel 根路徑 `/` 的設定一個字都不動（第 6 步只**新增** `/purchase` 這一條）。
8. **Funnel 網址只允許出現在 `web/js/config.js`**（第 9 步，由 Eason 在 MacBook 上填；Eason 已定案：佈告欄公開的 config.js 已含同一主機名，不增加曝光）。**其他任何檔案、issue、commit 訊息、證據檔、對話回報**都不得出現完整網址（對話中只在第 6 步當下交給 Eason）。

---

## 手冊約定

- 所有路徑都從 `$HOME` 推導，手冊裡沒有任何人的帳號名稱。程式在 `$HOME/dzy-purchase`、資料在 `$HOME/dzy-purchase-data`（**不要**放在桌面／文件／下載底下，macOS 會擋背景程式讀）。
- `TS`＝Tailscale CLI：有官方 App 就用 App 裡的，沒有就用 `command -v tailscale`（佈告欄走附錄 A 時是 Homebrew 的）。**沿用佈告欄那一個，不另裝、不換**。
- 兩個服務並存：佈告欄 `8793`（`BPORT`）、本系統 `8794`（`PORT`）；launchd 名稱、資料夾、`.env` 全部分開。
- **每段指令前都要先貼這一行**（每次 Bash 呼叫是新的 shell，變數不會留著；`export PATH` 讓子程序也用 `~/.local/node` 的 Node 24）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale ); U="gui/$(id -u)"; PORT=8794; BPORT=8793
```

- 「**佈告欄基準**」＝**五個值**。部署前（第 0 步）、第 6 步改完、第 8 步結束後都要印、都要完全一致，**不一致就照第 6 步回退**。前四個是 `/health` 的 `ok／e2e／bridge／level`；**第五個是對外入口**：`funnel status` 主機那行有 `(Funnel on)`，且 443 的根路徑 `/` 指向 8793（光看本機 8793 測不到 Funnel 被關掉，所以一定要有第五值）：

```sh
curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("ok","e2e","bridge","level")})'
F=$("$TS" funnel status 2>&1); echo "funnel_on=$(echo "$F" | grep -c '(Funnel on)') root_8793=$(echo "$F" | grep -cE '^\|-- +/ +proxy +http://(127\.0\.0\.1|localhost):8793$')"      # 第五值，期望 funnel_on=1 root_8793=1（**以實際 `tailscale funnel status` 輸出為準**：第 0 步若看不到形如 `|-- / proxy http://127.0.0.1:8793` 的一行、致使 `root_8793` 不是 1，**停下來把輸出（網址已遮蔽）貼給 Eason**，不要自己改判讀式；判讀式定案後，三次逐字比對）
```

- Eason 要親手做的事有**三批**：**第 7 步（第一批：帳號、備份金鑰）**、**第 9 步（第二批：MacBook 填前端網址並發佈）**、**第 8 步（第三批：手機實測）**。Claude 做到那裡就**停下來**，把整批清單貼給 Eason，等他說「做完了」再繼續。其他步驟 Claude 自己做、不需要 sudo（走 LaunchDaemon 路線時，第 5 步、第 7 步有幾行 sudo 也交給 Eason）。
- 背景程序一律寫成「單一指令加 `&`、下一行 `echo $! > pid 檔`」；只關自己記下的那個 PID。等伺服器起來用 `curl --retry … --retry-connrefused`，不用 `sleep`。
- **驗收要用的數據一律落檔**：寫進 `$DATA/logs/deploy-evidence.txt`（環境、佈告欄基準、模型秒數、`/health`…）。這個檔**不可含金鑰、網址、tailnet 名稱**；回報時從這個檔讀。
- 中途要關掉 Claude 或重開機時，請 Eason 回來後在**同一個資料夾**打 `claude --continue` 接回對話，再說「繼續照 DEPLOY.md 第 N 步」；接回後 Claude 先 `cat "$HOME/dzy-purchase-data/logs/deploy-evidence.txt"`（這個檔可以印）確認做到哪裡。

---

## 第 0 步：查現況並回報（只讀；唯一例外是建立自己的 `$DATA/logs` 與證據檔）

（repo 應該已經 clone 在 `~/dzy-purchase`；第一次跑 git 跳出「安裝命令列開發者工具」的視窗，Eason 應已按過安裝。）

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale ); U="gui/$(id -u)"; PORT=8794; BPORT=8793
echo "== 使用者"; whoami; echo "HOME=$HOME uid=$(id -u) shell=$SHELL"
echo "== FileVault"; fdesetup status
echo "== 晶片／macOS／記憶體"; uname -m; sw_vers -productVersion; echo "RAM $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
echo "== 時區"; date; readlink /etc/localtime
echo "== 磁碟"; df -h "$HOME" | tail -1
echo "== Tailscale"; "$TS" version | head -1; "$TS" status | head -3
echo "== Node"; "$NODE" -v 2>/dev/null || echo "（~/.local/node 尚未安裝）"
echo "== git／repo"; git --version | head -1; git -C "$REPO" log --oneline -1 2>/dev/null && git -C "$REPO" branch --show-current || echo "（尚未 clone）"
echo "== Ollama"; command -v ollama && ollama --version 2>&1 | head -1; ls -d /Applications/Ollama.app 2>/dev/null; curl -s --max-time 3 http://127.0.0.1:11434/api/tags | python3 -c 'import json,sys; print("Ollama 在跑，已有模型：", [m["name"] for m in json.load(sys.stdin)["models"]])' 2>/dev/null || echo "（Ollama 沒有在跑或沒裝）"
echo "== 埠 $PORT／$BPORT"; lsof -nP -iTCP:$PORT -sTCP:LISTEN || echo "（$PORT 沒人在聽，正常）"; lsof -nP -iTCP:$BPORT -sTCP:LISTEN | head -2
echo "== 佈告欄 job"; ls ~/Library/LaunchAgents/com.dzy.bulletin* /Library/LaunchDaemons/com.dzy.bulletin* 2>/dev/null
echo "== 本系統既有 job／資料"; ls ~/Library/LaunchAgents/com.dzy.purchase* /Library/LaunchDaemons/com.dzy.purchase* 2>/dev/null || echo "（無）"; ls -d "$DATA" 2>/dev/null || echo "（無 $DATA）"
echo "== 佈告欄基準 /health"; curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("ok","e2e","bridge","level")})'
echo "== Funnel／Serve 現況（網址已遮蔽）"; "$TS" funnel status 2>&1 | sed -E 's#https?://[^ /]+#https://<HOST>#g'; "$TS" serve status 2>&1 | sed -E 's#https?://[^ /]+#https://<HOST>#g'
F=$("$TS" funnel status 2>&1); echo "== 佈告欄基準第五值"; echo "funnel_on=$(echo "$F" | grep -c '(Funnel on)') root_8793=$(echo "$F" | grep -cE '^\|-- +/ +proxy +http://(127\.0\.0\.1|localhost):8793$')"
echo "== Tailscale 版本與 CLI 說明（唯讀，第 6 步的依據）"; "$TS" version 2>&1 | head -3
"$TS" funnel --help 2>&1 | head -40; echo ----; "$TS" serve --help 2>&1 | head -40
echo "== --set-path／--yes 有沒有"; for c in funnel serve; do echo "$c: set-path=$("$TS" $c --help 2>&1 | grep -c -- '--set-path') yes=$("$TS" $c --help 2>&1 | grep -c -- '--yes')"; done
```

**第 6 步的前置確認（必做）**：把上面印出的 `tailscale version`、`funnel --help`／`serve --help` 的輸出（網址已遮蔽）**貼回給 Eason，等他確認「可以做第 6 步」才進第 6 步**。要看的是：(a) `funnel` 子命令有 `--set-path`（沒有＝這個版本不支援路徑分流，**停**）；(b) 有沒有 `--yes`（決定回退指令能不能由 Claude 執行，見第 6 步）。

判讀與回報（把下表填好貼給 Eason，**然後停下來等他確認**）：

| 項目 | 期望 | 不符時 |
|---|---|---|
| 磁碟 | `$HOME` 所在磁碟可用 **≥ 40 GB**（32B 模型約 21 GB，另留空間給照片與備份） | 不足：**停**，回報 Eason |
| 記憶體 | ≥ 32 GB 較適合跑 32B；**< 24 GB 載不進 32B** | **< 24 GB：第 3 步直接用 7b、不下載 32b，並回報 Eason**；24～31 GB：照第 3 步量秒數，多半超時改 7b，不是錯誤 |
| FileVault／佈告欄 job | 依佈告欄：**佈告欄 job 在 `~/Library/LaunchAgents/`＝路線 A（LaunchAgent）**；**在 `/Library/LaunchDaemons/`＝路線 D（LaunchDaemon，佈告欄實機走這條）** | **本系統跟佈告欄走同一條路線**，記下 A 或 D，第 5 步照選；兩邊都沒有佈告欄 job：**停**，回報 |
| Tailscale | 已連線、是佈告欄在用的那一個 | `Logged out`：**停**，請 Eason 處理 |
| Node | `~/.local/node` 已是 v24.x（佈告欄裝的）→ 第 1 步直接沿用 | 沒有：第 1 步安裝 |
| Ollama | 沒裝或已裝皆可 | 已有別的模型沒關係；`Ollama 在跑` 但沒有 qwen 也正常，第 3 步處理 |
| 埠 8794 | 沒人在聽 | 有人在聽：查是誰（`lsof` 會列出程序），**停**，請 Eason 決定 |
| 埠 8793／佈告欄基準 | 有人在聽；基準四值印得出來、`ok` 為 `True` | **不是 True：停**。佈告欄本來就壞的話，不能在這個狀態上動 Funnel，先回報 Eason |
| Funnel／Serve 現況 | 只有一條 `/ → proxy http://127.0.0.1:8793`（根路徑）、有 `(Funnel on)`；第五值 `funnel_on=1 root_8793=1` | 已經有 `/purchase`：**停**，回報（可能做過一半）；有別的條目：**停**，回報 |
| 本系統既有 job／`$DATA` | 無 | 有的話**停**，不要覆蓋，回報 Eason |

把基準與 Funnel 現況存進證據檔與回退參考檔（**網址已遮蔽；不含金鑰**）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
mkdir -p "$DATA/logs" && chmod 700 "$DATA"
{ echo "== 進貨系統部署證據（不含金鑰、網址）"
  echo "環境：macOS $(sw_vers -productVersion)／$(uname -m)／RAM $(( $(sysctl -n hw.memsize) / 1073741824 )) GB／建立 $(date '+%F %T %Z')"
  echo "路線：<A 或 D，照上表填>"
  echo "第 0 步 佈告欄基準：$(curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("ok","e2e","bridge","level")})')／$(F=$("$TS" funnel status 2>&1); echo "funnel_on=$(echo "$F" | grep -c '(Funnel on)') root_8793=$(echo "$F" | grep -cE '^\|-- +/ +proxy +http://(127\.0\.0\.1|localhost):8793$')")"
} >> "$DATA/logs/deploy-evidence.txt"
{ "$TS" funnel status 2>&1; echo ---; "$TS" serve status 2>&1; } | sed -E 's#https?://[^ /]+#https://<HOST>#g' > "$DATA/logs/funnel-before.txt"
cat "$DATA/logs/funnel-before.txt"
```

---

## 第 1 步：Node（沿用佈告欄的 `~/.local/node`，已有就不重裝）

```sh
export PATH="$HOME/.local/node/bin:$PATH"; NODE="$HOME/.local/node/bin/node"
"$NODE" -v && "$NODE" -e "require('node:sqlite'); console.log('node:sqlite OK')" && ls "$HOME/.local/node/bin/npm"
```

- 期望 `v24.x.y`、`node:sqlite OK`、印出 npm 路徑 → **這一步結束**（**不要升級、不要換捷徑**：佈告欄共用這個 Node，小版升級由 Eason 另外決定）。
- 任一項失敗（`~/.local/node` 不存在或不是 24）：照 `~/dzy-bulletin/server/DEPLOY.md` 第 1 步安裝（官方 tar.gz 解到 `~/.local`、SHA256 核對、`ln -sfn` 捷徑；只能用 Node.js 官方網站，不用鏡像站），做完重跑上面三項。
- **不要用 Homebrew 的 `node`**（會自己升大版；`node:sqlite` 還在演進）。

---

## 第 2 步：程式、資料夾與 `.env` 骨架（Claude 做）

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"
if [ -d "$REPO/.git" ]; then git -C "$REPO" fetch -q origin && git -C "$REPO" checkout -q main && git -C "$REPO" pull -q --ff-only; else git clone -q https://github.com/dzy-bulletin/dzy-purchase.git "$REPO"; fi
git -C "$REPO" log --oneline -1; test -f "$REPO/DEPLOY.md" && echo "DEPLOY.md 在"
cd "$REPO" && npm ci --omit=dev 2>&1 | tail -3 && ls node_modules/exceljs >/dev/null && echo "exceljs OK"
git -C "$REPO" check-ignore -q server/.env && echo "server/.env 已被 git 忽略" || echo "✗ .gitignore 沒有 .env，停下來回報"
mkdir -p "$DATA/logs" "$DATA/photos" && chmod 700 "$DATA"
echo "第 2 步 repo $(git -C "$REPO" branch --show-current) $(git -C "$REPO" rev-parse --short HEAD)／Node $("$NODE" -v)（$(date '+%F %T')）" >> "$DATA/logs/deploy-evidence.txt"
```

- clone 要帳密（若是 private repo 才會要帳密；本倉庫 dzy-purchase 為 public，不該出現這情況，出現就停下來回報）：**停**，請 Eason 在終端機 App 先做好 GitHub 登入（`gh auth login` 或存好憑證），Claude 不輸入帳密。
- 跑一次測試當 smoke test（不碰 `.env`、不碰資料夾）：`cd "$REPO" && PURCHASE_NO_DOTENV=1 "$NODE" --test 2>&1 | grep -E '^ℹ (tests|pass|fail)'` → 期望 `fail 0`（測試用暫存資料夾與假照片，不呼叫任何外部服務）。

建 `.env` 骨架（金鑰與網址**留空**，由 Eason 在第 7 步填；`MODEL` 在第 3 步量完秒數後再加）：

```sh
REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"
test -e "$REPO/server/.env" && { echo "✗ .env 已存在，不要覆蓋，回報 Eason"; exit 1; }
( umask 077
  printf 'PORT=8794\nDATA_DIR=%s\nLOG_DIR=%s/logs\nOLLAMA_URL=http://127.0.0.1:11434\nOLLAMA_TIMEOUT_S=300\n' "$DATA" "$DATA" > "$REPO/server/.env"
  printf 'PNL_PUSH_URL=\nPNL_PURCHASE_KEY=\nBACKUP_URL=\nBACKUP_KEY=\n' >> "$REPO/server/.env" )
chmod 600 "$REPO/server/.env"
grep -c '^DATA_DIR=/' "$REPO/server/.env"        # 期望 1
```

- `PORT`、`DATA_DIR`、`LOG_DIR`、`OLLAMA_URL`、`OLLAMA_TIMEOUT_S`、`MODEL`、`PNL_PUSH_URL`、`PNL_PURCHASE_KEY`、`BACKUP_URL`、`BACKUP_KEY` 就是程式會讀的全部設定（見 `server/config.js`）。`BIND` 不寫：預設 `127.0.0.1`，對外只走 Funnel。`ALLOW_ORIGIN` 不寫：程式預設允許 `https://dzy-bulletin.github.io` 與本機。
- **不得**寫 `WORKER=0`（那是測試用，會讓辨識工人不啟動）。
- `LOG_DIR` 一定要指到 `$DATA/logs`：`/health` 與備份都靠那裡的 `backup-last.json`，plist 也會設同一個值。

---

## 第 3 步：Ollama、模型、量辨識秒數（Claude 做；Homebrew 沒有就請 Eason 裝官方 Ollama App）

目標模型 `qwen2.5vl:32b`（約 21 GB）。**先過兩道閘門，再下載**：

1. **記憶體**：`$(( $(sysctl -n hw.memsize) / 1073741824 ))` < 24（GB）→ **不下載 32b**，直接改走下面的 7b 路徑（`ollama pull qwen2.5vl:7b`、bench 的 `32b` 全改 `7b`、`MODEL_CHOSEN=qwen2.5vl:7b`），並**立刻回報 Eason**。
2. **磁碟**：下載前剩餘空間要 ≥ 40 GB，否則停下來回報：

```sh
FREE=$(df -g "$HOME" | awk 'NR==2{print $4}'); RAM=$(( $(sysctl -n hw.memsize) / 1073741824 )); echo "剩餘 ${FREE} GB／RAM ${RAM} GB"
[ "$FREE" -ge 40 ] || echo "✗ 磁碟剩餘不足 40 GB，停下來回報 Eason"; [ "$RAM" -ge 24 ] || echo "✗ 記憶體 < 24 GB：不下載 32b，改 7b 並回報 Eason"
```

**判準：部署當下用 3 張虛構示範照片量秒數，任一張超過 300 秒就改 7b 並回報 Eason。**

```sh
export PATH="$HOME/.local/node/bin:$PATH"
command -v ollama >/dev/null || { command -v brew >/dev/null && brew install ollama; }       # 沒有 brew 或裝不起來：停，請 Eason 從 Ollama 官網裝 macOS App（裝完會有 ollama 指令）
command -v ollama && ollama --version
curl -s --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null && echo "Ollama 已在跑" || { brew services start ollama; curl -sf --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:11434/api/tags >/dev/null && echo "Ollama 已啟動"; }
```

- 官方 App 版本的 Ollama 在登入時啟動；Homebrew 版用 `brew services`（**不加 sudo**，以部署帳號的 LaunchAgent 跑，模型存在這個帳號的 `~/.ollama`）。**不要用 `sudo brew services start ollama`**（會以 root 跑、模型存到 root 的家目錄）。
- 路線 D（FileVault）重開機時，要解鎖並登入部署帳號後 Ollama 才會起來——跟佈告欄的 Tailscale 不同；V4 驗收會驗到。

下載模型（約 21 GB，**一定超過 Bash 工具的 10 分鐘上限**：改成**背景執行並輪詢**，不要靠「中斷再重跑續傳」）。用 Bash 工具的 `run_in_background`（或單一指令加 `&`）起下載，再每隔一段時間用**單獨的短指令**查進度，直到完成：

```sh
DATA="$HOME/dzy-purchase-data"; mkdir -p "$DATA/logs"
ollama pull qwen2.5vl:32b > "$DATA/logs/ollama-pull.log" 2>&1 &
echo $! > "$DATA/logs/ollama-pull.pid"
```

輪詢（每次一個短指令；`ollama-pull.pid` 的程序不在了＝下載結束）：

```sh
DATA="$HOME/dzy-purchase-data"
kill -0 "$(cat "$DATA/logs/ollama-pull.pid")" 2>/dev/null && { echo "下載中："; tr '\r' '\n' < "$DATA/logs/ollama-pull.log" | tail -1; } || { echo "下載程序已結束"; tail -c 300 "$DATA/logs/ollama-pull.log"; }
ollama list | grep -c 'qwen2.5vl:32b'      # 期望 1（下載完成後）
```

程序結束但 `ollama list` 沒有該模型（網路中斷等）→ 重跑上面那段背景下載（會續傳），再輪詢。**只殺自己記下的 PID**。

產生虛構示範照片並量秒數（`demo-seed.js` 全部是編造的資料，只放在 `~/dzy-purchase-demo`、**不是**正式資料夾；它會先清空那個資料夾再重建，路徑必須含 `demo`）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"
cd "$REPO" && PURCHASE_NO_DOTENV=1 DEMO_PASS="$(openssl rand -hex 8)" DATA_DIR="$HOME/dzy-purchase-demo" "$NODE" server/dev/demo-seed.js 2>&1 | grep -v Warning | tail -3
PURCHASE_NO_DOTENV=1 MODEL=qwen2.5vl:32b OLLAMA_TIMEOUT_S=900 "$NODE" server/tools/ollama-bench.js "$HOME/dzy-purchase-demo/photos" 3 > "$DATA/logs/bench-32b.txt" 2>&1; echo "結束碼 $?"; grep -v Warning "$DATA/logs/bench-32b.txt"
```

- 需要 macOS（照片用內建 `qlmanage`＋`sips`）。`PURCHASE_NO_DOTENV=1` 讓這兩支不讀 `.env`；示範帳號密碼是一次性的隨機值（沒印、沒存，之後也用不到）。
- 結束碼 `0` 且「判定：未超過 300 秒」→ 用 32B：`MODEL=qwen2.5vl:32b`。結束碼 `3`（任一張超過 300 秒）→ 用 7b：先 `ollama pull qwen2.5vl:7b`（7b 約 6 GB，同樣用背景＋輪詢），再重量一次（把指令裡的 `32b` 改 `7b`、輸出檔改 `bench-7b.txt`）；結束碼 `1`（有辨識失敗但沒超時）→ 把輸出貼給 Eason 判斷，**不要自己決定**。
- 第一張包含模型載入時間（冷啟動）。每張秒數記下來，**超過 300 秒改 7b 的決定要立刻回報 Eason**（plan 的第一週還會再量每張實際秒數，T24）。

把選定的模型加進 `.env`（附加一行，不讀檔）並落檔：

```sh
REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"
MODEL_CHOSEN="qwen2.5vl:32b"            # 超過 300 秒時改成 qwen2.5vl:7b
printf 'MODEL=%s\n' "$MODEL_CHOSEN" >> "$REPO/server/.env"
grep -c '^MODEL=qwen2.5vl:' "$REPO/server/.env"        # 期望 1
{ echo "第 3 步 模型：$MODEL_CHOSEN"; grep -E '秒|判定' "$DATA/logs/bench-32b.txt"; } >> "$DATA/logs/deploy-evidence.txt"
```

---

## 第 4 步：前景試跑（還不交給 launchd）

用正式設定起一次，確認 Node、`.env`、資料夾都對。**只關自己起的那個 PID**。

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"; PORT=8794
lsof -nP -iTCP:$PORT -sTCP:LISTEN && { echo "✗ $PORT 有人在聽，停下來回報"; exit 1; }
"$NODE" "$REPO/server/index.js" > "$DATA/logs/manual-run.log" 2>&1 &
echo $! > "$DATA/logs/manual-run.pid"
curl -sf --retry 20 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$PORT/purchase/api/health"; echo
```

（`index.js` 用自己的位置找 `.env`，不需要先 `cd`。）期望：`"ok":true`、`"server":true`、`"ollama":true`、`"model":"qwen2.5vl:…"` 是第 3 步選的那個；`"status":"yellow"` 且 `"reasons":["PNL_NOT_CONFIGURED"]`（全新空資料庫，損益推送還沒設，這是預期的黃燈）。
`"ollama":false`（紅燈 `OLLAMA_DOWN`）→ 回第 3 步確認 Ollama 在跑。再驗：

```sh
DATA="$HOME/dzy-purchase-data"; PORT=8794
lsof -nP -iTCP:$PORT -sTCP:LISTEN                                                         # 期望只有一行 127.0.0.1:8794
[ "$(lsof -t -iTCP:$PORT -sTCP:LISTEN)" = "$(cat "$DATA/logs/manual-run.pid")" ] && echo "聽 $PORT 的就是剛起的 node" || echo "✗ PID 不符，停下來回報"
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/purchase/api/nope"       # 期望 404（NOT_FOUND）
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$PORT/purchase/api/login" -H 'Content-Type: application/json' -d '{"account":"x","password":"y"}'   # 期望 401（帳號還沒建，AUTH）
ls "$DATA"                                                                                # 期望有 purchase.db（第一次啟動自動建表）
kill "$(cat "$DATA/logs/manual-run.pid")" && rm "$DATA/logs/manual-run.pid"
lsof -nP -iTCP:$PORT -sTCP:LISTEN || echo "$PORT 已釋放"                                   # 期望「已釋放」；還看得到就隔幾秒再跑，仍在就停下來回報
```

---

## 第 5 步：安裝兩個 launchd job（照第 0 步判斷的路線 A 或 D）

| Label | 做什麼 | 排程 |
|---|---|---|
| `com.dzy.purchase` | 伺服器本體（含辨識工人、損益推送、每天 04:10 補排） | 開機／登入即啟動、`KeepAlive`、當掉 10 秒內重起 |
| `com.dzy.purchase.backup` | 每日金額備份（`server/backup.js`） | 每天 03:40（台北時間；錯過的班醒來後補跑） |

範本在 `server/launchd/`，佔位字串 `__NODE__`／`__REPO__`／`__DATA_DIR__`。

### 路線 A：LaunchAgent（不用 sudo）

```sh
REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"; U="gui/$(id -u)"
lsof -nP -iTCP:8794 -sTCP:LISTEN && { echo "✗ 8794 還有人在聽（第 4 步沒關乾淨？），先處理再載入"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"
for j in com.dzy.purchase com.dzy.purchase.backup; do
  sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__DATA_DIR__#$DATA#g" "$REPO/server/launchd/$j.plist" > "$HOME/Library/LaunchAgents/$j.plist"
done
cd "$HOME/Library/LaunchAgents"
plutil -lint com.dzy.purchase.plist com.dzy.purchase.backup.plist            # 兩個都要 OK
grep -c '__[A-Z_]*__' com.dzy.purchase.plist com.dzy.purchase.backup.plist   # 兩個都要 0
grep -l '<key>\(PNL\|BACKUP\)_' com.dzy.purchase*.plist || echo "plist 不含金鑰設定（正確）"
for j in com.dzy.purchase com.dzy.purchase.backup; do launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/$j.plist" && echo "載入 $j"; done
curl -sf --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:8794/purchase/api/health; echo
```

### 路線 D：LaunchDaemon（佈告欄實機走這條時用；FileVault 開著、開機即跑）

Claude（不用 sudo）產生 plist，再用 `plutil` 在**最外層**加 `UserName`（以部署帳號身分執行，資料夾權限才對；不要用 `sed` 加欄位——plist 裡有多個 `<dict>`，會插錯層）：

```sh
lsof -nP -iTCP:8794 -sTCP:LISTEN && { echo "✗ 8794 還有人在聽，先處理"; exit 1; }
REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"; S="$HOME/.local/src/launchdaemons"
mkdir -p "$S"
for j in com.dzy.purchase com.dzy.purchase.backup; do
  sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__DATA_DIR__#$DATA#g" "$REPO/server/launchd/$j.plist" > "$S/$j.plist"
  plutil -insert UserName -string "$(whoami)" "$S/$j.plist"
done
plutil -lint "$S/com.dzy.purchase.plist" "$S/com.dzy.purchase.backup.plist"       # 兩個都要 OK
grep -c '__[A-Z_]*__' "$S"/com.dzy.purchase*.plist                                 # 兩個都要 0
plutil -extract UserName raw "$S/com.dzy.purchase.plist"                           # 期望 = whoami
```

Eason（sudo，在他自己的終端機 App）安裝與載入：

```sh
S="$HOME/.local/src/launchdaemons"
for j in com.dzy.purchase com.dzy.purchase.backup; do sudo cp "$S/$j.plist" /Library/LaunchDaemons/ && sudo chown root:wheel /Library/LaunchDaemons/$j.plist && sudo chmod 644 /Library/LaunchDaemons/$j.plist; done
for j in com.dzy.purchase com.dzy.purchase.backup; do sudo launchctl bootstrap system /Library/LaunchDaemons/$j.plist; done
```

### 驗證（兩條路線都做；路線 D 的 PID 檢查改用下面不需 sudo 的方式）

路線 A 先看 job 狀態（路線 D 略過這個區塊，改看下面路線 D 區塊）：

```sh
U="gui/$(id -u)"
for j in com.dzy.purchase com.dzy.purchase.backup; do echo "== $j"; launchctl print "$U/$j" | grep -E '^\s*(state|pid|last exit code|run interval) ='; done
```

**路線 A**：`launchctl print` 讀得到，再比對 PID 是否就是聽 8794 的程序：

```sh
U="gui/$(id -u)"
LP=$(launchctl print "$U/com.dzy.purchase" | awk '$1=="pid"{print $3}'); SP=$(lsof -t -iTCP:8794 -sTCP:LISTEN)
[ -n "$LP" ] && [ "$LP" = "$SP" ] && echo "聽 8794 的就是 launchd 的 node（PID $LP）" || echo "✗ launchd PID=$LP、聽 8794 的 PID=$SP，不一致：停下來看故障排除 A"
```

**路線 D（不需 sudo）**：`launchctl print system/…` 不加 sudo 多半讀不到，**不要拿它當判準**。改驗「聽 8794 的就是部署帳號的 node、而且是 `server/index.js`」，並打 `/health`：

```sh
SP=$(lsof -t -iTCP:8794 -sTCP:LISTEN); echo "PID=$SP"
ps -o user=,comm= -p "$SP"                                  # 期望：使用者＝whoami、comm 是 node
pgrep -f "server/index.js" | grep -qx "$SP" && echo "✓ 聽 8794 的就是 server/index.js 的程序" || echo "✗ PID 不符，停下來看故障排除 A"
curl -sf http://127.0.0.1:8794/purchase/api/health >/dev/null && echo "✓ /health 通"
```

另請 **Eason 加 sudo 跑**並回報結果：`sudo launchctl print system/com.dzy.purchase | grep -E '^\s*(state|pid|last exit code) ='`、`sudo launchctl print system/com.dzy.purchase.backup | grep -E 'state|run interval'`。

期望：伺服器程序在跑、PID 就是聽 8794 的程序；backup 是 `not running`（等 03:40）。

**殺掉會自己重起**（驗收：10 秒內；路線 D 伺服器以部署帳號身分執行，自己的程序可以 kill，不用 sudo）：

```sh
U="gui/$(id -u)"; DATA="$HOME/dzy-purchase-data"
P1=$(lsof -t -iTCP:8794 -sTCP:LISTEN); echo "原 PID $P1"
T0=$(date +%s); kill "$P1"
curl -sf --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:8794/purchase/api/health && SEC=$(( $(date +%s) - T0 )) && echo "已恢復，約 $SEC 秒"
P2=$(lsof -t -iTCP:8794 -sTCP:LISTEN); echo "新 PID $P2"        # 要和原 PID 不同；秒數 ≤ 10
echo "第 5 步 殺掉 node 後重起：${SEC:-失敗} 秒（原 PID $P1 → 新 PID $P2）／$(date '+%F %T')" >> "$DATA/logs/deploy-evidence.txt"
```

**佈告欄沒被動到**（這一步開始，每做完一個大步驟都再看一次）：

```sh
curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("ok","e2e","bridge","level")})'    # 要和第 0 步基準相同
```

---

## 第 6 步：Tailscale Funnel 路徑分流（`/purchase` → 127.0.0.1:8794；**佈告欄的根路徑 `/` 不動**）

這是整份手冊唯一會碰到佈告欄對外網址的地方。**先確認、再改、改完立刻對照佈告欄基準（五個值），不一致就回退。**

**⛔ 一定用 `funnel`，不可用 `serve`**：Tailscale 的 `serve` 子命令設定路徑時會把同主機 443 的 Funnel 旗標關掉（`Removing Funnel for …`），結果 `/` 和 `/purchase` 都還在設定裡、但 443 不再對外，**手機 4G 打佈告欄立刻斷**，本機 8793 的 `/health` 卻照樣正常（所以基準一定要有第五值）。`funnel` 子命令對同一主機只會把 Funnel 設成開，不會動根路徑 `/` 的設定。

**前置**：第 0 步的版本與 `--help` 輸出已貼給 Eason、他已確認可以做第 6 步（`funnel --help` 有 `--set-path`）。

```sh
export PATH="$HOME/.local/node/bin:$PATH"; DATA="$HOME/dzy-purchase-data"
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
cat "$DATA/logs/funnel-before.txt"                           # 第 0 步存的現況（網址已遮蔽）：只該有根路徑一條
curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("ok","e2e","bridge","level")})'    # 改之前最後一次基準（前四值）
"$TS" funnel --bg --set-path /purchase "http://127.0.0.1:8794/purchase"; echo "結束碼 $?"
```

- **目標網址要帶 `/purchase`**：Tailscale 轉送時會把掛載路徑 `/purchase` 剝掉，不補回去的話，伺服器收到的是 `/api/health`（回 404）而不是 `/purchase/api/health`。
- 這一行**只新增 `/purchase` 這一條**，不會動根路徑 `/`。如果 CLI 印出同意連結並一直等：把連結交給 Eason；非 0 結束碼：**停**，把輸出（先遮掉網址）交給 Eason。
- **立刻**對照（不要先做別的）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; DATA="$HOME/dzy-purchase-data"
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
echo "== 佈告欄基準（改完）前四值"; curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("ok","e2e","bridge","level")})'
echo "== 第五值"; F=$("$TS" funnel status 2>&1); echo "funnel_on=$(echo "$F" | grep -c '(Funnel on)') root_8793=$(echo "$F" | grep -cE '^\|-- +/ +proxy +http://(127\.0\.0\.1|localhost):8793$')"
echo "== funnel status（網址已遮蔽）"; "$TS" funnel status 2>&1 | sed -E 's#https?://[^ /]+#https://<HOST>#g'
```

期望：
1. 佈告欄基準**五個值**與第 0 步**完全一致**（特別是 `funnel_on=1 root_8793=1`）；
2. `funnel status` 看得到兩條：`/ → proxy http://127.0.0.1:8793`（和 `funnel-before.txt` 一樣）與 `/purchase → proxy http://127.0.0.1:8794/purchase`，而且主機那行仍有 `(Funnel on)`。

**不一致或根路徑被改到＝立刻回退**（不要先查原因）。回退指令 `off` 在同一埠還有其他掛載時，Tailscale 可能**互動式確認**（`user confirms deletion`），Claude 的 Bash 不是 TTY，會卡住或失敗。依第 0 步 `--help` 的結果二選一：

- **有 `--yes`**（`funnel --help` 的 `yes=1`）：Claude 可以執行：

```sh
"$TS" funnel --https=443 --set-path /purchase --yes off       # 只移除 /purchase（首選）
"$TS" funnel status 2>&1 | sed -E 's#https?://[^ /]+#https://<HOST>#g'   # 要回到和 funnel-before.txt 一樣
```

- **沒有 `--yes`**：**請 Eason 在他自己的終端機 App 手動執行**（Claude 不執行，會卡在確認）：`tailscale funnel --https=443 --set-path /purchase off`（用 App 版的 CLI 時是 `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --https=443 --set-path /purchase off`），出現確認就答 `y`；做完回報 `funnel status` 與五個基準值。

回退後再印一次佈告欄基準五值。首選移除後還是和 `funnel-before.txt` 不同（根路徑被改了）→ 用佈告欄手冊第 7 步的原指令整份重做（**由 Eason 在終端機執行**，因為 `reset` 有確認、且會動佈告欄對外入口），然後**停下來回報**：

```sh
tailscale funnel reset; tailscale serve reset 2>/dev/null; tailscale funnel --bg 8793      # 佈告欄的原始設定：443 → 127.0.0.1:8793
```

**從 tailnet 外面驗證**（Claude 自己做得到；與佈告欄手冊同一套做法，向公開 DNS 查名稱、強迫連公開 IP）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
H=$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')      # 只放在 shell 變數、不寫檔；檢查全部通過後，在對話裡把 https://$H 交給 Eason（第 9 步要用）
IP=$(dig +short "$H" @1.1.1.1 | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
case "$IP" in
  "")    echo "✗ 公開 DNS 查不到 IPv4";;
  100.*) echo "✗ 拿到 tailnet 內部位址，不是公開入口";;
  *)     echo "== 進貨 /purchase/api/health"; curl -s --max-time 20 --resolve "$H:443:$IP" "https://$H/purchase/api/health" | head -c 200; echo
         echo "== 佈告欄 /health（根路徑）"; curl -s --max-time 20 --resolve "$H:443:$IP" "https://$H/health" | head -c 200; echo;;
esac
```

- 期望兩個都回 `{"ok":true,…}`。**進貨回 404 `找不到這個路徑`＝路徑前綴被剝掉了**：把 `/purchase` 那條目標網址確認有帶 `/purchase`（`funnel status` 看得到），沒帶就 `"$TS" funnel --bg --set-path /purchase "http://127.0.0.1:8794/purchase"` 重設一次（**不可用 `serve`**）。佈告欄那條回的東西要和第 0 步一致，否則**立刻回退**。
- 這條路是 Mac mini 自己連公開入口再繞回來（hairpin），實機上不一定通：10 分鐘內查不到或不通，**不算失敗**，記「繞回驗證不適用」，以第 8 步 V1／V2（手機 4G）為準；但若 `funnel status` 與佈告欄基準（五值）有任何不一致，不管繞回通不通都要回退。
- 結果落檔（二選一）：

```sh
echo "第 6 步 Funnel /purchase 分流：佈告欄基準（五值）前後一致；tailnet 外驗證：通過（$(date '+%F %T')）" >> "$HOME/dzy-purchase-data/logs/deploy-evidence.txt"
echo "第 6 步 Funnel /purchase 分流：佈告欄基準（五值）前後一致；tailnet 外驗證：繞回驗證不適用，交給 V1／V2 判斷（$(date '+%F %T')）" >> "$HOME/dzy-purchase-data/logs/deploy-evidence.txt"
```

**Funnel 網址（`https://` 加 `$H`）只在對話裡交給 Eason**；唯一會寫進檔案的地方是第 9 步 Eason 在 MacBook 填的 `web/js/config.js`，Mac mini 的任何檔案、證據檔、issue 都不寫。一律 `https://`。

---

## 第 7 步：【Eason 第一批｜部署後、手動】一次做完

**前置條件**：第 0～6 步都通過。Claude 把下面 B1～B4 整段貼給 Eason。Eason **用他自己開的「終端機」App**（不是 Claude 對話框）做完，說「做完了」後 Claude 跑本節最後的「驗證」。

**B1　建立正式帳號**（門市 5 間、會計 2 位、admin 1 位；**密碼只在這裡輸入，Claude 不經手**）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; cd "$HOME/dzy-purchase" && node server/tools/create-accounts.js
```

- 工具會依序問：門市 `CF`（中央廚房，品牌央廚）、`MDGF`（麻的小辛辣新竹光復，小辛辣）、`MZTGF`／`MZTZS`／`MZTLZL`（墨竹亭新竹光復／新竹金山／台北六張犁，墨竹亭）各自的密碼；**會計 A（品牌：中央廚房＋小辛辣）**、**會計 B（品牌：墨竹亭）**、管理者各一位。**帳號名稱與姓名都由 Eason 當場輸入**（手冊與程式不寫死任何人的真名與帳號；管理者帳號請用不易猜的名字，不要用 `admin`）；帳號留空＝略過那一位。**這裡輸入的是臨時密碼，對方（店長、會計）第一次登入會被要求改成自己的密碼**（admin 帳號不強制，但也可隨時自己改）；改完後這組臨時密碼就失效，之後 Eason 也不知道對方的密碼。密碼輸入時**畫面不會出現任何字**（工具自己逐字讀、不回顯）、要輸入兩次、至少 6 個字元。**建帳號前先清空終端機視窗與捲動紀錄（⌘K）**，做完也再清一次。
- 已存在的帳號預設跳過；要重設密碼才答 `y`（可重跑，不會重複建立）。看目前狀態不改東西：`node server/tools/create-accounts.js --list`。
- 密碼不要貼進 Claude 的對話框、LINE、issue、任何檔案。門市密碼由 Eason 親自交給店長。

**B2　Claude Code 的 `.env` 禁止讀取規則**（技術保險，文字禁令之外再加一道；會把規則合併進 `~/.claude/settings.json`，已有的設定不動）：

```sh
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.claude/settings.json'); os.makedirs(os.path.dirname(p), exist_ok=True)
d = json.load(open(p)) if os.path.exists(p) else {}
deny = d.setdefault('permissions', {}).setdefault('deny', [])
for r in ["Read(~/dzy-purchase/server/.env)", "Read(~/dzy-purchase/server/.env*)", "Edit(~/dzy-purchase/server/.env)"]:
    if r not in deny: deny.append(r)
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2); print('OK')
EOF
```

做完把 Claude 關掉（確保新規則生效），在**同一個資料夾**打 `claude --continue` 接回對話，說「繼續照 DEPLOY.md 第 7 步的驗證」。（Claude 之後用 `printf >> .env` 附加一行仍可行，但不會再去讀它。）

**B3　Google 備份（Apps Script）**：照 `~/dzy-purchase/gas/README.md` 的步驟 1～6 做（用 **madesiaosinla** 帳號；建立專案、貼 `gas/Code.js` 與 `gas/appsscript.json`、**執行 `setup` 並授權**、設指令碼屬性 `BACKUP_KEY`、**部署為網頁應用程式**〔執行身分「我」、存取權「所有人」〕並複製 `/exec` 網址）。其中 `BACKUP_KEY` 這樣產生（金鑰只存在 shell 變數、同時寫進 `.env` 並放進剪貼簿，**畫面上不會出現**；指令只印一個數字，`1`＝寫進 `.env` 成功）：

```sh
K=$(openssl rand -hex 32); E="$HOME/dzy-purchase/server/.env"; sed -i '' '/^BACKUP_KEY=/d' "$E"; printf 'BACKUP_KEY=%s\n' "$K" >> "$E"; printf '%s' "$K" | pbcopy; unset K; grep -cE '^BACKUP_KEY=([0-9a-f]{64}|[A-Za-z0-9+/]{43}=)$' "$E"
```

1. 貼上並執行這一行（印 `1`）。**這之間不要再從對話複製任何東西。**
2. 直接到 Apps Script → 專案設定 → 指令碼屬性 → 新增 `BACKUP_KEY`，⌘V 貼上 → 儲存。
3. 回終端機清空剪貼簿：`pbcopy < /dev/null`；若有第三方剪貼簿工具，刪掉紀錄裡那一筆。
4. 部署後把 `/exec` 網址填進 `.env` 的 `BACKUP_URL=` 那一行（用文字編輯器：`open -e "$HOME/dzy-purchase/server/.env"`，只改那一行、存檔）。**`PNL_PUSH_URL`、`PNL_PURCHASE_KEY` 這兩行現在留空**（第 10 步才填）。
5. 印的不是 `1`：整行重跑一次（會先刪掉舊的金鑰行），再重做第 2～3 點。

**B4　目視確認**：Tailscale 管理後台這台機器的 **key expiry 已停用**、Funnel 仍是開的（佈告欄上線時已做過，確認即可）；螢幕鎖定「要求密碼」為「立即」。回覆「B4 已確認」。

**驗證（Claude 在 Eason 說做完之後跑；只印設定值或數字）：**

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"; U="gui/$(id -u)"
git -C "$REPO" status --porcelain | wc -l                                  # 期望 0（repo 沒被改、.env 被 git 忽略）
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/settings.json'))); print(sum('dzy-purchase/server/.env' in r for r in d['permissions']['deny']))"   # 期望 ≥ 2
( cd "$REPO" && "$NODE" server/tools/create-accounts.js --list 2>&1 | grep -v Warning )      # 唯讀：期望 5 間門市「已建立」、會計 2 位（一位品牌 C＋X、一位品牌 M）、管理者 1 位
```

**重起伺服器讀新的 `.env`**（伺服器只在啟動時讀 `.env`）：路線 A：`launchctl kickstart -k "$U/com.dzy.purchase"`；路線 D：`kill "$(lsof -t -iTCP:8794 -sTCP:LISTEN)"`，由 `KeepAlive` 在 10 秒內重起（再確認 PID 已換）。接著**手動跑一次備份**（直接執行，路線 A、D 都適用；`.env` 由程式自己讀）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-purchase"; DATA="$HOME/dzy-purchase-data"; NODE="$HOME/.local/node/bin/node"
curl -sf --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:8794/purchase/api/health; echo
DATA_DIR="$DATA" LOG_DIR="$DATA/logs" "$NODE" "$REPO/server/backup.js" > "$DATA/logs/backup-manual.log" 2>&1; echo "結束碼 $?"; grep -v Warning "$DATA/logs/backup-manual.log"
cat "$DATA/logs/backup-last.json"; echo
curl -s http://127.0.0.1:8794/purchase/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d["reasons"], d["backup"])'
echo "第 7 步 備份：$(cat "$DATA/logs/backup-last.json")／$(date '+%F %T')" >> "$DATA/logs/deploy-evidence.txt"
```

期望：印「備份完成：…」、結束碼 `0`、`backup-last.json` 有 `"ok":true`；`/health` 為 `yellow`、`reasons` 只有 `["PNL_NOT_CONFIGURED"]`、`backup.last_ok_at` 有值。結束碼 `2`＝`BACKUP_URL`／`BACKUP_KEY` 沒讀到，見故障排除 E。
（備份的 launchd 排程本身用 `launchctl print "$U/com.dzy.purchase.backup" | grep -E 'state|run interval'` 確認已載入；03:40 的實際執行第二天看 `backup-last.json` 的時間。）

`.env` 的檢查交給 Eason（B2 生效後一律由 Eason 在終端機執行，見禁令第 5 條）：請他在終端機執行下面這段、**只回報四個數字與權限欄**（不印金鑰）：

```sh
E="$HOME/dzy-purchase/server/.env"; ls -l "$E" | cut -c1-10; grep -cE '^BACKUP_KEY=([0-9a-f]{64}|[A-Za-z0-9+/]{43}=)$' "$E"; grep -c '^BACKUP_URL=https://.*/exec$' "$E"; grep -c '^MODEL=.' "$E"; git -C "$HOME/dzy-purchase" status --porcelain | grep -c '\.env'
```

期望依序：`-rw-------`、`1`、`1`、`1`、`0`。Claude 把 Eason 回報的數字寫進證據檔（註明「Eason 在終端機執行」）。

---

## 第 8 步：【Eason 第三批｜現場驗證】一次做完

**前置條件**：第 7 步通過、第 9 步（前端正式設定）已完成並發佈（沒發佈就用 V1～V2、V4～V5，V3 延後）。

**手機的準備（所有手機驗證都要）**：手機**關掉 Wi-Fi、用 4G**，而且**打開 Tailscale App 按中斷連線（或整個登出）**——手機若連在 tailnet 裡，`*.ts.net` 會走 tailnet 內部，Funnel 沒開也打得通，驗收就不準。

| # | Eason 做什麼 | 通過的樣子 |
|---|---|---|
| V1 | 手機（已中斷 Tailscale、4G）打 `<Funnel 網址>/purchase/api/health` | 看到 `{"ok":true,"status":"yellow"…}`（黃燈＝損益推送還沒設，預期） |
| V2 | 同一支手機打 `<Funnel 網址>/health`（**佈告欄**） | 和部署前一樣，看到 `{"ok":true,…}`；再開佈告欄網頁，公告正常載入 |
| V3 | 手機（4G、中斷 Tailscale）開**前端網址** `https://dzy-bulletin.github.io/dzy-purchase/upload.html`（會計頁 `review.html`、管理頁 `admin.html` 同一路徑），用門市 `MDGF` 登入 → 傳一張**虛構測試單**（可用 `~/dzy-purchase-demo/photos/` 底下任一張示範照片，AirDrop 到手機）→ 等狀態變「待核對」（32B 單張可能要幾分鐘）→ 電腦開會計頁用**會計 A**帳號登入：側欄上方有「目前品牌」切換（央廚／小辛辣）、切到小辛辣看得到這張 → 按「退回重拍」，原因填「部署測試」 | 一路走通；辨識結果的廠商、品項看得出是示範單；退回後門市端看到「退回」 |
| V4 | **會計 B**（墨竹亭）登入：側欄**沒有**品牌切換；看不到 V3 那張；管理者登入管理頁 `https://dzy-bulletin.github.io/dzy-purchase/admin.html` 看得到門市 5 間、帳號 3 個 | 是 |
| V5 | 蘋果選單 → 重新啟動 → **放手，不碰鍵盤滑鼠** → 等 3 分鐘 → 手機（4G、已中斷 Tailscale）打 `/purchase/api/health` **與** 佈告欄 `/health`。**路線 D（FileVault）**：重開後在解鎖畫面輸入部署帳號密碼，**解鎖後不必做任何事，等 3 分鐘** | 兩個都在 3 分鐘內 `{"ok":true,…}`；`status` 不是 red（Ollama 要在登入後自己起來） |

**任一步 3 分鐘後打不到，照這個順序查**（能進桌面的話在同一個資料夾打 `claude --continue`，說「照 DEPLOY.md 第 8 步的診斷表查」，由 Claude 跑右欄指令）：

| 順序 | 看什麼 | 判讀 |
|---|---|---|
| 1 | 本機通不通：`curl -s http://127.0.0.1:8794/purchase/api/health`；路線 A：`launchctl print "$U/com.dzy.purchase" \| grep -E 'state\|pid\|last exit'`；路線 D（不需 sudo）：`pgrep -f server/index.js` 有沒有 PID、`lsof -nP -iTCP:8794 -sTCP:LISTEN`（`launchctl print system/…` 請 Eason 加 sudo） | 不通 → 故障排除 A |
| 2 | `/health` 的 `status` 是 red：`reasons` 有 `OLLAMA_DOWN` | Ollama 沒起來 → 故障排除 D |
| 3 | 本機通、手機不通：`"$TS" status \| head -3`、`"$TS" funnel status`（網址遮蔽） | 沒有 `/purchase` 這一條 → 重做第 6 步；Tailscale 未連線 → 佈告欄手冊故障排除 B |
| 4 | 佈告欄不通、進貨通 | **立刻回退第 6 步**，再查 |

Eason 做完、接回對話後，Claude 把 V1～V5 結果寫進證據檔（例如 `echo "第 8 步 V1～V5：…（Eason 口述，$(date "+%F %T")）" >> "$HOME/dzy-purchase-data/logs/deploy-evidence.txt"`），再跑：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; DATA="$HOME/dzy-purchase-data"; U="gui/$(id -u)"        # 路線 D：U="system"
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
uptime; fdesetup status
# 路線 A：
for j in com.dzy.purchase com.dzy.purchase.backup; do launchctl print "$U/$j" >/dev/null 2>&1 && echo "$j 已載入" || echo "✗ $j 沒載入"; done
# 路線 D（不需 sudo；改看 plist 在不在、伺服器程序在不在）：
# for j in com.dzy.purchase com.dzy.purchase.backup; do ls /Library/LaunchDaemons/$j.plist; done; pgrep -f server/index.js
"$TS" funnel status 2>&1 | sed -E 's#https?://[^ /]+#https://<HOST>#g'
curl -s http://127.0.0.1:8794/purchase/api/health; echo
curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("ok","e2e","bridge","level")})'     # 佈告欄基準（前四值）
F=$("$TS" funnel status 2>&1); echo "funnel_on=$(echo "$F" | grep -c '(Funnel on)') root_8793=$(echo "$F" | grep -cE '^\|-- +/ +proxy +http://(127\.0\.0\.1|localhost):8793$')"      # 第五值，與第 0 步逐字相同
tail -3 "$DATA/logs/server.log"
```

---

## 第 9 步：前端正式設定（**由 Eason 在 MacBook 上做，不在 Mac mini**；Funnel 網址只進 `web/js/config.js`，Mac mini 上不留）

前端 `web/js/config.js` 在倉庫裡存的是**佔位字串**（`DEPLOY_BASE` 那一行開頭，兩個底線＋`FUNNEL`＋兩個底線）。沒換就上線，畫面會顯示「尚未設定伺服器網址」，不會悄悄打到別處。處理方式與佈告欄的 `GAS_URL` 相同：部署完才把真正的網址填進前端那份 `config.js` 再發佈（這個主機名佈告欄的 `js/config.js` 已經在用，不是新增的曝光）。

Eason 在 MacBook 上（`~/mala-purchase`，已 `git pull` 到最新），**把第 6 步 Claude 在對話裡給他的 Funnel 主機名**填進 `H`：

```sh
cd ~/mala-purchase && git pull -q --ff-only
H="<Funnel 主機名，也就是網址 https:// 後面、結尾 .ts.net 為止>"
sed -i '' "s#var DEPLOY_BASE = '__FUNNEL__#var DEPLOY_BASE = 'https://$H#" web/js/config.js
grep -c '__FUNNEL__' web/js/config.js                       # 期望 0
grep -n "var DEPLOY_BASE" web/js/config.js                  # 期望 'https://<主機名>/purchase/api'
```

**發佈（GitHub Pages，自動）**：

```sh
git add web/js/config.js && git commit -m "前端：填入正式伺服器網址" && git push origin main
gh run list -R dzy-bulletin/dzy-purchase --workflow pages.yml -L 1      # 等到 completed／success（push main 觸發 .github/workflows/pages.yml 自動發佈 web/）
```

`pages.yml` 沒成功就**不要往下**，貼 `gh run view` 的結果給 Claude。成功後**驗證**：用瀏覽器（手機 4G、已中斷 Tailscale 更好）打開 `https://dzy-bulletin.github.io/dzy-purchase/upload.html`，登入畫面出現、**不再顯示「尚未設定伺服器網址」**。（repo 是 **public**，所以 config.js 內的網址是公開的，這是已定案的取捨。）
`?api=` 覆寫只在用 `localhost`／`127.0.0.1` 開頁時生效，而且只收 `http://localhost|127.0.0.1:埠/purchase/api`；正式網址一律忽略（防止假連結把人導到釣魚後端）。本機測試前端：`DATA_DIR=<資料夾> PORT=8794 node server/index.js` 加 `python3 -m http.server 8792 --bind 127.0.0.1 -d web`，開 `http://localhost:8792/upload.html`（預設就連 `http://localhost:8794`）。

---

## 第 10 步：開啟損益推送（**部署當天不做**；T23 前置設定完成後由 Eason 決定時間）

前提（順序不可顛倒）：損益系統（mala-pnl-auto）已 merge 含 `purchasePush` 的版本、`clasp push`、並由 Eason 自己設好 `PNL_PURCHASE_KEY` 指令碼屬性、部署新版本；管理頁已設好各門市的「損益系統門市代號」與「損益對照」。**必須先部署損益系統再開推送**——舊版損益端不回 `live`／`manual`，會讓定稿月份誤亮黃燈。

1. Eason 用文字編輯器（`open -e "$HOME/dzy-purchase/server/.env"`）填 `PNL_PUSH_URL=`（損益系統 Apps Script 的 `/exec` 網址）與 `PNL_PURCHASE_KEY=`（和損益端同一把，**Eason 自己貼，Claude 不經手**），存檔。
2. 重起伺服器（同第 7 步的做法）。
3. Claude 看 `/health`：`reasons` 不再有 `PNL_NOT_CONFIGURED`（會變成 green 或只有「待補對照」之類的黃燈）：`curl -s http://127.0.0.1:8794/purchase/api/health`。

---

## 第 11 步：收尾檢查

Claude 跑（不碰 `.env`）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-purchase"
git -C "$REPO" grep -l "guo""eason" | wc -l                 # 期望 0（手冊與程式不寫死任何人的帳號；字串拆兩半免得這行自己被搜到）
# 會計真名不得出現在 repo：由 Eason 在 MacBook 上用兩位真名各 git grep 一次（真名不寫進手冊），期望都是 0
git -C "$REPO" status --porcelain                           # 期望空白
lsof -nP -iTCP:8794 -sTCP:LISTEN; lsof -nP -iTCP:8793 -sTCP:LISTEN     # 各只有一行 127.0.0.1
ls ~/Library/LaunchAgents/com.dzy.bulletin* /Library/LaunchDaemons/com.dzy.bulletin* 2>/dev/null   # 佈告欄的 job 還在、沒被動到
```

**金鑰外洩檢查交給 Eason**（B2 生效後 Claude 跑不了）：他在終端機執行，只回報數字（取 `BACKUP_KEY` 前 8 碼去比對 Claude 的對話紀錄與伺服器 log，不印金鑰）：

```sh
E="$HOME/dzy-purchase/server/.env"; DATA="$HOME/dzy-purchase-data"
[ "$(grep -cE '^BACKUP_KEY=([0-9a-f]{64}|[A-Za-z0-9+/]{43}=)$' "$E")" = 1 ] && grep -rl "$(sed -n 's/^BACKUP_KEY=//p' "$E" | tr -d "\"'" | cut -c1-8)" ~/.claude/projects/ "$DATA/logs" 2>/dev/null | wc -l
```

回 `0`＝沒外洩。非 0 → 再用 12 碼複查一次（把 `cut -c1-8` 改 `cut -c1-12`）；仍非 0 → **不要打開命中的檔案**，Eason 重做 B3 的金鑰（Apps Script 屬性＋`.env`），重起伺服器。

---

## 驗收清單與回報格式

在 GitHub issue 留言（issue 編號由 Eason 在對話中給；T22）：把下面整段存成暫存檔、逐項打勾填好，用 `gh issue comment <編號> -R dzy-bulletin/dzy-purchase --body-file <暫存檔>` 送出（這台的 `gh` 沒登入就把整段交給 Eason 貼）。**不貼任何網址、金鑰、tailnet 名稱、帳號密碼**；`/health` 回應可以整段貼（它不含網址與秘密）。

```markdown
## P4 部署回報（Mac mini）

環境：<證據檔的「環境」那一行>／路線 <A 或 D>／Tailscale <版本>

（以下數據一律從 `$HOME/dzy-purchase-data/logs/deploy-evidence.txt` 讀，不憑對話記憶；可把整個證據檔貼在最後的 details 裡。）

- [ ] 照 DEPLOY.md 完成，過程沒有回 MacBook 問（卡住的地方：<無／列出>）
- [ ] 第 11 步帳號名稱 grep 為 0；`.env` 權限 `-rw-------`、`git status` 乾淨；Claude 設定有 `.env` 的 Read 禁止規則
- [ ] 佈告欄基準（`ok／e2e／bridge／level`＋第五值 `funnel_on`／`root_8793`）部署前＝第 6 步後＝第 8 步後，三次一致；`funnel status` 根路徑 `/` 未變，只多一條 `/purchase`
- [ ] `lsof` 8794 只有 `127.0.0.1:8794` 且 PID＝launchd 的 pid；殺掉 node 後 <證據檔第 5 步秒數> 秒內（≤ 10）自動重起
- [ ] 模型：<32b／7b>；三張示範照片秒數：<證據檔第 3 步>（任一張 > 300 秒已改 7b 並回報）
- [ ] tailnet 外驗證：`/purchase/api/health` 與佈告欄 `/health` 皆 `ok:true`：<通過／繞回驗證不適用，由 V1／V2 判定>
- [ ] V1～V5：手機 4G（已中斷 Tailscale）打得到 `/purchase/api/health`（黃燈、僅 `PNL_NOT_CONFIGURED`）；佈告欄 `/health` 一樣正常；上傳→辨識→會計切品牌看到→退回 一路通；會計 B 沒有品牌切換；重開機 3 分鐘內兩個服務都恢復
- [ ] 備份：手動跑一次 `ok:true`、Google 試算表出現 `YYYY-MM` 分頁；`com.dzy.purchase.backup` 已載入（03:40）
- [ ] 帳號：5 間門市、會計 A（央廚＋小辛辣）、會計 B（墨竹亭）、管理者皆「已建立」（Eason 在終端機建，密碼未經 Claude；回報不寫帳號名稱與姓名）
- [ ] 前端 `config.js` 已填 Funnel 網址（MacBook 上做）並發佈；登入畫面正常
- [ ] #金鑰 grep 檢查：0 命中（Eason 在終端機執行）

<details><summary>證據檔與目前的 /health</summary>

（貼 `cat "$HOME/dzy-purchase-data/logs/deploy-evidence.txt"`，以及現在 `curl -s http://127.0.0.1:8794/purchase/api/health` 的輸出）
</details>
```

Funnel 網址：**在對話裡**交給 Eason，不寫在上面（唯一例外：第 9 步 Eason 填進 `web/js/config.js`）。

---

## 部署中途更新（程式已有新版、Mac mini 已在跑）

更新是安全的：資料庫遷移以 `PRAGMA user_version` 自動往上（v8＝首次登入強制改密碼：既有門市與會計帳號設為「第一次登入要改密碼」、admin 不用），在交易內執行、失敗會整段回滾，不會掉資料。**更新前先備份 `$DATA/purchase.db`（`cp` 一份即可）。** 注意：更新後**所有既有門市與會計第一次登入都會被要求改密碼**，先告知店長與會計。

在 Mac mini 上：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; cd ~/dzy-purchase && git pull && npm ci
```

接著依你的部署路線重啟（先看是哪一條：`launchctl print gui/$(id -u)/com.dzy.purchase` 有輸出＝路線 A）：

- 路線 A（LaunchAgent）：`launchctl kickstart -k gui/$(id -u)/com.dzy.purchase`
- 路線 D（LaunchDaemon）：交給 Eason 執行 `sudo launchctl kickstart -k system/com.dzy.purchase`（Claude 不用 sudo）

重啟後確認：`curl -s http://127.0.0.1:8794/purchase/api/health`（要回 `"ok":true`；等 5 秒內可重打）。前端（GitHub Pages）另在 MacBook 上 push，**更新前端記得保留第 9 步已換好的 `config.js` 網址**。

## 故障排除

以下指令的變數沿用「手冊約定」那一行。

**A. launchd 起不來（`launchctl print` 沒有 pid、`/purchase/api/health` 打不通）**
- 看 log（不含金鑰）：`tail -30 "$DATA/logs/server.err.log"`、`launchctl print "$U/com.dzy.purchase" | grep -E 'last exit code|state'`（路線 D：`system/…`）。
- `bootstrap` 回 `Bootstrap failed: 5: Input/output error`：通常是已經載入過了。先 `launchctl bootout <domain>/<label>` 再 bootstrap（路線 D 要 sudo，交給 Eason）。
- `last exit code = 78` 或完全沒有 log 檔：`$DATA/logs` 不存在或路徑錯 → `mkdir -p "$DATA/logs"`，再檢查 plist 路徑（`plutil -p ~/Library/LaunchAgents/com.dzy.purchase.plist`）。
- log 出現 `Operation not permitted`：repo 或資料夾放在桌面／文件／下載底下 → 搬到 `$HOME` 底下，重做第 5 步的替換。
- log 出現「需要 Node 24 以上」：plist 的 `__NODE__` 指錯 → `"$HOME/.local/node/bin/node" -v`、`plutil -p … | grep node`。`ExperimentalWarning: SQLite is an experimental feature…` 是 Node 24 的正常提示，無害。
- log 反覆出現 `EADDRINUSE`：8794 被別的程序占住（常見是第 4 步前景試跑沒關乾淨）。`lsof -nP -iTCP:8794 -sTCP:LISTEN` 看是誰；是自己第 4 步起的才 kill，不是就停下來回報 Eason。
- 改了 plist：`bootout` 再 `bootstrap`（`kickstart` 不會重讀 plist）。改了 `.env`：路線 A `launchctl kickstart -k gui/$(id -u)/com.dzy.purchase`；路線 D kill 伺服器 PID 讓 `KeepAlive` 重起（伺服器只在啟動時讀 `.env`）。

**B. Funnel／路徑分流**
- 進貨 404、佈告欄正常 → `/purchase` 那條的目標網址沒帶 `/purchase`（見第 6 步），用 `funnel --bg --set-path …` 重設即可。
- 佈告欄不正常（含基準第五值變了）→ **立刻回退第 6 步**（`funnel --https=443 --set-path /purchase off`；有沒有 `--yes`、要不要請 Eason 手動執行，見第 6 步），再查原因；回退後 `funnel status` 要與 `$DATA/logs/funnel-before.txt` 相同。
- `"$TS" status` 顯示 Logged out 或 Stopped、key expiry、Funnel 同意等 Tailscale 本身的問題 → 照 `~/dzy-bulletin/server/DEPLOY.md` 的故障排除 B；**本系統不另外處理 Tailscale**。
- 剛設好時 TLS 錯誤或公開 DNS 查不到 → 憑證與 DNS 還在生效，10 分鐘內再試。

**C. 兩個服務互相影響**
- 兩邊獨立：埠（8793／8794）、launchd 名稱（`com.dzy.bulletin*`／`com.dzy.purchase*`）、資料夾（`dzy-bulletin-data`／`dzy-purchase-data`）、`.env` 都分開。重起、更新一邊**不需要**動另一邊。
- 兩邊共用的只有：`~/.local/node`（Node 24）、Tailscale、Funnel 的 443。升級 Node 小版會同時影響兩邊，由 Eason 挑時間做、做完兩邊都要重起並看 `/health`。

**D. Ollama（`/health` 的 `reasons` 有 `OLLAMA_DOWN`，或貨單卡在「辨識中」）**
- `curl -s http://127.0.0.1:11434/api/tags | head -c 100`：不通 → 官方 App 版：打開 Ollama App；Homebrew 版：`brew services restart ollama`（不加 sudo）。重開機後 Ollama 要等登入才起來（路線 D 也是解鎖登入後）。
- 通，但辨識逾時（貨單退成「辨識失敗」，`jobs_log`／`server.err.log` 有逾時）→ 多半是模型載入慢或機器吃緊：先看第 3 步的秒數；超過 300 秒就該改 7b（Eason 決定）：**由 Eason 在終端機執行** `sed -i '' 's/^MODEL=.*/MODEL=qwen2.5vl:7b/' "$HOME/dzy-purchase/server/.env"`，再重起伺服器；已失敗的貨單由會計在核對頁按「重新辨識」。
- 單張辨識上限由 `OLLAMA_TIMEOUT_S`（預設 300）控制；模型閒置會被 Ollama 卸載，下一張要重新載入，第一張會特別慢。

**E. 備份**
- `backup.js` 結束碼 2、`未設定 BACKUP_URL／BACKUP_KEY` → `.env` 兩行沒填或格式錯（交給 Eason 在終端機檢查，見第 7 步 `.env` 檢查）。
- 錯誤含 `AUTH`／金鑰錯誤 → 兩邊金鑰不一致：Eason 重做 B3 的金鑰那一行與 Apps Script 屬性。
- 錯誤含「回應不是 JSON」→ `BACKUP_URL` 不是網頁應用程式的 `/exec` 網址，或部署的存取權不是「所有人」。
- `/health` 紅燈 `BACKUP_STALE`（上次成功超過 26 小時）→ 看 `$DATA/logs/backup.err.log` 與 `backup-last.json` 的時間；`launchctl print "$U/com.dzy.purchase.backup" | grep -E 'state|last exit'`，手動跑一次（見第 7 步）看錯誤。

**F. 損益推送（第 10 步之後才會遇到）**
- `/health` 黃燈 `PNL_NOT_CONFIGURED` 在第 10 步前**是正常的**，不用處理。
- 開啟後的黃／紅燈原因（定稿月遲到貨單、待補對照、推送失敗）：登入後 `GET /purchase/api/health/detail` 看詳細文字（admin 與會計本品牌），公開 `/health` 只給通用代碼。

---

## 回退（整套拆掉）

只拆本系統，**佈告欄不動**：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; U="gui/$(id -u)"
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
# ① 先拆 Funnel 路徑：有 --yes 才由 Claude 執行；沒有 --yes 請 Eason 在終端機手動執行（會互動確認），做完再繼續
"$TS" funnel --https=443 --set-path /purchase --yes off                              # 沒有 --yes 時改由 Eason：tailscale funnel --https=443 --set-path /purchase off
"$TS" funnel status 2>&1 | sed -E 's#https?://[^ /]+#https://<HOST>#g'                # 要與 funnel-before.txt 相同
for j in com.dzy.purchase com.dzy.purchase.backup; do launchctl bootout "$U/$j" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/$j.plist"; done    # ② 路線 A；路線 D 請 Eason：sudo launchctl bootout system/<label>; sudo rm /Library/LaunchDaemons/<label>.plist
curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("ok","e2e","bridge","level")})'    # ③ 佈告欄基準
```

**`~/dzy-purchase-data`（含 `purchase.db` 與全部貨單照片）不要刪**——除非 Eason 明確說要刪；資料沒備份前不要動。
