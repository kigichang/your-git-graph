# CLAUDE.md

把 VS Code 擴充套件 [vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs) 移植成 macOS App，使用 **Tauri 2**。
目前狀態：**Stage 1 完成**（自用版）。PoC、第 1 項 `git_exec`、第 2 項（host 涵蓋完整協定，走路線 (b)）、第 4 項 repo 管理、第 5 項 diff 檢視（Monaco）、第 6 項 askpass、第 7 項設定與狀態存檔、第 8 項打包（個人使用、ad-hoc 簽章）、第 3 項主題都已完成；各項留下的缺口見「尚未實作的行為」與路線圖的要點欄。

## 授權限制（每次動手前都要記得）

| 上游路徑 | 授權 | 能做什麼 |
|---|---|---|
| `vendor/vscode-git-graph-rs/native/`（Rust 引擎 git-graph-core） | MIT | 可自由使用與散布 |
| `vendor/vscode-git-graph-rs/web/`、`src/`（webview UI、extension host） | mhutchie Git Graph 授權 | **禁止散布衍生作品**，只能自用 |

- **本 repo 的原始碼以 MIT 公開**（根目錄 `LICENSE`，Copyright (c) 2026 Kigi Chang；範圍不含 `vendor/`）。**建置產物不得散布**：`prepare-ui.mjs` 會把上游 webview 複製進 App，所以不發布 .app／dmg，使用者自己建置、自用。README 註明和 mhutchie 的 Git Graph、vscode-git-graph-rs 無關聯。**開發在公開 repo** https://github.com/kigichang/your-git-graph （從清理後的內容建立，歷史從一個初始 commit 開始）。原本的私人 repo `kigichang/git-graph` 已封存（唯讀、不公開），保留 0.3.2 以前的完整歷史與 tag `v0.2.0`、`v0.3.0`；那些舊 commit 還有上述兩處上游內容，**不要把它的 ref 或 tag 推到公開 repo**（本機已移除它的 remote 與 tag）。公開 repo 的版本 tag 從下一版重新開始。
- **repo 裡不能有上游受限的內容**（`web/`、`src/`、`out/`、`media/`、上游 `resources/icon.png` 這類非原創素材）：只能在建置時從 submodule 取用，產物放在 gitignore 的目錄。公開前稽核過（12 個 token 的片段比對）並移除了兩處：App 圖示（原本取自上游 `resources/icon.png`，改成自己畫的 `app/src-tauri/icons/icon.svg`）、`host/main.js` 的 webview HTML 骨架與 graph 顏色注入（原本照抄上游 `src/gitGraphView.ts`，改成 `viewSkeleton()`，元素的 id、class、巢狀與留白和原本相同）。元素 id、`--vscode-*`、設定 key、協定欄位名稱這類互通所需的介面名稱可以用。
- 只要 App 還打包了上游 `web/` 或沿用 `src/` 的程式碼，**建置出的 App** 就**不能對外散布**。
- 是否散布 App **還沒決定**。如果要散布，就要做 Stage 2：clean-room 重寫 UI 和 host。重寫時不能參考或複製 `web/`、`src/` 的程式碼，只能沿用引擎。
- 新寫的程式碼不要從 `web/`、`src/` 複製大段邏輯，避免日後 Stage 2 時授權混雜。

## 架構

```
app/
  src-tauri/            Rust 端（獨立 Cargo workspace）
    src/main.rs         commands：engine_request、initial_repo、host_log、self_test、preview
    src/git.rs          git CLI：git_exec、git_cancel、git_info
    src/repo.rs         repo_operation_state：從 git dir 判斷 merge/rebase/cherry-pick/revert 進行中；export_repo_config（只寫 .vscode/vscode-git-graph.json）
    src/state.rs        Application Support 裡的檔案：state.json（view state）、settings.json（設定）、session.log；data_dir、write_atomic
    src/system.rs       clipboard_write、open_url、open_path、open_terminal（macOS 整合）
    src/askpass.rs      git/ssh 的帳密提示：helper 模式（main() 最前面）＋ Unix socket 伺服器＋askpass_reply
    src/diff.rs         open_diff_window（開 diff 視窗並注入 spec）、worktree_file（讀工作目錄檔案，限 repo 內）
    src/watch.rs        檔案監看（notify/FSEvents）：事件合併後由 classify() 判斷哪些 repo 需要刷新
    src/repos.rs        視窗與 repo 的對應、最近清單、子 repo 掃描、開新視窗（open_new_window）、選單（App、File、View）
    Info.plist          Tauri 合併進 bundle：宣告接受資料夾（`public.folder`，rank None，不會變成開資料夾的預設 App）
    icons/icon.svg      App 圖示的原始檔（自己畫的）；其他尺寸用 `cargo tauri icon <1024px PNG>` 產生（`rsvg-convert` 轉 PNG），只保留 repo 已追蹤的那些檔名
    capabilities/default.json  圖形視窗（main、repo-*）的權限
    capabilities/diff.json  diff-* 視窗的權限（core:default、關閉自己、設定標題）
  ui/                   前端（Tauri 在編譯時嵌入執行檔）
    index.html          載入 theme.css、sidebar.css、theme.js、bootstrap、shim、host/main.js（ES module）
    theme.js            外觀（淺色/深色 × 增強對比）→ <html> 的 gg-dark/gg-contrast 與 <body> 的 vscode-* class；主視窗與 diff 視窗共用
    shim.js             重建 acquireVsCodeApi()；host→webview 用 window.__ggDeliver(msg)
    host/main.js        啟動、路由、每個請求的 ctx、self-test（唯一碰 Tauri 的 host 模組）
    host/reads.js       引擎提供的讀取
    host/gitops.js      git CLI 的寫入與讀取（reflog、worktree、衝突預測、repo config）
    host/app.js         VS Code 原本負責的事（剪貼簿、開啟、終端機、view state、設定、匯出 repo 設定、code review）＋尚未支援的功能
    host/settings.js    設定 key → 驗證 → view config（configFrom）；純函式
    host/repoconfig.js  匯出／匯入 repo 設定（.vscode/vscode-git-graph.json）；純函式
    host/sidebar.js     左側的 repo 側欄：純函式（頭像、同名提示、清單增刪、ahead/behind）＋ DOM 元件（不碰 Tauri）
    sidebar.css         側欄的版面，以及把 #view 等往右推的規則
    host/askpass.js     帳密對話框（接 `askpass` 事件，排隊顯示，回 askpass_reply）
    host/diffspec.js    diff 請求 → 視窗 spec（左右各讀哪個 revision/路徑）；純函式，主視窗與 diff 視窗共用
    diff.html           diff 視窗頁面（工具列、檔案清單、編輯器、圖片比較）
    diff-dist/          由 scripts/build-diff.mjs 產生（已 gitignore）
    theme.css           --vscode-* 變數 → macOS 淺色/深色，各有增強對比版本（由 theme.js 的 class 切換）
    media/、generated/  由 scripts/prepare-ui.mjs 產生（已 gitignore）
  diff/main.js          diff 視窗程式（Monaco ESM），由 esbuild 打包進 ui/diff-dist/
  tests/gitops.test.mjs  gitops.js 在 Node 對真的 git 跑的測試
  tests/diffspec.test.mjs  diffspec.js 的語意測試
  tests/settings.test.mjs  settings.js 的結果和上游 out/config.js 逐一比對
  tests/repoconfig.test.mjs  repoconfig.js 的匯出欄位與匯入規則
  tests/theme.test.mjs  解析 theme.css，檢查四種外觀的 WCAG 對比（含側欄）
  tests/sidebar.test.mjs  sidebar.js 的純函式
  tests/basic_auth_server.py  self-test 用的 HTTP Basic Auth 伺服器（只用 Python 標準函式庫）
  scripts/prepare-ui.mjs  從 vendor 複製編譯好的 webview（把其中的簡體中文轉成臺灣正體）、用上游 config.js 產生預設設定，並呼叫 build-diff.mjs
  scripts/zh-tw.mjs     簡體 → 臺灣正體：OpenCC s2twp ＋ 臺灣 Git 用語替換表（TAIWAN_TERMS）；只在建置時用
  scripts/build-diff.mjs  用 esbuild 打包 diff 視窗（也可單獨跑 `npm run build:diff`）
  scripts/selftest.sh   執行 App 內建的 self-test 並印出 log（PASS 時 exit 0）
  scripts/preview.sh    用 GG_PREVIEW 開到指定畫面再截圖（看主題用；需要螢幕錄製權限）
  scripts/build-app.sh  打包：prepare-ui → cargo tauri build → 驗證簽章與架構；可加 --universal、--dmg、--install
  package.json        建置期依賴：esbuild、monaco-editor、opencc-js（版本鎖定；只在打包時用）
vendor/vscode-git-graph-rs  上游 submodule（鎖在 v1.0.28）
```

資料流：webview（上游 `out.min.js`）呼叫 `postMessage` → `shim.js` → `host/main.js` 的 `respond()` → 對應的 handler（`reads.js`/`gitops.js`/`app.js`）→ `invoke('engine_request')` 或 `invoke('git_exec')` → 引擎在 `spawn_blocking` 執行，或 git CLI 執行 → handler 組好回應，透過 `__ggDeliver` 包成 `MessageEvent` 送回 webview。

## 建置與驗證

```sh
git submodule update --init
(cd vendor/vscode-git-graph-rs && npm ci && npm run compile-src && npm run compile-web)
(cd app && npm ci)
node app/scripts/prepare-ui.mjs
cd app/src-tauri && cargo build                            # debug
cd app/src-tauri && cargo tauri build --bundles app        # → target/release/bundle/macos/Git Graph.app
app/scripts/build-app.sh [--universal] [--dmg] [--install]  # 打包的正式做法（含 prepare-ui 與驗證）
```

- **自我測試**：`app/scripts/selftest.sh <App 執行檔> <repo 或含多個 repo 的資料夾> [log 檔]`（內部就是 `GG_SELFTEST=1 <執行檔> <路徑>`，並把 `GG_DATA_DIR` 指到臨時目錄，不會動到你的最近清單）。頁面會先把介面語言切成繁體中文再切回英文（各重新載入一次，確認會開回同一個 repo、工具列與側欄文字跟著變、`settings.json` 存的是 `zh-tw`），接著自動點一個 commit、透過 IPC 驗證 `git_exec` 的 cwd/串流/取消、經由路由跑 8 種讀取、做一次可還原的寫入（建立再刪除 `gg-selftest-*` 分支），確認會拒絕其他 repo 路徑，走一次完整的 data-loss 警告（用 `commit-tree` 做一個只有某分支才有的 commit，強制移動該分支 → 收到 `lossWarning` → webview 顯示警告對話框 → 點繼續後帶 `confirmed` 重送 → 分支真的移動，最後刪掉），再用真的 helper 執行檔驗證 askpass（回答並遮罩、取消、git 逾時後對話框自動關閉、ssh-keygen 的 passphrase），依序打開 5 種 diff 視窗（viewDiff、viewFileAtRevision、openCompareTab、viewDiffWithWorkingFile、viewDiffBinary），每個視窗渲染後回報結果，有 editor 的會先驗證「搜尋框開著時 Esc 只關搜尋框」，最後都用 Esc 關閉（主視窗確認 diff 視窗全部關掉了）；若點到的 commit 含有修改過的圖片，會多測一次圖片並排比較（檢查兩張圖都能解碼）。接著檢查子 repo 掃描與最近清單、在多 repo 的視窗裡切換 repo、檔案監看（在工作目錄建立和刪除檔案，各應觸發一次刷新）、設定（存檔後收到 `configChanged`、超出範圍的值被拒絕、還原；`settings.json` 的 `dialog.createBranch.checkOut` 讓 Create Branch 對話框預設勾選 Check out、`commitDetailsView.location` 讓新打開的詳細資料停靠在底部）、state 經 Rust 寫入 state.json 且不留在 `localStorage`、匯出 repo 設定再讀回（repo 已有該檔時略過，不覆寫）、View > Find 打開 find widget、側欄（清單與目前的 repo、收合／展開時 `#view` 的位置、commit 的右鍵選單開在游標旁；File > Open 另一個 repo 會加進側欄並在這個視窗顯示、點側欄切回、Open in New Window 開出新視窗（新視窗的 askpass 對話框只出現在它自己，主視窗不會出現）、拖拉到最上面、Remove 移除、模擬把資料夾拖到視窗上（送 `tauri://drag-drop`）會加進側欄並顯示）、主題（`AccentColor` 能解析、強調色上的文字是白色、用 `set_appearance` 切淺色與深色後 WebKit 跟著變、強制增強對比後的 body class 與顏色、每個 diff 視窗的 Monaco 主題與外觀一致）。最後在 stderr 輸出 `selftest: PASS|FAIL`。沒有螢幕截圖權限時，這是主要的端到端驗證方式。每次改動 host 或 UI 都要跑。**它會寫入目標 repo**（臨時分支、臨時檔與 `.vscode/vscode-git-graph.json`，都會刪掉），建議對 scratch 裡的 clone 跑，不要對 vendor submodule 跑。兩種情況都要跑：單一 repo，以及含多個 repo 的資料夾（例如 scratch 裡放 git/git clone 和圖片測試 repo 的那一層）。
- **看畫面**（改主題或 CSS 後）：`app/scripts/preview.sh <執行檔> <repo> <場景> <light|dark|system> <輸出前綴>`。場景用逗號分隔、依序執行：`details`（打開一個 commit）、`settings`、`menu`（右鍵選單）、`dialog`（Create Branch）、`find`（搜尋 "fix"）、`diff`（開 diff 視窗）、`resize`（把視窗放大到 2400×1300，模擬手動拉大；`preview_resize` 只在 `GG_PREVIEW` 下有效）、`fold`（收合側欄）、`repomenu`（側欄第二個 repo 的右鍵選單）；路徑給含多個 repo 的資料夾就能看到側欄有好幾項；加上 `contrast` 強制增強對比。每個視窗輸出一張 PNG。App 跑在臨時的 `GG_DATA_DIR`，外觀用預先寫好的 `state.json` 指定，不會動到你的設定。終端機需要「螢幕錄製」權限。
- **監看的手動檢查**（self-test 涵蓋不到）：一般模式開著 App，閒置幾秒應該 0 次刷新；在終端機 `git commit`、`git checkout -b` 各應剛好刷新一次，之後不能持續刷新（log 裡的 `watcher:` 行數）。
- **真的 git 走 HTTP 帳密**（可選）：
  ```sh
  python3 -I app/tests/basic_auth_server.py /tmp/port /tmp/auth.log &   # 401 要求 Basic Auth；收到帳密就記錄並回 403
  GG_SELFTEST=1 GG_SELFTEST_HTTP=http://127.0.0.1:$(cat /tmp/port)/r.git target/debug/git-graph-app <repo>
  cat /tmp/auth.log   # 應為 auth: gg-user:gg-pass
  ```
  self-test 會用 `-c credential.helper=` 關掉 Keychain，不讀也不存。改動 askpass 時要跑，打包後也要用 `.app` 內的執行檔再跑一次（路徑含空格）。
- **測圖片 diff**：做一個「同一個 commit 同時改一個文字檔和一個 PNG」的小 repo 再跑 self-test，例如複製 `src-tauri/icons/32x32.png` 後換成 `64x64.png` 並 commit。
- **host 的測試**：`cd app && npm test`（目前 57 個；sidebar 6 個；theme 5 個；gitops 38 個在臨時 repo 上用真的 git 測所有寫入操作、data-loss 警告與全域作者同步，`GIT_CONFIG_GLOBAL` 指向臨時檔，不會動到你的全域設定；settings 的測試需要先 `npm run compile-src` 產生上游 `out/config.js`，沒有就略過）。
- **App 單元測試**：`cd app/src-tauri && cargo test`（目前 32 個：監看的判斷與真正的 FSEvents（被忽略的檔案不刷新、一陣變動只回報一次、linked worktree 裡的 commit 與主 repo 的分支都會回報）、子 repo 掃描、最近清單、工作目錄讀檔與路徑限制、git 解析與執行、operation state、URL 過濾與 shell/AppleScript 跳脫、askpass 的 token/目錄權限/連線中斷/殘留清理/只送給發出請求的視窗、state.json 的合併寫入與損毀處理、settings.json 逐 key 改寫且不覆蓋無法解析的手動編輯、repo 設定只寫固定路徑且不經過 symlink）。
- **模擬從 Finder 啟動**（PATH 只有系統目錄）：`env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin GG_SELFTEST=1 target/debug/git-graph-app <repo>`。
- **引擎測試**：`cd vendor/vscode-git-graph-rs && cargo test -p git-graph-core`（PoC 時 147 個全過）。
- **效能基準**（git/git，8.6 萬個 commit，release 版，暖機後）：`loadCommits`（300 筆）約 85ms，同樣查詢 `git log` 要 600ms；首屏約 155–190ms；啟動時的 `loadConfig` 會呼叫引擎 `authors`（約 600ms），排在 `loadCommits` 之後，不影響首屏；`.app` 12 MB（只有 arm64；diff 視窗的 4.8 MB bundle 經 Tauri 壓縮後約佔 1 MB）。之後的改動不應讓這些數字明顯變差。

## 已知坑與慣例

- **改了 `app/ui/*` 一定要重新 `cargo build`**：前端是在編譯時嵌入執行檔的。
- **上游 webview 在 `window` 的 `load` 事件才初始化**（`web/main.ts`）。`host/main.js` 動態載入 bundle 之後，會補發一次 `load` 事件，不能拿掉。
- **引擎的錯誤是放在回應內容裡**：回應只有 `{"error": "Kind: message"}` 時代表失敗，由 `host/main.js` 的 `engine()` 轉成 throw。一般的成功回應也可能帶 `error: null` 欄位，不能把它當成失敗。
- **不要直接修改 `vendor/`**：用 shim、`host/`、`theme.css` 來適配。真的非改上游不可時，改成 patch 檔並在這裡記錄，好讓升級 submodule 時能重新套用。
- **host 走路線 (b)：自己寫，不沿用上游 `src/`**。只參考 `vendor/.../src/types/*.ts` 的協定型別（86 種請求，目前全部有 handler），以及 webview 端如何使用回應（`web/main.ts` 的 `handleResponseMessage`）。**不要看 `src/dataSource.ts`、`src/gitGraphView.ts` 的實作**，git 參數一律自己組。
  - 型別速查：`node <script> vendor/.../node_modules/typescript src/types/messages.ts '^Request'`，用 TypeScript compiler API 列出介面欄位。不要用 sed 去註解，單行的 `/** */` 會讓它刪錯段落。
  - webview 收到寫入的回應後會**自己**重新整理，host 只要回 `error`（或 `errors[]`）即可。
- **引擎的方法和參數**：看 `native/core/src/dispatch.rs`（約 40 個方法）。
- **handler 慣例**：`reads.js`、`gitops.js`、`app.js` 都是純模組，不碰 `window` 和 Tauri，形式是 `(ctx, msg) => response | null`（null 表示不需回應）。`ctx` 由 `host/main.js` 的 `contextFor()` 提供：`repo`、`git`、`engine`、`terminal`、`saveDialog`、`operationMarker`、`codeReviews`、`config()`（目前的 view config）、`store`、`system`、`settings`（`write(key, value)`）。新 handler 寫在對應模組，`gitops.js` 的部分要在 `app/tests/` 加測試。
- **gitops.js 的安全規則**：webview 傳來的值會進 git 的 argv，一律先過 `unsafe()`，以 `-` 開頭就拒絕，防止被當成選項（例如 `--upload-pack=…`）。路由只接受這個視窗的 repo 集合（`windowRepos`）裡的 `msg.repo`，見「repo 與視窗」。
- **data-loss 警告**（`gitops.js` 的 `lossOf`、`guarded`）：協定裡帶 `confirmed` 的 6 種請求（`branchFromStash`、`checkoutBranch`、`checkoutCommit`、`createBranch`、`pushBranch`、`resetToCommit`）在沒有 `confirmed` 時先檢查，會丟資料就回 `{ command: 'lossWarning', message, retry }`，不執行；webview 顯示它的警告對話框，使用者按繼續就重送 `retry`（原請求加 `confirmed: true`）。判斷依 git 的語意自己寫（路線 (b)）：
  - 離開 detached HEAD（checkout commit/branch、建立並 checkout 分支、stash branch）時，HEAD 上有不在任何分支、tag、remote-tracking 分支裡的 commit。
  - reset 讓目前分支的 commit 不在其他 ref 上（detached 時同上一條）；hard reset 時已追蹤檔案有未 commit 的修改（`git status --porcelain --untracked-files=no`）。
  - `createBranch` 的 `force` 移動既有分支，讓它的 commit 不在其他 ref 上（`rev-list <branch> --not <target> --exclude=<branch> --branches --tags --remotes`）。
  - force／force-with-lease push 時，remote-tracking 分支上有本地分支沒有的 commit（以上次 fetch 的狀態為準）。
  - 訊息是 **HTML**（上游 `dialog.ts` 的 `showDataLossWarning` 直接插入），分支、remote 名稱一律 `escapeHtml`；依 `config().interfaceLanguage` 用英文或簡體中文，多個原因以 `<br>` 分行。檢查只讀；值先過 `unsafe()`，不安全的值不檢查、照原本的錯誤回應。
- **gitops.js 一律設定 `GIT_EDITOR=true`**：沒有終端機可以編輯，所以 `rebase --continue`、`commit --squash`、`merge --no-ff` 直接採用預設訊息。互動式 rebase 改成在 Terminal.app 執行（`system.rs` 的 `open_terminal`）。
- **改寫歷史（drop commit、改舊 commit 訊息）用 `rewriteFrom()`**：自己產生 rebase todo，透過環境變數 `GG_TODO` 傳給 `GIT_SEQUENCE_EDITOR`；新訊息與作者也走環境變數（`GG_MESSAGE`、`GG_AUTHOR`），由 `exec git commit --amend` 讀取，所以特殊字元不必跳脫。範圍內有 merge commit 時會拒絕，避免把歷史攤平。
- **diff 視窗（Monaco）**：
  - Monaco 0.53 起 AMD 版已停止支援，只能用 ESM 版搭配 bundler。進入點是 `monaco-editor/editor`、`monaco-editor/features/register.all`、`monaco-editor/languages/definitions/register.all`（0.56 起提供）。**不要**引入 `languages/features`：那是 TS/CSS/HTML/JSON 語言服務，光 `ts.worker` 就 6.7 MB，而 diff 只需要語法上色。
  - worker 透過 `self.MonacoEnvironment.getWorker` 指向 `diff-dist/editor.worker.js`（打包成獨立的 classic worker）。self-test 會攔截 Monaco 的 worker 警告；有警告就視為失敗。
  - 視窗要顯示什麼由主視窗算好（`diffspec.js`），經 `open_diff_window` 用 `initialization_script` 注入成 `window.__GG_DIFF_SPEC`。不放在 URL query 裡，避免編碼與長度問題。內容由 diff 視窗自己讀：revision 走引擎的 `loadCommitFile`/`fileBytes`，工作目錄走 `worktree_file`（拒絕 `..`、絕對路徑，以及指向 repo 外的 symlink；超過 50 MB 不載入）。
  - **webview 的慣例**：`fromHash === toHash` 代表「那一個 commit」（父 commit ↔ 它）；`*` 代表 HEAD ↔ 工作目錄。A/U 狀態的檔案左側為空，D 狀態右側為空。
  - 版面偏好（左右對照或 inline、忽略空白）存在 diff 視窗的 `localStorage`（`gg.diffPrefs`）。
  - **Esc 關閉視窗**（`diff/main.js` 的 `keydown`）：Monaco 處理過的按鍵會 `preventDefault`（例如關閉搜尋框、取消多重游標），這時不關；輸入法組字中（`isComposing`）也不關。不要改成 capture 階段，否則會搶在 Monaco 之前。
- **repo 與視窗**（側欄）：
  - **側欄的清單**存在 `state.json` 的 `sidebar`（`{ repos, collapsed }`），所有視窗共用；某個視窗改了，其他視窗經 `state-changed` 跟著更新（`sidebarChangedElsewhere`）。第一次（沒有這個 key 時）用最近清單的 repo 當初始內容。每個視窗一次顯示其中一個 repo（`repoRoot`），全域記住最後顯示的（`lastActiveRepo`），下次沒帶路徑啟動就開它；打不開的（例如外接磁碟沒接上）跳過並在側欄變淡。
  - **切換**：送上游的 `loadRepos`，帶完整的 repo 集合和 `loadViewTo: { repo }`（`showInView`），webview 自己切過去；webview 送來新 repo 的 `loadRepoInfo`/`loadCommits` 時，host 才把 `repoRoot` 改過去（`shown`：標題、側欄、`lastActiveRepo`、`repo_opened`）。不要直接改 `repoRoot`，否則 host 和 webview 會不一致。
  - **加入**：側欄的 ＋、File > Open Repository…（⌘O）、Open Recent、命令列的路徑、從 Finder 拖到視窗上或 Dock 圖示上（或 `open -a "Git Graph" <資料夾>`）的資料夾都會加進清單並在目前的視窗顯示（`addAndShow`）。前端一律經 `openHere` 排隊：view 還沒載入時一次只做一個 `start`，開機途中送來的資料夾等它完成再加。路徑在某個 repo 裡就加那個 repo；否則往下掃最多 3 層（`repos.rs` 的 `scan`：找到的 repo 不再往裡面找，略過隱藏資料夾、`node_modules`、`target`、`build`、`dist`），找到的全部加入。Rust 的 `open_folder` 選目標視窗的順序：正在顯示它的 → 有焦點的 → `main` → 任何一個，送 `open-repo` 給它；沒有任何視窗才開新的。
  - **Finder 與 Dock**：拖到視窗上是 Tauri 的 drag-drop 事件（`getCurrentWebview().onDragDropEvent`）。拖到 Dock 圖示、`open -a` 是 macOS 的 Opened 事件（`main.rs` 的 `opened`）：`main` 的頁面還沒呼叫 `initial_repo` 前先存在 `Launch`，由 `initial_repo` 一起回傳（所以它回傳的是清單）；之後直接走 `open_folder`。Dock 圖示要接受資料夾，靠 `Info.plist` 的 `CFBundleDocumentTypes`。self-test 只能模擬拖到視窗；Opened 要用打包好的 `.app` 測（`open -n --env GG_DATA_DIR=… -a <.app> <資料夾>`；正在執行時 `open -a` 會送給同一個 bundle ID 的 App，可能是 /Applications 那份，先把它關掉）。
  - **移除**（右鍵選單）：移除目前顯示的 repo 時改顯示接替它位置的那一個（`removeRepo`）；清單空了就重新載入成起始畫面（`sessionStorage` 的 `gg.reopen` 設成空字串，避免又開回命令列的路徑）。
  - **排序**：拖拉側欄的項目（`sidebar.js` 用 pointer 事件自己做，移動超過 4px 才算拖拉，否則是點擊；Esc 取消）。**不用 HTML5 drag and drop**，Tauri 的檔案拖放處理會攔走它。新順序經 `moveRepo` 存回 `sidebar.repos`，其他視窗跟著變。`repo_opened` 比對清單時不看順序，所以排序不會重建監看。
  - **收合**：側欄的按鈕、View > Toggle Sidebar（⌃⌘S）。收合時上游的 repo 下拉選單會回來（`sidebar.css` 只在側欄展開時隱藏 `#repoControl`），左上角出現展開按鈕。
  - **版面**：上游的 `body` 佔滿視窗，浮動元件大多是掛在 `body` 下的 `position:fixed`、靠右對齊。側欄是另一個固定在左邊的元素；`sidebar.css` 只把 `#view`、`#cdv.docked` 的 `left` 改成 `--gg-sidebar-offset`，置中的 `.dialog` 跟著偏移，靠右的 widget 限制最大寬度。上游把 commit 的右鍵選單掛在 `#view` 裡、用「游標減 `#view` 左緣」定位，但選單是 `position:fixed`（相對視窗），所以 `#view > .contextMenu` 要補上 `margin-left: var(--gg-sidebar-offset)`，否則會往左偏一個側欄寬、被側欄蓋住。不要用 transform 讓 `body` 變成 fixed 元素的 containing block，否則用 `clientX` 定位的右鍵選單會偏掉。
  - **ahead/behind**：`git rev-list --left-right --count @{upstream}...HEAD`，啟動時算全部，檔案監看回報某個 repo 變動時重算那一個（不受 `ECHO_MS` 影響，所以自己 push 之後也會更新）。沒有 upstream 就不顯示。
  - **路由**接受側欄清單裡任何一個 repo（`windowRepos`）。
  - **webview state 依視窗分開存**（`shim.js` 經 `window.__ggStore` 存在 `state.json` 的 `webviewState:window:<label>`），由 `host/main.js` 在載入 bundle 前設定 `window.__ggStateFolder`。
  - **視窗**：`main` 是設定檔裡的第一個視窗，其他是 `repo-N`。⌘N 開新視窗（顯示最後看的 repo）；側欄的 Open in New Window 用 `open_new_window`，以 `initialization_script` 帶入 `window.__GG_OPEN_REPO`。只有 `main` 會讀命令列的路徑（`initial_repo`）。`repo_opened` 在顯示的 repo 或清單改變時呼叫；只有清單變了才重建監看。視窗關閉時，`WindowEvent::Destroyed` 會一併停掉它的監看。
  - **選單**：用 `Menu::default` 再往 File 插入 New Window（⌘N）、Open Repository…（⌘O）、Open Recent。**不要整個自建選單而漏掉 Edit**，否則輸入框的 ⌘C/⌘V 會失效。
  - **最近清單**：`~/Library/Application Support/dev.kigi.gitgraph/recent.json`，最多 10 筆（每次顯示 repo 就更新），不存在的路徑會自動略過；`GG_DATA_DIR` 可改放到別處。
- **檔案監看**（`watch.rs`）：
  - 事件先合併 300ms 再判斷。`.git` 裡只有 HEAD、refs、packed-refs、index、config 和進行中操作的標記檔算數（objects、logs、`*.lock` 都忽略）；工作目錄的變動用 `git check-ignore --stdin` 過濾。路徑歸屬於包含它的最深一層 repo。找不到 git 時，所有工作目錄的變動都算數。
  - **linked worktree 與 submodule**：`.git` 是指向別處的檔案（`repo.rs` 的 `git_dir`），所以另外監看它的 git dir（`main/.git/worktrees/<名稱>`）和 `commondir` 指向的共用 git dir（`watch.rs` 的 `Repo`；已在監看範圍內的目錄不重複監看）。git dir 裡的 HEAD、index、進行中操作的標記只算那個 worktree 的；共用 git dir 裡只有 refs、packed-refs、config 算所有用它的 repo 的（主 repo 的 HEAD、index 不影響 worktree）。`main/.git/worktrees/…` 的變動不會刷新主 repo。
  - **前端去重**：`host/main.js` 只在變動的 repo 正是目前顯示的 repo 時才送 `refresh`。git 寫入操作執行中，以及結束後 1 秒內的事件都忽略（`ECHO_MS`），因為 webview 操作完會自己刷新；讀取類的 handler（`gitops.js` 的 `READ_COMMANDS`）不會觸發這個忽略。
  - gitops 執行的 git 一律帶 `GIT_OPTIONAL_LOCKS=0`（`gitops.js` 的 `exec()`），避免 `git diff` 之類順手改寫 index 而觸發監看，進而無限刷新。
- **上游現成的 stub host 參考**：`vendor/.../tests/browserRepro/generate.mjs`。
- **gix 不支援 push、fetch**：所有寫入操作一律走 `git` CLI（上游原本的做法也一樣）。
- **呼叫 git 一律走 `git_exec`**：handler 裡用 `ctx.git(args, opts)`（gitops.js 內部再包一層 `exec()`/`run()`）；`host/main.js` 的 `git(cwd, args, { env, timeoutMs, id, onOutput })` 是底層實作。不要另外開路徑。
  - 回傳 `{ exitCode, stdout, stderr, timedOut, cancelled, durationMs }`。git 回非 0 不算 reject，要自己檢查 `exitCode`；只有 git 根本無法啟動時才會 reject。
  - 有傳 `onOutput` 才會即時串流，例如 fetch、push 的進度。大量輸出的讀取不要開串流，否則同一份資料會在 IPC 上傳兩次。
  - 有傳 `id` 才能用 `invoke('git_cancel', { id })` 取消；同一個 id 同時只能有一個執行。
- **git 的選擇順序**：`GIT_GRAPH_GIT` → `PATH`（略過 `/usr/bin/git`）→ Homebrew → `/usr/bin/git`。`/usr/bin/git` 只有在 `xcode-select -p` 成功時才採用。結果在每個 process 只解析一次。
- **每次執行 git 都在獨立的 process group**：逾時或取消時用 `killpg` 連同 hook、ssh 等子程序一起終止，避免 pipe 被佔住而卡死。
- **帳密提示一律走 askpass**（`askpass.rs`）：`git_exec` 會為每次執行加上 `GIT_ASKPASS`/`SSH_ASKPASS`（都指向 App 執行檔本身）、`SSH_ASKPASS_REQUIRE=force`、`GG_ASKPASS_SOCKET`、`GG_ASKPASS_TOKEN`；呼叫端自己給的同名變數優先。`GIT_TERMINAL_PROMPT=0` 保留，確保不會在終端機提示。
  - **helper 模式**：`main()` 一開頭就檢查 `GG_ASKPASS_SOCKET`，有就當 helper 執行完立刻結束。不要在那之前加任何初始化。
  - **安全**：socket 放在權限 0700 的臨時目錄，請求必須帶 token，token 不符就不會顯示。提示文字來自遠端，前端只能用 `textContent` 顯示。
  - **只送給發出請求的視窗**：token 依視窗分開（`Askpass::env(label)`，`git_exec` 傳入呼叫它的視窗），伺服器用 token 找出視窗，`emit_to` 給它；前端用 `getCurrentWindow().listen`。那個視窗已經關掉時直接回沒有答案（git 立刻失敗，不等 5 分鐘）。
  - **生命週期**：helper 寫完請求後只讀不寫，所以伺服器把連線讀到 EOF 視為 helper 已死，自動送出 `close` 關掉對話框。不要在 helper 端 `shutdown(Write)`。未回答的提示 5 分鐘後放棄。
  - **Keychain**：Apple git 和 Homebrew git 的系統設定都有 `credential.helper=osxkeychain`，所以只有 Keychain 裡沒有帳密時才會問；登入成功後 git 會自己存進 Keychain。
  - **殘留目錄**：`$TMPDIR/gg-askpass-<pid>-*` 在下次啟動時，若該 pid 已不存在就會被清掉。
- **主題**（`theme.js`、`theme.css`）：
  - 外觀有四種：淺色/深色 × 系統的「增加對比」（`prefers-contrast: more`，WebKit 支援）。`theme.js` 依 media query 在 `<html>` 設 `gg-dark`、`gg-contrast`（`theme.css` 只看這兩個 class，不寫 media query，測試才能強制切換），並在 `<body>` 設 VS Code 的 class：`vscode-light`、`vscode-dark`、`vscode-high-contrast`，淺色高對比則是 `vscode-high-contrast` 加 `vscode-high-contrast-light`（上游 `body.vscode-high-contrast` 的 muted 色是給深色用的白色半透明，`theme.css` 在兩個 class 同時存在時改成黑色）。
  - **View > Appearance**（System／Light／Dark）：Rust 的 `app.set_theme`（macOS 上是整個 App），存在 `state.json` 的 `appearance`，啟動時套用。WebKit 把它當成 `prefers-color-scheme`，頁面不用另外處理。
  - diff 視窗的 Monaco 主題：`vs`、`vs-dark`、`hc-light`、`hc-black`。**改了 `app/diff/main.js` 要先 `npm run build:diff`**（或 `prepare-ui.mjs`），再 `cargo build`。
  - **強調色**：`AccentColor` 在 WKWebView 會解析成系統強調色（預設的多色是 `rgb(0, 122, 255)`），但 `AccentColorText` 會解析成黑色，所以強調色上的文字（按鈕、選單選取項目）固定用白色，和 macOS 一致。換成其他強調色時是否即時跟著變，還沒驗證。
  - 改 `theme.css` 後跑 `node --test tests/theme.test.mjs`：文字 4.5:1、增強對比時主要文字 7:1、邊框 3:1。上游 graph 線條的預設色盤（`graph.colours`）不在檢查範圍。
  - **上游從 `<html>` 的 inline style 讀部分 token**（`web/utils.ts` 的 `getVSCodeStyle`，因為 VS Code 把變數注入在那裡）：字型、`--vscode-editor-findMatchHighlightBackground`（搜尋結果與跳轉閃爍的顏色）、`--vscode-selection-background`。`theme.js` 每次換外觀時把它們從計算後的值複製到 inline style。少了這一步，搜尋結果完全不會標記。新增上游會讀的 token 時，要確認它是走 CSS 還是 `getVSCodeStyle`。
  - **graph 的線條在視窗縮放後消失**（只剩節點，滑鼠移到節點上才重畫出來）：WebKit 的繪製 bug，出在上游包住整個 graph 的 SVG `<mask>`（`graph.ts` render 的 `mask="url(#GraphMask)"`，只用來在 graph 比欄位寬時淡出右邊緣），DOM 本身沒變。`theme.css` 用 `#commitGraph g[mask] { mask: none }` 關掉它，改用 CSS `mask-image` 在 svg 最右 10px 淡出。self-test 會檢查這兩條規則還在；要看實際畫面用 `preview.sh` 的 `resize` 場景（線性的 repo 最明顯）。
  - 上游自己的控制元件邊框寫死成 `rgba(128,128,128,0.5)`，不受主題影響。增強對比時，`theme.css` 把可操作元件（核取方塊、按鈕、下拉選單、對話框與其輸入框、ref 標籤、工具列下緣）的邊框改成 `--vscode-contrastBorder`；純裝飾的分隔線不動。
  - 已截圖確認：淺色（主畫面、設定、右鍵選單、對話框、搜尋、diff）、深色（搜尋）、淺色與深色增強對比（設定、右鍵選單、對話框、diff）。
  - **介面語言是英文與繁體中文（臺灣）**，沒有簡體：
    - 上游 webview 只有 `en` 與 `zh-cn` 兩套字典，程式也只認這兩個值。`prepare-ui.mjs` 在複製出的 `out.min.js` 上把 zh-cn 字典轉成臺灣正體（`vendor/` 不動）：esbuild 把非 ASCII 寫成 `\uXXXX`，所以以「引號、反斜線、換行」為界切出文字片段，含中文的才解碼（只解 U+0080 以上，引號等跳脫不動）、`toTaiwanese()`、再編碼回去；程式碼是 ASCII，不受影響。語言名稱改成「中文（繁體）」，Auto 的說明改成跟隨系統（英文是 `Auto (follows the system)`）。轉完會檢查：替換都發生、沒有殘留的簡體專用詞，否則建置失敗（升級 submodule 時要注意）。
    - 用語：OpenCC `cn → twp`，再套 `scripts/zh-tw.mjs` 的 `TAIWAN_TERMS`（儲存庫、簽出、重定基底、參照、提取要求、儲藏、套用、本機、目前、篩選、「」引號……）。翻譯不順時改那張表，不要改 vendor。
    - 設定值：`settings.json` 的 `interfaceLanguage` 是 `auto`／`en`／`zh-tw`（舊的 `zh-cn` 視為 `zh-tw`）；給 webview 的 config 一律是 `zh-cn`（`settings.js`），webview 送來的 `setInterfaceLanguage: 'zh-cn'` 存成 `zh-tw`（`app.js`）。`auto` 遇到任何中文系統語言都用繁體。host 自己的中文字串（`sidebar.js`、`gitops.js` 的 data-loss 訊息）key 仍是 `zh-cn`，內容是繁體。
- **`initialState.backend.gitCliAvailable` 依 `invoke('git_info')` 的結果設定**：找不到 git 時，webview 會隱藏寫入操作。
- **狀態與設定**（`state.rs`，都在 `~/Library/Application Support/dev.kigi.gitgraph/`，`GG_DATA_DIR` 可改）：
  - `state.json`：`host/main.js` 的 `store`（repo state、global/workspace view state、code review、`lastActive:<folder>`）以及 `shim.js` 的 webview state（`webviewState:<folder>`）。每個視窗在 boot 前用 `state_snapshot` 拿一份到記憶體，讀取是同步的；`store.set` 經 `state_set` 更新，Rust 合併 300ms 後原子寫入，結束時再 flush，並發 `state-changed` 給其他視窗。webview 捲動時會頻繁 `setState`，`shim.js` 會再 debounce 300ms。`store.set(key, null)` 代表刪除。
  - 舊版存在 `localStorage` 的 `gg.*` 會在第一次啟動時搬過去（`migratedFromLocalStorage`）；`gg.diffPrefs` 屬於 diff 視窗，留在原處。**`localStorage` 不受 `GG_DATA_DIR` 影響**，所以設了 `GG_DATA_DIR` 時 Rust 會先標記成已搬移，self-test 才不會把真正的資料搬進臨時目錄。
  - `settings.json`：key 沿用上游 extension 設定、去掉 `git-graph-rs.` 前綴（`"graph.style": "angular"`），可以手動編輯（Settings Widget 的 Open Extension Settings 會用文字編輯器打開它）。每次都重新讀檔，逐 key 改寫；檔案無法解析時拒絕寫入、不覆蓋，並以預設值執行。經 App 改動會發 `settings-changed`；手動編輯在視窗取得焦點時生效。
  - **config 的計算**：`settings.js` 的 `configFrom(預設值, settings, { language })`，預設值是 `prepare-ui.mjs` 產生的 `__GG_DEFAULT_CONFIG`。支援 Settings Widget 能改的 24 個設定、`commitAuthors`、`interfaceLanguage`，以及只能寫在 `settings.json` 的對話框預設值（`dialog.*`，23 個）和 Commit Details View（`commitDetailsView.*`，4 個：位置、檔案樹或清單、壓縮資料夾、自動置中）；未知、無效、App 不提供的值會略過並記 log。`dialog.merge.squashMessageFormat`、`dialog.pullBranch.squashMessageFormat` 不支援：它們是 host 端的行為，「Default」是上游 `src/dataSource.ts` 產生的訊息（路線 (b) 不能看），App 一律用 git 自己的 `.git/SQUASH_MSG`（`gitops.js` 的 `commitSquashed`）。改 `commitDetailsView.location` 時，已經打開的詳細資料留在原處，下次打開才換位置。對應關係是自己寫的（路線 (b)），由 `tests/settings.test.mjs` 對上游 `out/config.js` 黑箱比對，升級 submodule 後要跑。
  - **套用**：config 改變時送 `configChanged`（webview 會原地套用並軟刷新）。webview 會改動拿到的 config 物件，所以一律給複本，比對變化用 host 自己存的 JSON（`configJson`），否則每次聚焦都會多刷新一次。**介面語言只在 webview 啟動時讀取**，所以語言改變時重新載入頁面，資料夾經 `sessionStorage` 的 `gg.reopen` 帶過去。
  - App 不提供而只能關閉的設定（`settings.js` 的 `UNAVAILABLE`）：avatar、pull request、`repository.trackRemoteTags`（會改 repo 的 git 設定）。
  - `commitAuthors` 存檔後會同步全域作者（`gitops.js` 的 `syncGlobalAuthor`）：還沒有全域作者時設為第一位；全域作者原本是清單中的某一位而被改掉或刪除時跟著改（全刪則 unset）；**不在清單裡的全域作者是使用者自己的，不會覆寫**。
  - host 讀 config 的地方：`reads.js` 的 `showRemoteHeads`、`showUncommittedChanges`、`showUntrackedFiles`；`enableLog` 開啟時 `host_log` 也寫進 `session.log`（每次啟動清空，Settings Widget 的 View Session Log 會打開它）。
- **Export Repository Configuration**（`repoconfig.js`）：把 repo state 裡適合共用的欄位（排序、隱藏的 remote、issue linking、PR 設定、各種 override 等；不含 pinned、欄寬、面板配置）寫到 `.vscode/vscode-git-graph.json`，加上 `exportedAt`。repo 沒有自己的 issue linking 時匯出全域的。開啟 repo 時若檔案的 `exportedAt` 比 `lastImportAt` 新，就合併進 repo state（無效的欄位略過）。這是自己設計的格式，**沒有和 VS Code 版比對過相容性**。寫檔走 `export_repo_config`，只接受這一個路徑。
- **事件要指定視窗**：Rust 的 `emit` 和 `window.emit` 都會送給**所有**視窗，JS 的 `event.listen()` 也會收到送給任何視窗的事件。只給單一視窗的事件（`open-repo`、`menu-command`、`askpass`）在 Rust 用 `app.emit_to(label, …)`，JS 用 `getCurrentWindow().listen`。
- **選單指令**：App 選單的 Settings…（⌘,）、View 選單的 Refresh（⌘R）、Find…（⌘F）、Show HEAD Commit（⌘J，因為 webview 的 ⌘H 被系統的「隱藏」佔走）、Fetch from Remotes（⌘⇧F）、Toggle Sidebar（⌃⌘S）。Rust 送 `menu-command` 給取得焦點的視窗，`host/main.js` 的 `MENU_COMMANDS` 轉成 webview 自己的按鈕點擊，或依 `config.keybindings` 合成 ⌘＋鍵的 keydown（選單的快捷鍵會先攔下按鍵，再這樣交還給 webview）。
- **尚未實作的行為**：
  - 設定涵蓋 Settings Widget 的那些、對話框預設值與 Commit Details View（見「狀態與設定」），其餘上游設定（快捷鍵、`graph.colours`、欄位、`repository.onLoad.*` 等）還沒接；`repository.trackRemoteTags`、avatar、pull request 只能關閉。
  - `includeCommitsMentionedByReflogs` 被忽略，因為引擎不支援，CLI fallback 也還沒做。
  - commit/tag 簽章驗證：決定不做（沒有簽 commit 的需求）。引擎只回報簽章存在，狀態一律是「無法檢查」；`repository.commits.showSignatureStatus` 也沒接，所以介面不顯示簽章。
  - avatar 已在設定中關閉。
- **不上 Mac App Store**：App Sandbox 會擋掉執行 `git` 和存取 `~/.ssh`。最低支援 macOS 13。
- **簽章（個人使用，沒有 Apple Developer 帳號）**：`tauri.conf.json` 的 `bundle.macOS.signingIdentity` 是 `"-"`，也就是對整個 bundle 做 ad-hoc 簽章（識別碼 `dev.kigi.gitgraph`、封存資源、hardened runtime），不做 notarization。
  - 沒有這個設定時只會有 linker 自動加的簽章：識別碼是隨機的、Info.plist 沒綁定，`codesign --verify` 會失敗。`build-app.sh` 會檢查 `codesign --verify --deep --strict` 和識別碼。
  - `spctl` 會回 rejected，這是正常的。Gatekeeper 只檢查帶 `com.apple.quarantine` 的檔案，本機建置的沒有。若把 `.app`／dmg 經網路或 AirDrop 傳到另一台 Mac，會被說「已損毀」，要在那台執行 `xattr -dr com.apple.quarantine "/Applications/Git Graph.app"`。
  - ad-hoc 簽章每次建置的 cdhash 都不同，所以 macOS 可能在每次重新建置後再問一次權限（例如互動式 rebase 用 AppleScript 控制 Terminal）。不想被重複詢問時，可以在 Keychain Access 建一個自簽的「程式碼簽署」憑證，用 `APPLE_SIGNING_IDENTITY="<憑證名稱>" app/scripts/build-app.sh` 簽（Tauri 的環境變數會覆蓋設定檔），識別就會跨建置固定。目前沒做。
  - hardened runtime 下的 `.app` 已驗證：多 repo self-test、HTTP 帳密、從 Finder 啟動（PATH 只有系統目錄）都通過。
  - 如果以後要公開散布：申請 Developer ID 後，`signingIdentity` 改成憑證名稱，加上 `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` 做 notarization（還要先完成 Stage 2，見授權限制）。

## Stage 1 路線圖（自用版，估 4–6 週）

| # | 工作 | 狀態 | 要點 |
|---|---|---|---|
| 0 | PoC：Tauri 殼、`engine_request`、webview 畫出 graph | ✅ 完成 | 已支援：loadRepoInfo、loadCommits、commitDetails（commit/stash/uncommitted）、commitFileCounts |
| 1 | `git_exec` Rust command（cwd、env、逾時、stdout/stderr 串流、取消） | ✅ 完成 | `src/git.rs` + `host/main.js` 的 `git()`；串流用 Tauri `Channel`；process group 確保能完全終止；用法見「已知坑與慣例」 |
| 2 | 讓 host 涵蓋完整協定 | ✅ 完成（路線 b） | 86 種請求全部有 handler：引擎讀取、42 種 git 寫入與 CLI 讀取、App 層動作。PR、Gerrit、Source Control view 目前回傳「尚未支援」。尚未實作的行為見「已知坑與慣例」 |
| 3 | 主題細修 | ✅ 完成 | 淺色、深色、增強對比（淺/深）四種外觀的 token 都通過 WCAG 對比測試並截圖確認；上游的 high-contrast class 已接上；View > Appearance；Monaco 主題跟著變；強調色上的文字改成白色；修好搜尋結果不會標記（inline token）。沒驗證：換成其他系統強調色時是否即時跟著變 |
| 4 | Repo 管理：開啟資料夾、最近清單、多視窗、子 repo 掃描、檔案監看 | ✅ 完成 | 監看（FSEvents，過濾 .git 雜訊與被忽略的檔案，自己的操作不重複刷新）、左側的 repo 側欄（共用清單、切換、ahead/behind、收合）、子 repo 掃描、最近清單（起始畫面與 File > Open Recent）、多視窗（⌘N、Open in New Window），也涵蓋 linked worktree 與 submodule（git dir 在別處）；從 Finder 把資料夾拖到視窗或 Dock 圖示上、`open -a` 都能開 |
| 5 | Diff 檢視（取代 VS Code diff editor） | ✅ 完成 | Monaco 0.57 diff editor 開在獨立視窗：文字 diff（左右對照或 inline、上一個/下一個變更、忽略空白、依副檔名上色、跟隨淺色/深色）、單一檔案、比較分頁（左側檔案清單）、圖片並排、其他二進位檔比大小。`openExternalDirDiff`（`git difftool -d`）也可用。細節見「已知坑與慣例」 |
| 6 | 認證：GIT_ASKPASS helper、osxkeychain、ssh-agent | ✅ 完成 | `askpass.rs` + `host/askpass.js`；HTTPS 帳密、ssh passphrase 與 host key 確認都走 App 內的對話框；Keychain 與 ssh-agent 照常運作（git/ssh 只在它們沒有答案時才問）。細節見「已知坑與慣例」 |
| 7 | 設定與狀態存檔、選單列、快捷鍵、命令 | ✅ 完成 | `state.rs` + `settings.js` + `repoconfig.js`：view state 存在 `state.json`（從 `localStorage` 自動搬移）、設定存在可手動編輯的 `settings.json` 並即時套用到所有視窗（語言改變時重新載入）、`commitAuthors` 同步全域作者、匯出／匯入 repo 設定、session log、App 與 View 選單的指令。對話框預設值與 Commit Details View 的設定也能寫在 `settings.json`。尚未支援：自訂 keybindings、其餘上游設定（要手動加進 `settings.js`） |
| 8 | 打包：universal（arm64+x64）、簽章、dmg | ✅ 完成（個人使用） | `scripts/build-app.sh`：ad-hoc 簽章並驗證、dmg（5.6 MB）、安裝到 /Applications（只會取代識別碼相同、而且沒在執行的舊版）。不做 notarization（沒有開發者帳號）。`--universal` 需要 `rustup target add x86_64-apple-darwin`，**還沒實際建置過**。細節見「已知坑與慣例」的簽章 |

協定以外的請求會在 log 印出 `unhandled webview request: <command>`；升級上游 submodule 後，若出現這行，代表有新的請求種類要補。

## Stage 2（只有決定公開散布才做，估 2.5–4 個月）

clean-room 重寫：UI 用 Svelte 或 React，graph 用虛擬捲動的 Canvas/SVG，lane 配置演算法自己實作；host 改成 Rust，重新設計協定，寫入操作由 Rust 組 git 參數。Stage 1 的 Tauri 殼、`engine_request`、`git_exec`、askpass、檔案監看、打包流程都能沿用。

**狀態**（2026-11-03 盤點）：還沒開始，沒有任何程式或分支。

**授權**（上游 `LICENSE` 與 `licenses/`）：`native/` 是原創、MIT；`web/`、`src/` 與編譯出的 `out/`、`media/` 屬於 `licenses/LICENSE_GIT_GRAPH`，不能散布衍生作品。`web/utils.ts` 的圖示另有授權（Octicons MIT、vscode-icons CC-BY、Icons8 CC BY-ND），新 UI 自備圖示。上游 `package.json` 的 `"license": "MIT"` 只涵蓋原創部分。

**Stage 1 程式碼的去向**：

| 處理 | 項目 |
|---|---|
| 直接沿用 | Rust 的 `git.rs`、`askpass.rs`、`watch.rs`、`state.rs`、`system.rs`、`repos.rs`、`repo.rs`、`diff.rs`；diff 視窗（`diff/main.js`、`diff.html`，輸入格式要調整）；`build-app.sh`、`build-diff.mjs` |
| 改寫後沿用 | `gitops.js`：依 git 語意自己寫（路線 (b)），寫入的參數與 data-loss 警告可以照搬成 Rust，測試一起搬。`sidebar.js`、`askpass.js` 的元件（`sidebar.css` 是針對上游 DOM 寫的）。`settings.js`（key 與值對應的是上游設定與 view config，要自訂設定格式）。`theme.js` 與 `theme.test.mjs` 的 WCAG 檢查方法（`--vscode-*` token 只是為了上游 CSS） |
| 丟掉 | `media/out.min.*`、`shim.js`、`prepare-ui.mjs`（複製上游 bundle、轉換上游字典、從 `out/config.js`／`out/extensionState.js` 產生預設值）、`settings.test.mjs`（拿 `out/config.js` 比對）、86 種請求的協定（型別在上游 `src/types/`） |

**要新寫的**（參考：上游 `web/*.ts` 約 18,500 行，`strings.ts` 約 100 KB）：
1. graph（最大的風險）：引擎只給 commit 與父子關係，lane 配置上游放在 webview 的 `graph.ts`（引擎 `graph.rs` 的註解）。要自己設計演算法，可以寫在 App 的 Rust 端以便測試與處理大 repo；加上虛擬捲動（git/git 8.6 萬個 commit）、ref 標籤、選取、鍵盤操作。
2. commit 詳細資料（檔案樹／清單、比較、未 commit 的修改、stash）。
3. 右鍵選單與對話框：分支、tag、remote、stash、merge、rebase、cherry-pick、reset、push／pull／fetch 與進度。
4. 搜尋、分支篩選、欄位、設定畫面、Reflog、Worktree、統計、issue linking、Markdown 與 emoji。
5. 英文與繁體中文的介面文字（不能用上游字典）。
6. host 改成 Rust、重新設計協定（含 `settings`、`repoconfig`）。
7. lane 配置的單元測試；self-test 整套重寫（現在的是操作上游 DOM）。
8. 散布：Developer ID、notarization、自動更新（Tauri updater）、引擎／Monaco／crates 的授權聲明。

**動手前要決定**：
- **clean-room 的界線**：Stage 1 看過 `web/` 的部分行為，這份 CLAUDE.md 也記了上游內部細節（例如 `graph.ts` 的 mask、右鍵選單的定位）。做法：先依 App 實際使用的行為寫功能規格（不寫原始碼細節），實作時只看規格、不打開 `web/`、`src/`，新的說明文件和這裡的上游細節分開。
- **舊資料**：`state.json` 的 repo state、`.vscode/vscode-git-graph.json` 是照上游欄位設計的，換新格式時要決定是否搬移。
- **第一版的範圍**：Gerrit、PR、統計、Worktree 等 fork 才有的功能要不要做，會大幅影響工期。

**評估可行性的第一步**：做一個雛型：自己的 lane 配置演算法加上虛擬捲動的 graph，用 git/git 測。這一步可行，其餘大多是工作量。
