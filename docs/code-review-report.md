# 專案程式碼審查與資訊安全稽核報告

- **審查日期**：2026-11-19
- **審查範圍**：`app/` 全專案原始碼與建置／測試腳本（包含 `app/src-tauri/`、`app/src-tauri/crates/backend/`、`app/src-tauri/crates/remote/`、`app/web/`、`app/diff/`、`app/scripts/`、`app/tests/`、`app/package.json`）
- **授權邊界**：依 `CLAUDE.md` clean-room 規範，本次審查未讀取 `vendor/vscode-git-graph-rs/` 中非 `native/` 之任何檔案。
- **自動化靜態檢查**：
  - `cargo clippy --workspace --all-targets -- -W dead_code -W unused_imports -W unused_variables -W unused_mut`：無 `dead_code` / `unused_*` 警告，回報 10 則 clippy 品質警告（詳見第二章）。
  - `npm run check`（`svelte-check --tsconfig web/tsconfig.json`）：**失敗（2 個錯誤）**，`SettingsView.ts` 的自動產生 import 路徑錯誤（詳見 [QUAL-01](#qual-01-settingsviewts-import-路徑錯誤導致-npm-run-check-失敗)）。

---

## 審查總覽（Executive Summary）

本專案整體工程紀律與安全意識極高：已主動建置了 Tauri v2 視窗 Capability 隔離（`default.json` 與 `diff.json`）、嚴格的 CSP、`filters.rs` 的不可信 Repo Filter 攔截、`inside_repo` 的 canonicalize 防穿越、`unsafe_arg` 的 `-` 前綴防禦、全專案零 `{@html}`、零 `#[allow(dead_code)]`、i18n 雙語 100% 完整對齊。

但在深入逐檔交叉稽核後，仍發現若干**可繞過既有防線的高風險資安漏洞**（包含不可信 `.git/config` 程式碼執行繞過、SSRF 與 curl globbing 驗證繞過、Terminal PTY 控制字元注入、`open_repo_file` 執行檔判定繞過、正式版外洩破壞性測試介面、主執行緒 ReDoS），以及多處 **Stage 1 遺留程式碼、未使用的 API 欄位／依賴與輕微邏輯缺陷**。

| 類別 | 嚴重度 / 分級 | 項目數 |
|---|---|---:|
| 資訊安全（Security） | **High（高風險）** | 9 |
| 資訊安全（Security） | **Medium（中風險）** | 12 |
| 資訊安全（Security） | **Low / Hardening（低風險／縱深防禦）** | 14 |
| 多餘程式碼與品質（Dead Code & Quality） | **建置錯誤與邏輯缺陷** | 6 |
| 多餘程式碼與品質（Dead Code & Quality） | **Dead Code、未使用欄位／依賴與重複程式碼** | 18 |

---

## 一、資訊安全問題（Information Security Findings）

### 高風險（High）

#### SEC-01：`engine_request` 與 `gg-remote` 繞過不可信 Repo 的 Clean/Process Filter 防護
- **位置**：
  - [app/src-tauri/src/main.rs](../app/src-tauri/src/main.rs#L76-L102)
  - [app/src-tauri/crates/remote/src/main.rs](../app/src-tauri/crates/remote/src/main.rs#L104)
  - [app/src-tauri/crates/backend/src/api.rs](../app/src-tauri/crates/backend/src/api.rs#L726)
  - [app/src-tauri/capabilities/diff.json](../app/src-tauri/capabilities/diff.json#L11)
- **問題描述**：
  `gg_backend::api::read` 會透過 `filters::blocking()` 阻擋未經使用者同意（`AllowedFilters`）的不可信 `.git/config` `filter.<name>.clean` / `.process` 執行。然而 `engine_request` 允許 `loadUncommittedDetails` 與 `compareCommits`，並直接呼叫 `gg_backend::engine(&repo, &request)` 或轉發至遠端 `Request::Engine`，**完全未檢查 `AllowedFilters` 或 `filters::blocking()`**；遠端 `Request::Engine` 亦無方法白名單。
- **攻擊情境**：
  當使用者拒絕信任某不可信 Repo 的 filter 時，只要在任何 `diff-*` 視窗（或經由前端／diff 視窗注入）呼叫 `engine_request` 執行 `loadUncommittedDetails` 或 `compareCommits`（`to: ""` 或 `"*"`），引擎 `gix` 就會掃描工作目錄並執行 `.git/config` 指定的任意命令。
- **修復建議**：
  1. 在 `engine_request` 與遠端 `Request::Engine` 強制注入 `AllowedFilters`，凡呼叫涉及工作目錄的方法（`loadUncommittedDetails`、`compareCommits` 且 `from`/`to` 為空或 `*`、`loadCommits` 且 `showUncommittedChanges` 為真）一律先驗 `filters::blocking()`。
  2. 遠端 `Request::Engine` 補上與 `PAGE_ENGINE_METHODS` 相同的唯讀方法白名單，並將 `gg_backend::api::read_engine` 收斂為私有／`pub(crate)`。

#### SEC-02：Git LFS Extensions 繞過 `filters.rs` 的不可信 `.git/config` RCE 防護
- **位置**：[app/src-tauri/crates/backend/src/filters.rs](../app/src-tauri/crates/backend/src/filters.rs#L15), [L57](../app/src-tauri/crates/backend/src/filters.rs#L57), [L119](../app/src-tauri/crates/backend/src/filters.rs#L119)
- **問題描述**：
  `filters::own_filters()` 僅檢查 `^filter\..*\.(clean|process)$`，且將標準 Git LFS 設定（`filter.lfs.clean = git-lfs clean -- %f`、`filter.lfs.process = git-lfs filter-process`）列入白名單。然而 `git-lfs` 執行時會讀取 Repo 內的 `lfs.extension.<name>.clean`（及 `.smudge`）並以 shell 執行（另有 `lfs.customtransfer.<name>.path`）。
- **攻擊情境**：
  惡意壓縮檔或共享磁碟上的 Repo 在 `.gitattributes` 設定 `* filter=lfs`，並在 `.git/config` 寫入 `[lfs "extension.x"] clean = <任意命令>`。由於 `filters::blocking()` 放行標準 LFS，使用者只要打開該 Repo，引擎執行 `loadCommits` → `git-lfs clean` 即自動執行任意系統命令。
- **修復建議**：
  將 `filters_in()` 的查詢正規式擴展為同時檢查 local/worktree scope 下的 `^lfs\.extension\..*\.(clean|smudge)$` 與 `^lfs\.customtransfer\..*\.path$`（或所有 `^lfs\.(extension|customtransfer)\.` 鍵）。

#### SEC-03：`CreateArchive` 未防範 `.git/config` 的 `tar.<format>.command` 執行任意命令
- **位置**：[app/src-tauri/crates/backend/src/ops/stash.rs](../app/src-tauri/crates/backend/src/ops/stash.rs#L38-L44)
- **問題描述**：
  `OpRequest::CreateArchive` 執行 `git archive -o <path> <reference>`，未傳入 `--format=zip` 與 `--`，也未阻擋 Repo 內 `.git/config` 定義的 `tar.<format>.command`。經實測，即使加上 `--format=zip`，只要 `.git/config` 存在 `[tar "zip"] command = <shell cmd>`，Git 仍會覆寫內建 zip 並執行該命令。
- **攻擊情境**：
  使用者對不可信 Repo 執行看似純唯讀的「Create Archive」，即觸發 `.git/config` 中埋藏的 `tar.zip.command` 執行任意命令。
- **修復建議**：
  在執行 `git archive` 前，先比照 `filters.rs` 檢查 local/worktree scope 是否存在 `^tar\..*\.command$` 並拒絕（注意 `-c tar.zip.command=` 無法退回內建 zip），或改用 in-process 方式產出壓縮檔；同時加上 `--format=zip` 與 `--` 分隔符。

#### SEC-04：`fetch_image` 缺少 `curl --globoff` 導致 `image/*` 驗證繞過與請求放大
- **位置**：[app/src-tauri/src/webimage.rs](../app/src-tauri/src/webimage.rs#L22-L35), [L64-L73](../app/src-tauri/src/webimage.rs#L64-L73)
- **問題描述**：
  `webimage.rs` 呼叫 `/usr/bin/curl` 時未傳入 `--globoff` (`-g`)，因此 curl 預設啟用 URL globbing（`{a,b}`、`[1-N]`）。
- **攻擊情境**：
  1. **繞過 `image/*` Content-Type 檢查**：若 URL 為 `http://127.0.0.1:8080/{api/secrets,favicon.ico}`，curl 會依序抓取兩個 URL 並將回應串接至 `stdout`，同時在 `stderr` 各輸出一筆 `@@GG-TYPE@@`。第 64 行使用 `stderr.rsplit_once(TYPE_MARK)` 只驗證**最後一筆**回應的 `Content-Type`（`image/x-icon`），導致第一筆非圖片（JSON/HTML）敏感內容被完整 base64 編碼回傳給 `diff-*` 視窗。
  2. **請求放大**：單一 `http://target/[1-10000].png` 可在僅佔用 1 個 semaphore 的情況下發動上萬次 HTTP 請求或本機埠掃描。
- **修復建議**：
  在 `curl` 參數加入 `"--globoff"`，並在啟動 `curl` 前先以 `tauri::Url::parse` 嚴格驗證 URL 格式與字元。

#### SEC-05：`fetch_image` 與 Markdown 預覽「Load」按鈕之 SSRF 漏洞
- **位置**：
  - [app/src-tauri/src/webimage.rs](../app/src-tauri/src/webimage.rs#L22-L81)
  - [app/diff/main.js](../app/diff/main.js#L231-L234), [L296-L325](../app/diff/main.js#L296-L325)
- **問題描述**：
  `fetch_image` 未對初始 URL 或 `--location --max-redirs 5` 跟隨後的目標位址進行 IP 過濾；前端 `offerRemoteImages` 僅顯示「N 張網路圖片未載入」，未揭露目標主機名稱，按下 **Load** 即同時對文件內所有外部圖片 URL 發起請求。
- **攻擊情境**：
  惡意 Markdown 夾帶正常徽章圖片與隱藏的 `http://127.0.0.1:<port>/...`、`http://[::1]:...`、內網 RFC1918 或 `http://169.254.169.254/...`（或由外部伺服器 302 轉址至 `127.0.0.1`）。使用者按下 Load 後，App 替攻擊者存取本機／內網服務，並將 curl 錯誤或回應 `Content-Type` 寫回 `said.textContent` 與 `img.title`（搭配 SEC-04 甚至可直接回傳非圖片回應內容）。
- **修復建議**：
  1. 在 `webimage.rs` 停用 curl 自動 `--location`，逐跳手動處理重導向：每跳先解析 DNS、拒絕 loopback (`127.0.0.0/8`, `::1`)、link-local (`169.254.0.0/16`, `fe80::/10`)、私網 (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`)、未指定與多播位址，並以 `--resolve` 鎖定已驗證 IP 防止 DNS rebinding；同時對 `stderr` 讀取加上上限（如 64 KiB）。
  2. 在前端 Load 提示列出唯一主機名稱，並將前端判斷改為 `/^https?:\/\//i` 與後端一致。

#### SEC-06：`open_repo_file` 可執行檔防護可被「未知副檔名 + `+x`」與遺漏副檔名繞過
- **位置**：[app/src-tauri/src/system.rs](../app/src-tauri/src/system.rs#L53-L98)
- **問題描述**：
  透過 Git clone 下來的檔案沒有 macOS `com.apple.quarantine` 屬性，`/usr/bin/open` 會無警告直接執行。`runs_when_opened` 在檔案「有副檔名」時會直接略過可執行權限位元（`0o111`）檢查，僅比對 30 個副檔名黑名單 `RUNS_WHEN_OPENED`。
- **攻擊情境**：
  1. **未知副檔名 + `+x` 繞過**：在 macOS 上，若檔案具 `+x` 權限（Git 會保留 `100755`）且副檔名無對應註冊程式（如 `setup.run`、`notes.v1`、`report.out`），LaunchServices 會將其判定為 `public.unix-executable` 並交由 Terminal 直接執行內含的 shell script 或 Mach-O 執行檔。
  2. **黑名單遺漏**：未包含 `.dmg`、`.iso`、`.sparseimage`、`.img`（自動掛載磁碟映像）、`.scpt`、`.action`、`.workflow`、`.xip` 等高風險副檔名。
- **修復建議**：
  改採「安全文件／媒體副檔名白名單」才呼叫 `/usr/bin/open`，其餘一律以 `open_as_text` 或 `reveal` 開啟；或透過 `NSWorkspace` 查詢預設處理程式，並於非 SMB 磁碟（可複用現有 `share_of`）檢查 `+x` 與檔頭（`#!` / Mach-O magic）。

#### SEC-07：Terminal.app PTY 控制字元命令注入（`terminal_do` / `shell_quote` / `unsafe_arg`）
- **位置**：
  - [app/src-tauri/src/system.rs](../app/src-tauri/src/system.rs#L116-L187)
  - [app/src-tauri/src/remote.rs](../app/src-tauri/src/remote.rs#L61-L63)
  - [app/src-tauri/crates/backend/src/ops/mod.rs](../app/src-tauri/crates/backend/src/ops/mod.rs#L32-L37)
- **問題描述**：
  `terminal_do` 透過 `osascript` 對 `Terminal.app` 下達 `do script "..."`。AppleScript 雙引號字串允許原樣傳遞控制字元（經 `/usr/bin/osascript` 實測驗證），而 `Terminal.app` 的 `do script` 會將字元直接寫入互動式 Shell 的 PTY 輸入流。當 PTY line discipline 收到 `\x03`（Ctrl-C / `VINTR`）或 `\x15`（Ctrl-U / `VKILL`）時，會直接中斷尚未閉合的單引號 `cd '...'` 或 `ssh -t ...` 命令列，導致後續字串被當成**全新未跳脫的本機 Shell 命令**執行。
- **可達輸入點**：
  - 互動式 rebase 的 `onto`（`unsafe_arg` 僅擋 `-` 開頭，允許控制字元）。
  - SSH 遠端路徑 `remote.path`（`remote::parse` 僅擋 `\0`、`\n`、`\r`，允許 `\x03`、`\x15` 等）。
  - 本機 APFS 目錄名稱內含控制字元。
- **修復建議**：
  在 `terminal_do`、`remote::parse`（`path`）與 `ops::unsafe_arg` 三處一律拒絕任何 ASCII 控制字元（`s.chars().any(char::is_control)`）；更佳做法是改寫臨時 `0700` 腳本交給 Terminal 執行，避免透過 PTY 注入按鍵。

#### SEC-08：正式版打包外洩 `selftest.ts` / `preview.ts` 與 `window.__gg.app`，且可由環境變數觸發破壞性操作
- **位置**：
  - [app/web/src/main.ts](../app/web/src/main.ts#L9-L21)
  - [app/web/src/App.svelte](../app/web/src/App.svelte#L777-L808)
  - [app/src-tauri/src/main.rs](../app/src-tauri/src/main.rs#L125-L186)
  - [app/diff/main.js](../app/diff/main.js#L496-L588)
- **問題描述**：
  `main.ts` 無條件動態載入 `./selftest` 與 `./preview`，`web/dist/assets/` 實測已打包進 `selftest-*.js`（34.7 KB）與 `preview-*.js`（3.0 KB）；Rust 正式版亦未以 Cargo feature 隔離 `self_test`、`selftest_write`、`diff_report`、`preview`、`preview_resize`，僅檢查環境變數 `GG_SELFTEST=1`。此外，`App.svelte` 在正式環境無條件將具備破壞性操作權限的 `window.__gg.app`（`operate`、`action`、`addAndShow`、`removeRepos`、`saveSidebar`、`state`）掛載於全域 `window`。
- **影響**：
  1. 任何程式若於啟動 App 時設定 `GG_SELFTEST=1`，正式版即對使用者開啟的 Repo 執行寫檔、建立／刪除分支、`cleanUntracked`、修改設定等破壞性自動化操作。
  2. `window.__gg.app` 加上 `withGlobalTauri: true` 大幅擴大了潛在腳本注入後的攻擊面；`csp.ts` 也在正式環境中無上限累積 `cspViolations` 陣列。
- **修復建議**：
  前端以編譯期旗標（如 `import.meta.env.VITE_GG_TEST === '1'`）包覆 `selftest`、`preview`、`csp.ts` 與 `window.__gg` 使 Vite 在正式建置完整 tree-shake 移除；Rust 端以 Cargo feature（如 `#[cfg(feature = "selftest")]`）條件編譯測試用 command。

#### SEC-09：`find.ts` 主執行緒正規表示式 ReDoS，且每次按鍵重複掃描兩次
- **位置**：
  - [app/web/src/lib/find.ts](../app/web/src/lib/find.ts#L8-L34)
  - [app/web/src/lib/components/FindWidget.svelte](../app/web/src/lib/components/FindWidget.svelte#L27)
  - [app/web/src/App.svelte](../app/web/src/App.svelte#L67), [L401](../app/web/src/App.svelte#L401)
- **問題描述**：
  使用者於 Find 啟用 Regex 模式時，輸入直接送入 `new RegExp(query, ...)` 並於 WebKit 主執行緒同步比對所有已載入的 commit（最高 86k+ 筆）。實測 `(a+)+$` 對單一 25 字元字串即耗時 2,241 ms，在大型 Repo 上會直接造成視窗永久凍結（ReDoS）。且 `App.svelte` 第 401 行在 `onFindChange` 手動呼叫一次 `findRows()`，隨即第 67 行的 `$derived` 又再執行一次，無任何 debounce。
- **修復建議**：
  移除 `App.svelte:401` 的重複呼叫，在 `FindWidget.svelte` 加上輸入 debounce（120–150 ms），並將正規表示式搜尋移至可超時中斷的 Web Worker 或改由 Rust 後端線性時間 `regex` crate 執行（搭配查詢長度上限）。

---

### 中風險（Medium）

#### SEC-10：Mermaid 內嵌 SVG / `<foreignObject>` / `themeCSS` 直接注入 `diff.html` Live DOM
- **位置**：
  - [app/diff/main.js](../app/diff/main.js#L246-L265)
  - [app/web/diff.html](../app/web/diff.html#L51-L52)
- **問題描述**：
  不同於 PlantUML 採用 `<img src="data:image/svg+xml,...">` 隔離渲染，Mermaid 直接將 SVG、`<style>` 與 `<foreignObject>` 渲染進 `diff.html` DOM。經核對專案安裝的 `mermaid@12.2.0`：
  1. `themeCSS` 與 `htmlLabels` 不在 Mermaid 預設的 `secure` 鎖定清單中，且 `sanitizeText` 允許內聯 `style` 屬性；搭配 `tauri.conf.json` 的 `style-src 'unsafe-inline'` 且 `#preview` 無 containing block，惡意 ` ```mermaid ` 區塊可用 `position: fixed; inset: 0; z-index: 99999` 覆蓋偽造整個 diff 視窗（包含工具列與遠端圖片「Load」確認提示，造成 UI Redressing／點擊劫持）。
  2. DOMPurify 保留 `class`/`id`，可透過 `<foreignObject>` 注入 `<pre class="plantuml">` 觸發 `focus` 時的 `drawPlantuml(page)`，或觸發 `colourCode` 空值例外。
  3. `mermaid.core.mjs` 在 `DOMPurify.sanitize` 前會先將暫存節點掛載到 `document.body`。
- **修復建議**：
  改以 `mermaid.render(...)` 產出 SVG 字串並比照 PlantUML 以 `<img src="data:image/svg+xml,...">` 顯示（並鎖定 `htmlLabels: false` 及擴充 `secure` 陣列）；另於 `#preview` 加上 `contain: layout style;` 作為縱深防禦。

#### SEC-11：Markdown 預覽未攔截非 Click 導覽（右鍵／中鍵／拖曳連結與 SVG `xlink:href`）
- **位置**：
  - [app/diff/main.js](../app/diff/main.js#L361-L368)
  - [app/src-tauri/src/diff.rs](../app/src-tauri/src/diff.rs#L20-L26)
- **問題描述**：
  `diff/main.js` 僅監聽 `click` 事件攔截連結，但 `<a href="...">` 屬性仍保留在 DOM 中，且 `markdown-it` 預設允許 `smb://`、`ssh://` 等自訂 scheme 與相對路徑；同時 `diff.rs` 建立 `WebviewWindowBuilder` 時未設定 `on_navigation` 限制。使用者於 WKWebView 中鍵點擊（`auxclick`）、右鍵選「Open Link」或拖曳連結時會繞過 `click` 監聽器，直接導覽至外部網站（脫離 App CSP）或觸發 macOS 註冊的 `smb://` 等協定。此外第 366 行未處理 SVG `xlink:href`。
- **修復建議**：
  在 `markdown.js` 覆寫 `md.validateLink` 為嚴格白名單（僅 `https://`、`http://`、`mailto:`、`#`），於 `renderPreview` 將外部 `href` 移至 `data-href` 避免原生導覽，攔截 `auxclick`，並在 `diff.rs` 加上 `.on_navigation(...)` 禁止 `diff-*` 視窗離開 `diff.html`。

#### SEC-12：`diff-*` 視窗未綁定所屬 Repo，且 `worktree_file` 允許讀取 `.git/` 內部敏感檔
- **位置**：
  - [app/src-tauri/src/diff.rs](../app/src-tauri/src/diff.rs#L14-L42)
  - [app/src-tauri/src/main.rs](../app/src-tauri/src/main.rs#L90-L91)
  - [app/src-tauri/crates/backend/src/files.rs](../app/src-tauri/crates/backend/src/files.rs#L57-L97)
- **問題描述**：
  1. `open_diff_window` 未記錄 `window_label -> repo` 綁定關係，故受污染的 `diff-*` 視窗可藉由 `worktree_file` 與 `engine_request` 存取側欄中**任意其他 Repo** 的檔案。
  2. `inside_repo` 未排除 `.git/` 目錄，允許讀取 `.git/config`（常含明文 HTTPS Personal Access Token／密碼）、`.git/FETCH_HEAD`、`.git/logs/HEAD` 或透過 repo 內指向 `.git/config` 的 symlink 讀取。
  3. `read_worktree_file` 先 `metadata()` 再 `File::open()` 存在輕微 TOCTOU（FIFO 競態）。
- **修復建議**：
  建立 `diff-*` 視窗時於 managed state 綁定 `(label -> repo)`（視窗關閉時移除），要求 `worktree_file` 與 `engine_request` 驗證視窗僅能存取所屬 Repo；在 `read_worktree_file` 拒絕任何路徑元件含 `.git`（macOS 須不分大小寫）或解析後落於 `git_dir` 內之路徑。

#### SEC-13：`host_log` 未用參數 `persist: true` 可由 `diff-*` 視窗繞過設定並無上限寫入磁碟
- **位置**：
  - [app/src-tauri/src/main.rs](../app/src-tauri/src/main.rs#L107-L116)
  - [app/src-tauri/src/state.rs](../app/src-tauri/src/state.rs#L211-L219)
  - [app/src-tauri/capabilities/diff.json](../app/src-tauri/capabilities/diff.json#L8)
- **問題描述**：
  `diff.json` 註明「不允許任何寫入」，但 `allow-host-log` 開放 `diff-*` 視窗傳入 `persist: true`（實際全前端無人使用此參數），可強制忽略 `log.enabled = false` 並無字數／總檔大小限制地持續寫入 `session.log`，造成本機磁碟空間耗盡（DoS）。
- **修復建議**：
  移除未使用的 `persist` 參數，並在 `SessionLog::append` 加上單行長度上限（如 8 KiB）與總檔案容量上限（如 10 MiB）。

#### SEC-14：`render_plantuml` 未限制 JVM 輸出與快取總記憶體上限（自動觸發 OOM）
- **位置**：[app/src-tauri/src/plantuml.rs](../app/src-tauri/src/plantuml.rs#L30), [L104-L126](../app/src-tauri/src/plantuml.rs#L104-L126), [L158-L163](../app/src-tauri/src/plantuml.rs#L158-L163)
- **問題描述**：
  開啟含 ` ```plantuml ` 的 Markdown 會自動呼叫 `render_plantuml`。雖限制輸入為 256 KiB，但 `child.wait_with_output()` 對 `stdout`/`stderr` **無位元組上限**。PlantUML 巨集／迴圈（`!while`）在 `SANDBOX` 模式下仍可展開為數百 MiB SVG 導致 Host OOM，且 `Cache` 僅限 64 筆而無總容量上限。此外超時僅殺掉 `java`，未以 process group 連帶清除 PlantUML 派生的 `dot` 子行程。
- **修復建議**：
  比照 `webimage.rs` 以 `.take(MAX_SVG_BYTES + 1)` 限制 `stdout`/`stderr`，為 `Cache` 增設總位元組上限，並比照 `git.rs` 使用 process group 確保超時完整清理子行程。

#### SEC-15：SSH 連線全域死鎖與 `gg-remote` Wire 協定並發／進度無上限 DoS
- **位置**：
  - [app/src-tauri/src/remote.rs](../app/src-tauri/src/remote.rs#L196), [L203-L214](../app/src-tauri/src/remote.rs#L203-L214), [L231-L237](../app/src-tauri/src/remote.rs#L231-L237), [L346-L351](../app/src-tauri/src/remote.rs#L346-L351)
  - [app/src-tauri/crates/remote/src/main.rs](../app/src-tauri/crates/remote/src/main.rs#L131-L158), [L247-L263](../app/src-tauri/crates/remote/src/main.rs#L247-L263)
- **問題描述**：
  1. **全域連線死鎖**：`remote.rs` 的 `self.connecting.lock().await` 橫跨整個 `open()`，但 `open()` 的 bootstrap 讀取（`marker` / `read_until`）沒有逾時與取消機制；單一掛死的 SSH 主機將永久鎖死所有其他 SSH 主機的連線，且 `read_until` 無行長上限、`Session::call` 的 `mpsc::unbounded_channel` 與 `result` 緩衝無上限。
  2. **`gg-remote` 資源耗盡與競態**：遠端 helper 對每個 `Q` frame 無上限 spawn task；重複請求 `id` 會靜默覆寫 `cancels` map 使前一個任務無法取消；每個 git 輸出片段各自 `tokio::spawn` 傳送 `V` frame，在慢速連線下會導致任務堆積與進度 frame 亂序（甚至晚於 `R`/`E` 結束 frame 抵達）。
- **修復建議**：
  改為每主機獨立鎖並為 bootstrap 加上逾時與行長／總回應容量上限；於 `gg-remote` 限制並發請求數、拒絕重複 `id`，並改用單一有序通道傳送進度 frame。

#### SEC-16：`filters.rs` 頂層 Submodule 列舉失敗時 Fail-Open
- **位置**：[app/src-tauri/crates/backend/src/filters.rs](../app/src-tauri/crates/backend/src/filters.rs#L27-L30)（對比 [L41](../app/src-tauri/crates/backend/src/filters.rs#L41)）
- **問題描述**：
  巢狀 submodule 列舉失敗時會推入錯誤訊息採取 fail-closed（第 41 行），但頂層 `submodules_in(rt, None)` 回傳 `None` 時卻直接 `return Ok(keys)`（fail-open），若主 Repo 無自身 filter 但 `ls-files` 失敗，會直接跳過所有 submodule 的 filter 檢查。
- **修復建議**：
  在非 bare repo 的情況下，頂層 `submodules_in` 失敗時同樣回報阻擋原因採取 fail-closed。

#### SEC-17：`commit_squashed` 缺少 `--no-ext-diff` / `--no-textconv` 可觸發 `diff.external`
- **位置**：[app/src-tauri/crates/backend/src/ops/remote.rs](../app/src-tauri/crates/backend/src/ops/remote.rs#L43-L49)（對比 [reads.rs](../app/src-tauri/crates/backend/src/reads.rs#L32)）
- **問題描述**：
  `commit_squashed` 執行 `git diff --cached --quiet` 未帶 `--no-ext-diff` 與 `--no-textconv`。經實測，當 `.git/config` 設定 `diff.external` 搭配 `diff.trustExitCode = true` 時，`--quiet` **仍會執行** `diff.external`。（`reads.rs:32` 已加 `--no-ext-diff`，但也遺漏 `--no-textconv`。）
- **修復建議**：
  兩處抽成共用函式並同時加上 `--no-ext-diff --no-textconv`（或改用 plumbing 命令 `git diff-index --cached --quiet HEAD`）。

#### SEC-18：不可信 `.git` 檔 (`gitdir: /`) 或 `commondir` 導致任意目錄遞迴監看與 FIFO 掛死
- **位置**：
  - [app/src-tauri/crates/backend/src/repo.rs](../app/src-tauri/crates/backend/src/repo.rs#L20-L36)
  - [app/src-tauri/crates/backend/src/watch.rs](../app/src-tauri/crates/backend/src/watch.rs#L61-L69), [L171](../app/src-tauri/crates/backend/src/watch.rs#L171), [L191](../app/src-tauri/crates/backend/src/watch.rs#L191)
- **問題描述**：
  1. `repo::git_dir` 與 `watch::Repo::of` 直接將 `.git` 檔中 `gitdir:` 或 `commondir` 的內容以 `Path::join` 拼接；若內容為絕對路徑 `/` 或 `../../../../..`，`watcher.watch(dir, RecursiveMode::Recursive)` 會對整個根目錄建立遞迴監看（在 Linux `gg-remote` 耗盡 inotify watches、在 macOS 訂閱全機 FSEvents）。
  2. `fs::read_to_string` 讀取 `.git`、`commondir` 與 rebase 進度檔時未檢查 `is_file()` 也無容量上限，若指向 FIFO 會永久阻塞執行緒，或讀取超大檔造成 OOM。
- **修復建議**：
  以限長（如 4 KiB）且檢查 `is_file()` 的共用函式讀取中繼檔；送入 `watcher.watch` 前驗證目標目錄確實為合法 git 目錄（含 `HEAD` 或 `objects`）且非根目錄或系統頂層目錄。

#### SEC-19：`Push` / `FetchIntoLocalBranch` / `delete_on_remote` 存在 Refspec 注入
- **位置**：[app/src-tauri/crates/backend/src/ops/remote.rs](../app/src-tauri/crates/backend/src/ops/remote.rs#L69), [L115](../app/src-tauri/crates/backend/src/ops/remote.rs#L115), [L132](../app/src-tauri/crates/backend/src/ops/remote.rs#L132)
- **問題描述**：
  `unsafe_arg` 僅拒絕 `-` 開頭，未阻擋 `:` 或 `+`：
  - `Push` 執行 `git push <remote> <branch>`：傳入 `:victim` 會刪除遠端分支，`+src:dst` 會在 `PushMode::Normal` 下強制推送並繞過 `loss::reasons()` 的 `ForcePushDropsCommits` 保護。
  - `FetchIntoLocalBranch` 拼接 `{remote_branch}:{local_branch}`：開頭 `+` 可在 `force == false` 時強制更新。
  - `delete_on_remote` 執行 `git push <remote> --delete <branch>`：傳入 `refs/tags/<name>` 可誤刪遠端 Tag。
- **修復建議**：
  明確限定完整 ref 前綴（如 `refs/heads/{branch}:refs/heads/{branch}`、`refs/heads/{branch}`），並在 `Push`／`FetchIntoLocalBranch` 拒絕含 `:` 或 `+` 開頭的分支名稱。

#### SEC-20：Askpass 憑證 Token 過度暴露至所有操作與唯讀 `repo_read`，且缺少視窗隔離驗證
- **位置**：
  - [app/src-tauri/src/api.rs](../app/src-tauri/src/api.rs#L64), [L134](../app/src-tauri/src/api.rs#L134)
  - [app/src-tauri/src/askpass.rs](../app/src-tauri/src/askpass.rs#L59-L78), [L104-L117](../app/src-tauri/src/askpass.rs#L104-L117), [L199-L202](../app/src-tauri/src/askpass.rs#L199-L202)
  - [app/src-tauri/crates/remote/src/main.rs](../app/src-tauri/crates/remote/src/main.rs#L111-L118)
  - [app/src-tauri/crates/remote/src/askpass.rs](../app/src-tauri/crates/remote/src/askpass.rs#L75-L111)
- **問題描述**：
  1. 本機 `repo_read` 與所有 `repo_op`（含純本機的 `EditUserDetails`、`CreateArchive`、`StashDrop` 等）及遠端 `Request::Op` 皆注入 `GG_ASKPASS_SOCKET` 與 `GG_ASKPASS_TOKEN`。若該次 git 執行觸發任何 hook、filter 或設定命令，即可濫用現有 token 透過 socket 彈出偽造帳密視窗釣魚使用者憑證。
  2. `askpass_reply` 未驗證 `window.label()` 是否與該 prompt `id` 所屬視窗相符（跨視窗回覆／取消）。
  3. 本機與遠端 askpass server 的 `read_line` 均無位元組上限；本機結束時未清除 socket 目錄，遠端啟動時未清除殘留 `gg-remote-askpass-*` 目錄且在 `out.send` 失敗時洩漏 `waiting` map。
- **修復建議**：
  僅在需要網路認證的操作注入 askpass 環境變數（`repo_read` 與純本機操作一律不注入）；`askpass_reply` 驗證視窗歸屬；限制 `read_line` 長度並補齊 socket 目錄清理與 `window_closed` token 回收。

#### SEC-21：不可信 `.your-git-graph.json` 匯入驗證不足與前後端輸入驗證落差
- **位置**：
  - [app/web/src/lib/repoconfig.ts](../app/web/src/lib/repoconfig.ts#L20-L59)
  - [app/web/src/lib/remote.ts](../app/web/src/lib/remote.ts#L14-L54)
  - [app/web/src/lib/addremote.ts](../app/web/src/lib/addremote.ts#L18-L36)
  - [app/web/src/lib/components/SettingsPanel.svelte](../app/web/src/lib/components/SettingsPanel.svelte#L104-L123)
  - [app/web/src/lib/dialogs.ts](../app/web/src/lib/dialogs.ts#L64-L90)
- **問題描述**：
  1. **`.your-git-graph.json`（來自不可信 clone，開啟 Repo 時自動匯入）**：`exportedAt` 未檢查 `Number.isFinite` 與上限（設為 `9e15` 會永久鎖死日後匯入）；`hiddenRemotes` 未限制陣列長度、字串長度與字元（可灌入巨量資料膨脹 `state.json` 與每次 `loadCommits` IPC）。
  2. **前後端驗證落差**：`remote.ts` 的 `invalidShare` 未阻擋非空白控制字元（`\x00-\x1f`），`invalidRemote` 允許 `.`/`..` 主機卻拒絕 Rust 支援的 `[IPv6]`；`addRemoteDialog` 未阻擋 `\0`/`\r`/`\n`；`SettingsPanel` 新增 Remote 未阻擋 `ext::` helper URL；`dialogs.ts` 未驗證 Git ref 格式與 email 控制字元。
- **修復建議**：
  對 `.your-git-graph.json` 加上檔案大小上限、夾限 `exportedAt <= now`、限制 `hiddenRemotes` 筆數與名稱格式；統一前後端控制字元／IPv6／Git ref／Remote URL 驗證規則。

---

### 低風險與縱深防禦（Low / Hardening）

| 編號 | 問題摘要 | 位置 | 建議修復 |
|---|---|---|---|
| **SEC-22** | `withGlobalTauri: true` 令 `window.__TAURI__` 全域暴露於不可信 `diff.html` | [tauri.conf.json](../app/src-tauri/tauri.conf.json#L11), [diff/main.js](../app/diff/main.js#L13) | 改由 `@tauri-apps/api` ESM import（`esbuild` 已打包），將 `theme.js` 的 `preview` 偵測移至 `preview.ts`，關閉 `withGlobalTauri` |
| **SEC-23** | 開發設定 `tauri.dev.conf.json` 完全停用 CSP（`"csp": null`），開發期開啟不可信 Repo 失去網路與腳本防護 | [tauri.dev.conf.json](../app/src-tauri/tauri.dev.conf.json#L9) | 保留嚴格 CSP，僅放行 Vite HMR 所需的 `localhost:1420`（`http:`/`ws:`） |
| **SEC-24** | KaTeX 未設定 `maxSize`（預設 `Infinity`，可用 `\rule{1000000em}{1000000em}` 破壞版面）；`DIAGRAMS` 純物件查表遇 `constructor` 命中原型鏈 | [diff/markdown.js](../app/diff/markdown.js#L14), [L23-L30](../app/diff/markdown.js#L23-L30) | 傳入 `{ trust: false, maxSize: 10, maxExpand: 1000 }`；`DIAGRAMS` 改用 `Object.create(null)` 或 `Object.hasOwn` 並防呆 `token.map` |
| **SEC-25** | `resolveRelative` 先驗證 `/`、`\`、scheme 再執行 `decodeURIComponent`，導致 `%2f...` 繞過絕對路徑檢查（後端 `inside_repo` 已兜底不越界） | [diff/mdview.js](../app/diff/mdview.js#L10-L23) | 先解碼再做開頭斜線、NUL 與 scheme 驗證 |
| **SEC-26** | `write_atomic` 臨時檔名僅含 PID，同行程並發寫入同一檔案（如 `State::flush` 與背景寫入執行緒、或並發 `settings_set`）會互搶 `.tmp`；`settings.json` 讀改寫未加鎖 | [backend/src/files.rs](../app/src-tauri/crates/backend/src/files.rs#L19-L38), [src/state.rs](../app/src-tauri/src/state.rs#L176-L185) | 臨時檔名加入遞增 `AtomicU64` 與隨機後綴；以 `Mutex` 序列化 `settings.json` 寫入 |
| **SEC-27** | `resolve_git` 未過濾空 `PATH` 項目（如 `:/usr/bin`），可能嘗試執行當前目錄下的 `./git` | [backend/src/git.rs](../app/src-tauri/crates/backend/src/git.rs#L44-L50) | 過濾 `!d.as_os_str().is_empty() && d.is_absolute()` |
| **SEC-28** | `reflogged.rs` 傳遞 `filter_paths` 未加 `:(literal)` 前綴，允許 pathspec magic | [backend/src/reflogged.rs](../app/src-tauri/crates/backend/src/reflogged.rs#L63-L66) | 比照 `ops/stash.rs:37` 加上 `:(literal)` 並過濾空字串 |
| **SEC-29** | `rewrite_from` 未覆寫 `core.commentChar`（若 Repo 設為 `p` 或 `e`，rebase todo 的 `pick`/`exec` 會被當成註解而誤刪 commit） | [backend/src/ops/history.rs](../app/src-tauri/crates/backend/src/ops/history.rs#L15-L44) | 執行 `rebase -i` 時加上 `-c core.commentChar=#`，並額外檢查目標 commit 本身是否為 merge commit |
| **SEC-30** | `state.svelte.ts`、`sidebar.ts`、`dialogs.ts`、`strings.svelte.ts` 對純物件動態讀寫未用 `Object.hasOwn` 或防護 `__proto__` 鍵名；`mounts` 未檢 `!Array.isArray` | [state.svelte.ts](../app/web/src/lib/state.svelte.ts#L13-L38), [sidebar.ts](../app/web/src/lib/sidebar.ts#L63-L85) | 動態讀取改用 `Object.hasOwn`、寫入拒絕 `__proto__`/`constructor`/`prototype` 或改用 `Map` |
| **SEC-31** | `self_test` 在測試模式下向 `diff-*` 視窗洩漏 `sshPassword`；`selftest_write` 未檢 `state.listed` 與中間目錄 symlink；`render_plantuml` 錯誤回傳本機 Java/JAR 完整路徑 | [src/main.rs](../app/src-tauri/src/main.rs#L125-L159), [plantuml.rs](../app/src-tauri/src/plantuml.rs#L87-L124) | 對 `diff-*` 省略密碼欄位；`selftest_write` 補上 `state.listed` 與 canonicalize 檢查；精簡 PlantUML 錯誤路徑揭露 |
| **SEC-32** | `capabilities/default.json` 過度授予主視窗 `allow-render-plantuml`、`allow-fetch-image`（僅 diff 視窗使用）與 `allow-engine-request`（僅 selftest 使用） | [capabilities/default.json](../app/src-tauri/capabilities/default.json#L18), [L37-L38](../app/src-tauri/capabilities/default.json#L37-L38) | 依最小權限原則自 `default.json` 移除不必要權限 |
| **SEC-33** | `git::pump` 無上限緩衝 stdout/stderr；`wire::write_frame` 未驗證 `<= MAX_FRAME` 且 `wire::answer` 未切割超長 `Err` frame（超過 16 MB 會導致整條 SSH 斷線） | [backend/src/git.rs](../app/src-tauri/crates/backend/src/git.rs#L272-L298), [wire.rs](../app/src-tauri/crates/backend/src/wire.rs#L46-L85) | 限制緩衝大小、在 `write_frame` 檢查長度並截斷過長錯誤訊息 |
| **SEC-34** | `diff/main.js` 使用 `localStorage` 存 `gg.diffPrefs` 會跨 `GG_DATA_DIR` 與測試啟動互相污染，且 `JSON.parse` 未驗證回傳為非 null 物件 | [diff/main.js](../app/diff/main.js#L77-L78) | 驗證 parse 結果為 plain object，或改存於 `state.json` |
| **SEC-35** | 腳本安全與穩定性：`selftest.sh:51` 使用寬鬆正則 `pkill -f "$app"` 且中斷時未清理背景行程與 `log` 暫存檔；`preview.sh` 缺少 `EXIT` trap；`real-ssh.sh:4` 使用可預測路徑 `${TMPDIR:-/tmp}/gg-ssh-test-known-hosts.$PPID` | [selftest.sh](../app/scripts/selftest.sh#L17-L53), [preview.sh](../app/scripts/preview.sh#L35-L50), [real-ssh.sh](../app/tests/real-ssh.sh#L4) | 補齊 `EXIT` trap 清理背景 PID 與暫存檔、移除 `pkill -f`、`real-ssh.sh` 改用 `UserKnownHostsFile=/dev/null` 或 `mktemp` |

---

## 二、多餘程式碼、未使用項目與品質缺陷（Redundant / Dead Code & Quality）

### 2.1 建置錯誤與連帶發現的邏輯／資源缺陷

#### QUAL-01：`SettingsView.ts` import 路徑錯誤導致 `npm run check` 失敗
- **位置**：
  - [app/web/src/lib/api/generated/SettingsView.ts](../app/web/src/lib/api/generated/SettingsView.ts#L2-L3)
  - [app/src-tauri/src/settings.rs](../app/src-tauri/src/settings.rs#L16)
- **問題**：`SettingsView` 定義在主 crate（`export_to = "../../web/..."`），但引用的 `Settings` 與 `Ignored` 在 `crates/backend`（`export_to = "../../../../web/..."`），導致 `ts-rs` 產生了向上 7 層的錯誤相對路徑 `../../../../../../../web/src/lib/api/generated/{Ignored,Settings}`，`npm run check`（`svelte-check`）回報 2 個 TS2307 錯誤。
- **建議**：將 `SettingsView` 移至 `crates/backend/src/settings.rs` 並重新產生型別，同時即可自 `app/src-tauri/Cargo.toml` 移除多餘的 `ts-rs` 依賴。

#### QUAL-02：`settings_set` 無法重設 `dialogs.*` 預設值為 `null`
- **位置**：[app/src-tauri/src/settings.rs](../app/src-tauri/src/settings.rs#L45-L51)
- **問題**：當 `value.is_null()` 時會檢查 `Settings::default().value_of(&key).is_none()`；但 `Settings::default().dialogs` 為空 map，導致重設任何 `dialogs.<dialog>.<field>` 都會誤回 `Err("<key>: not a setting of this app")`。

#### QUAL-03：`SettingsPanel.svelte` Escape 鍵防護選擇器無效
- **位置**：[app/web/src/lib/components/SettingsPanel.svelte](../app/web/src/lib/components/SettingsPanel.svelte#L171)
- **問題**：`!(e.target as Element).closest('.gg-backdrop ~ *')` 試圖判斷是否有對話框開啟，但 `.gg-backdrop ~ *` 匹配的是 `.gg-backdrop` 之後的同層元素而非子節點，當焦點落在 modal 外時按 Esc 仍會直接關掉設定面板。建議改查 `document.querySelector('.gg-backdrop') === null`。

#### QUAL-04：`Sidebar.svelte` 拖曳按 Escape 洩漏 `keydown` 事件監聽器
- **位置**：[app/web/src/lib/components/Sidebar.svelte](../app/web/src/lib/components/Sidebar.svelte#L62)
- **問題**：拖曳期間按 Escape 取消時，移除了 `pointermove` 與 `pointerup`，但漏掉 `window.removeEventListener('keydown', key)`，每次按 Escape 取消都會永久洩漏一個 `window` 監聽器。

#### QUAL-05：`repos.rs` 視窗建立失敗洩漏 State，且 `scan_repos` 阻塞 Async 執行緒
- **位置**：[app/src-tauri/src/repos.rs](../app/src-tauri/src/repos.rs#L28-L30), [L227-L235](../app/src-tauri/src/repos.rs#L227-L235)
- **問題**：`new_window` 先將 `label` 插入 `Windows` 再呼叫 `.build()`，若建窗失敗會殘留孤兒項目；`scan_repos` 為 `async fn` 卻直接執行同步遞迴 `std::fs::read_dir`，應改用 `spawn_blocking`。

#### QUAL-06：`cargo clippy` 回報之警告（共 10 則）
- [backend/src/filters.rs](../app/src-tauri/crates/backend/src/filters.rs#L160)（3 則 `clippy::octal_escapes`：`"\0160000"` 建議寫成 `"\x00160000"` 以消除歧義）
- [backend/src/loss.rs](../app/src-tauri/crates/backend/src/loss.rs#L7-L8)（2 則 `doc_lazy_continuation`）
- [backend/src/ops/identity.rs](../app/src-tauri/crates/backend/src/ops/identity.rs#L51)（`manual_contains`）
- [backend/src/reads.rs](../app/src-tauri/crates/backend/src/reads.rs#L113)（`double_ended_iterator_last`，應改 `.next_back()`）
- [backend/src/runtime.rs](../app/src-tauri/crates/backend/src/runtime.rs#L75)、[src/api.rs](../app/src-tauri/src/api.rs#L142)（`too_many_arguments`）、[src/askpass.rs](../app/src-tauri/src/askpass.rs#L214) 及測試檔 `ops.rs`（`type_complexity` / `cloned_ref_to_slice_refs`）

---

### 2.2 確認為 Dead Code / Stage 1 遺留程式碼與檔案

1. **`migratedFromLocalStorage` 遺留旗標**：僅於 [src/main.rs](../app/src-tauri/src/main.rs#L221-L225) 與 [scripts/preview.sh](../app/scripts/preview.sh#L37) 寫入，全專案已無任何地方讀取。
2. **`host_log` 未使用的 `persist` 參數**：[src/main.rs](../app/src-tauri/src/main.rs#L108-L115)，全前端無人傳遞（移除即可一併解決 SEC-13）。
3. **4 個本地殘留的 Stage 1 自動產生權限檔**（已 gitignore，因 `tauri-build` 不會刪除已移除 command 的舊檔而殘留於磁碟）：
   - `app/src-tauri/permissions/autogenerated/get_appearance.toml`
   - `app/src-tauri/permissions/autogenerated/git_info.toml`
   - `app/src-tauri/permissions/autogenerated/open_repo_folder.toml`
   - `app/src-tauri/permissions/autogenerated/repo_operation_state.toml`
4. **單函式遺留模組 `src/git.rs`**：[app/src-tauri/src/git.rs](../app/src-tauri/src/git.rs#L1-L31) 原為 Stage 1 的 git runner，現僅剩 1 個 22 行函式 `remote_prompt`（僅由 `src/api.rs:174` 呼叫），可併入 `src/askpass.rs` 或 `src/api.rs`。
5. **僅限 `selftest` 呼叫卻未隔離的 Tauri Commands**：
   - `remote_disconnect`（[src/remote.rs](../app/src-tauri/src/remote.rs#L426-L430)）與 `set_appearance`（[src/repos.rs](../app/src-tauri/src/repos.rs#L370-L373)）在正式 UI 中從未呼叫，僅供 `selftest.ts` 使用。建議若不開放給 UI，應與 `selftest_write` 一樣受測試旗標保護。
6. **未使用的 CSS 變數與過時註解**：
   - [app/web/public/theme.css](../app/web/public/theme.css) 中 5 個 Stage 1 遺留變數全專案皆未以 `var(...)` 使用：`--gg-editor-foreground`、`--gg-input-placeholderForeground`、`--gg-inputValidation-errorBackground`、`--gg-inputValidation-errorBorder`、`--gg-inputValidation-warningBorder`；第 71 行另有過時註解 `sidebar.css`。
   - [app/web/src/lib/components/Sidebar.svelte](../app/web/src/lib/components/Sidebar.svelte#L171) 使用了從未定義的 `var(--gg-sidebar-width, 220px)`。
7. **`theme.js` 未使用方法與必然失敗的 IPC 呼叫**：
   - [app/web/public/theme.js](../app/web/public/theme.js#L29-L37)：`window.__ggTheme.apply` 從未被外部呼叫；第 29–33 行在每個頁面啟動時皆呼叫 `invoke('preview')`，但在 `diff.html` 因權限不足永遠失敗而被靜默吞掉。

---

### 2.3 後端未使用的資料欄位、型別與多餘相依（Rust）

1. **`RepoConfig` 未使用欄位與多餘引擎呼叫**：
   - 位置：[backend/src/api.rs](../app/src-tauri/crates/backend/src/api.rs#L141-L170)、[backend/src/reads.rs](../app/src-tauri/crates/backend/src/reads.rs#L110-L164)
   - 前端僅在 `SettingsPanel.svelte` 讀取 `remotes`、`userName`、`userEmail`。以下項目全未使用：`struct BranchConfig` 與 `branches`（及整段 `branch.*` 解析迴圈）、`push_default`、`diff_tool`、`gui_diff_tool`、`authors`（且後者導致每次讀設定都**白打一次 `rt.engine("authors")`**）。
2. **`ReadResponse::RepoInfo` 未使用欄位與 `struct Stash`**：
   - 位置：[backend/src/api.rs](../app/src-tauri/crates/backend/src/api.rs#L388-L398), [L490](../app/src-tauri/crates/backend/src/api.rs#L490)
   - 前端只使用 `branches`、`head`、`remotes`，從未讀取 `stashes` 或 `tags`。整個 `struct Stash` 僅服務於此未使用欄位，且 `App.svelte:165` 仍傳入 `showStashes: true` 徒增引擎工作量。
3. **`LoadOptions` 永遠固定預設值的欄位**：
   - `filter_paths`（永遠 `[]`）與 `show_tags`（永遠 `true`）在 [backend/src/api.rs](../app/src-tauri/crates/backend/src/api.rs#L39-L42) 及 [client.ts](../app/web/src/lib/api/client.ts#L91-L92) 皆無 UI 入口可變更。
4. **多餘的 `Cargo.toml` 依賴與 Feature**：
   - [app/src-tauri/Cargo.toml](../app/src-tauri/Cargo.toml#L22-L30)：
     - `ts-rs = "12"`：僅用於 `src/settings.rs` 的 `SettingsView`，隨 QUAL-01 移至 `gg-backend` 即可移除。
     - `notify = "=8.2.0"`：僅用於 `src/repos.rs:88` 的型別標註 `Option<notify::RecommendedWatcher>`，由 `gg_backend::watch` re-export 即可移除。
     - 第 22 行留有過時註解 `# git_exec: ...`（`git_exec` 已於 M3 移除）。
   - [app/src-tauri/crates/backend/Cargo.toml](../app/src-tauri/crates/backend/Cargo.toml#L13)：`tokio` 的 `"time"` feature 僅在測試中使用，應移至 `[dev-dependencies]`。
5. **測試專用常數與多餘的 `pub` 可見性**：
   - `graph::DANGLING`（[graph.rs:40](../app/src-tauri/crates/backend/src/graph.rs#L40)）僅在 `#[cfg(test)]` 使用；`ops::identity::Touched`（[identity.rs:38](../app/src-tauri/crates/backend/src/ops/identity.rs#L38)）之回傳值在正式碼遭丟棄。
   - 多處僅於模組內部或測試呼叫的項目標記為 `pub`：`src/plantuml.rs` `JAR_SETTING`、`src/remote.rs` `SCHEME` / `Remotes::{new,connect,disconnect}`、`src/repos.rs` `recent` / `new_window`、`src/state.rs` `lists_repo` / `SessionLog.0`；`gg-backend` 的 `read_engine`、`ReadRequest::is_engine`、`own_filters`、`MAX_LANES`、`SPAN`、`argv_values`、`rewrite_from`、`pull_args`、`REPO_CONFIG_FILE`、`DEFAULT_COLOURS`、`CHUNK` 等。

---

### 2.4 前端未使用的 Import、Export 與欄位（TypeScript / Svelte）

1. **未使用的 Import（3 處）**：
   - [App.svelte:8](../app/web/src/App.svelte#L8)：`listen`（僅使用 `getCurrentWindow().listen`）
   - [App.svelte:23](../app/web/src/App.svelte#L23)：`DEFAULT_GROUP`
   - [GraphTable.svelte:10](../app/web/src/lib/components/GraphTable.svelte#L10)：`relative`
2. **已賦值但從未讀取的型別欄位（2 處）**：
   - `DialogContext.currentBranch`（[dialogs.ts:34](../app/web/src/lib/dialogs.ts#L34)，由 `App.svelte:599` 傳入但從未讀取）
   - `MenuTarget` tag 變體的 `annotated: boolean`（[menus.ts:12](../app/web/src/lib/menus.ts#L12)，由 `GraphTable.svelte:208` 傳入但從未讀取）
3. **無外部引用之多餘 `export`（18 處）**：
   - [client.ts](../app/web/src/lib/api/client.ts#L14-L37)：`OpResult`、`CommitStash`、`FileStatus`、`LineCounts`、`Stash`、`ReadRequest`、`ReadResponse`、`repoRead`
   - [dialogs.ts](../app/web/src/lib/dialogs.ts#L10-L40)：`Field`、`DialogContext`、`dialogDefault`
   - [diffspec.ts](../app/web/src/lib/diffspec.ts#L18-L20)：`Side`、`ChangeType`（另 `compareSpec` 僅供 selftest/測試）
   - [filetree.ts](../app/web/src/lib/filetree.ts#L5-L6)：`FileNode`、`FolderNode`
   - [find.ts](../app/web/src/lib/find.ts#L5-L23)：`FindOptions`、`searchableText`
   - [draw.ts](../app/web/src/lib/graph/draw.ts#L7-L25)：`SPAN`、`DANGLING`、`NODE_RADIUS`、`PALETTE`、`DrawOptions`
   - 其餘：`i18n/index.ts` `Language`、`marks.ts` `Mark`/`Span`、`menus.ts` `MenuContext`、`remote.ts` `Remote`、`settings.svelte.ts` `Ignored`/`reloadSettings`、`sidebar.ts` `GroupOf`；`GraphTable.svelte:86` `scrollTo` 與 `csp.ts` `cspViolations` 僅供 selftest。

---

### 2.5 重複程式碼（Duplication）

- **Staged 檢查重複且不一致**：[backend/src/reads.rs:32](../app/src-tauri/crates/backend/src/reads.rs#L32) 與 [backend/src/ops/remote.rs:44](../app/src-tauri/crates/backend/src/ops/remote.rs#L44)（後者漏掉 `--no-ext-diff`，造成 SEC-17）。
- **常數與型別重複定義**：
  - `UNIT = '\x1f'` 重複定義於 [reads.rs:11](../app/src-tauri/crates/backend/src/reads.rs#L11) 與 [reflogged.rs:12](../app/src-tauri/crates/backend/src/reflogged.rs#L12)。
  - `UNCOMMITTED = '*'` 重複定義於 [client.ts:34](../app/web/src/lib/api/client.ts#L34) 與 [diffspec.ts:15](../app/web/src/lib/diffspec.ts#L15)。
  - `PALETTE` 8 色陣列重複硬編碼於 [draw.ts:15](../app/web/src/lib/graph/draw.ts#L15) 與 [settings.svelte.ts:16](../app/web/src/lib/settings.svelte.ts#L16)。
  - `AppHandle` 介面重複定義於 [preview.ts:29-41](../app/web/src/preview.ts#L29-L41) 與 [selftest.ts:21-46](../app/web/src/selftest.ts#L21-L46)。
  - `diff/main.js`：`basename`（L26，重複 `names.ts` 的 `baseName`）、遠端圖片等待迴圈（L574，重複 `settles`）、字型字串（L75，重複 `theme.css`）。
- **控制流程重複**：
  - `remote/src/main.rs:51-66` 的 `Cancel::Once` 與 `Cancel::Flag` 可統一為 `watch::Sender<bool>`。
  - 各 `ops/{branch,history,identity,remote,stash}.rs` 均對完整 `OpRequest` 做 match 並帶有不可達的 `other => Err(...)` 分支。
  - `dialogs.ts` 的 `labelOf`（L328-329）重複建立相同物件字面值，且多處連續呼叫兩次 `needName(v, ...)`。

---

## 三、已驗證安全與乾淨之項目（Verified Clean）

以下項目經逐一核實，確認設計正確、無漏報亦無需異動：

- **Svelte 前端零 XSS 風險**：全 `app/web/src/` 無任何 `{@html}`、`innerHTML`、`outerHTML`、`document.write`；commit 訊息（`Message.svelte` + `marks.ts`）以純文字節點渲染，且 `marks.ts` 正規式實測為線性時間無 ReDoS；`DetailsPanel.svelte` 的 `mailto:` 連結已正確編碼防注入。
- **Markdown / KaTeX / Monaco 基礎轉義**：`markdown-it` 啟用 `html: false`；`katex@0.19.1` 預設 `trust: false` 且 `maxExpand: 1000`；`monaco.editor.colorize` 會對 token 進行 HTML 轉義；`renderPreview` 在 inert `<template>` 中於首次 `await` 前同步移除所有 `<img>` 的 `src`。
- **i18n 與前端元件覆蓋率**：`en.ts` 與 `zh-TW.ts` 共 385 個 key 100% 雙向對齊且零未使用鍵；19 個 Svelte 元件、45 個 `MenuAction`、38 個 Tauri command、15 個 `ReadRequest`、43 個 `OpRequest` 與 47 個生成 `.ts` 檔皆有引用；`app/package.json` 的 17 個 `devDependencies` 與 2 個 `overrides`（含 `dompurify: 3.4.17`）皆有實際用途。
- **`initialization_script` 與 `open_url`**：`diff.rs` 與 `repos.rs` 透過 `serde_json` 序列化後注入 `WKUserScript`（ES2019+ 安全）；`open_url` 嚴格限制 `http://`、`https://`、`mailto:` 並傳入 `--`。
- **Clean-room 建置腳本**：`build-app.sh`、`build-remote.sh`、`check-cleanroom.sh` 皆有妥善引號與驗證，無 `eval` 或未跳脫展開。

---

## 四、建議修復優先順序（Remediation Roadmap）

### P0 — 立即修補（阻斷 RCE／SSRF／命令注入與恢復型別檢查）
1. **SEC-01 / SEC-02 / SEC-03**：封堵不可信 `.git/config` 的三條 RCE 路徑（`engine_request` + `Request::Engine` 補上 `filters::blocking()`、`filters.rs` 補查 `lfs.extension.*` / `lfs.customtransfer.*`、`CreateArchive` 阻擋 `tar.*.command`）。
2. **SEC-04 / SEC-05**：`webimage.rs` 加入 `--globoff`，改用手動跳轉並阻擋 loopback／私網／link-local IP（搭配 `--resolve`）。
3. **SEC-06 / SEC-07**：修正 `open_repo_file` 未知副檔名 + `+x` 執行繞過；於 `terminal_do`、`remote::parse`、`unsafe_arg` 阻擋所有控制字元。
4. **QUAL-01**：將 `SettingsView` 移入 `gg-backend` 並重新產生 `SettingsView.ts`，讓 `npm run check` 恢復通過。

### P1 — 短期安全強化（隔離 Diff 視窗、防止 DoS 與移除正式版測試後門）
1. **SEC-08**：以編譯期旗標將 `selftest`、`preview`、`window.__gg` 自正式版前端與 Rust 二進位完全剝離。
2. **SEC-10 / SEC-11 / SEC-12**：Mermaid 改為 `<img src="data:image/svg+xml,...">` 渲染；`diff-*` 視窗鎖定 `on_navigation`、綁定所屬 Repo 並禁止 `worktree_file` 存取 `.git/`。
3. **SEC-09 / SEC-13 / SEC-14 / SEC-15**：修復 `find.ts` ReDoS 與重複掃描；移除 `host_log` 的 `persist` 並限流；補齊 `render_plantuml`、`remote.rs` 與 `gg-remote` 的記憶體／並發／逾時上限。
4. **SEC-16 ~ SEC-21**：修正 `filters.rs` 頂層 fail-open、`commit_squashed` `--no-ext-diff`、`.git`/`commondir` 路徑驗證、Refspec 注入、Askpass 最小化注入範圍與 `.your-git-graph.json` 上限檢查。

### P2 — 程式碼清理與技術債
1. 修復 **QUAL-02 ~ QUAL-05**（`dialogs.*` 重設、SettingsPanel Esc、Sidebar 監聽器洩漏、`repos.rs` 競態與 async 阻塞）。
2. 清理 **2.2 ~ 2.5** 所列之 Stage 1 遺留程式（`migratedFromLocalStorage`、`src/git.rs`、4 個殘留權限檔、未用 CSS 變數）、精簡 `RepoConfig`/`RepoInfo` 未使用欄位與多餘 `Cargo.toml` 依賴、消除重複程式碼與 10 則 `cargo clippy` 警告，並落實 **SEC-22 ~ SEC-35** 縱深防禦強化項目。

---

## 五、查證與修正結果（2026-11-19）

每一項都先對照程式碼查證（能實測的就實測），成立才修；每個修正一個 commit，訊息裡寫了問題與解法。全部在分支 **`review-fixes`**（從 `main` 的 `a734568` 分出，尚未合併、尚未 push）。

**驗證**：`cargo test --workspace` 201 個全過（原 187）、`npm test` 66 個全過（原 64）、`npm run check` 0 錯誤、`cargo clippy --workspace --all-targets` 0 警告；self-test 對單一 repo 與含兩個 repo 的資料夾各跑過一次，都 PASS（debug 版）。**沒做的驗證**：release `.app` 的 self-test；Mermaid 改成圖片後的畫面（這個工作階段沒有螢幕錄製權限，`preview.sh` 截不到圖，只有 self-test 檢查過圖有畫出來、標籤是 SVG 文字）；`cargo tauri dev`。

狀態：✅ 已修正　◐ 部分成立、修了成立的部分　✗ 不成立或決定不改（附理由）

### 資訊安全

| 編號 | 狀態 | 查證與處理 | Commit |
|---|---|---|---|
| SEC-01 | ✅ | 成立。`engine_request` 與 helper 的 `engine` op 改走 `api::page_engine`：`filters::reads_uncommitted` 判斷會不會讀工作目錄，沒允許 filter 就拒絕（遠端帶 `filtersAllowed`）。 | `ea00301` |
| SEC-02 | ✅ | 成立，用 git-lfs 3 實測 `lfs.extension.<name>.clean` 會被執行（連使用者全域的標準 LFS 也會跑它）。查詢加上這個 key。`customtransfer` 只在 push／fetch 時用到，屬於使用者發動的操作，沒納入。 | `d4a9062` |
| SEC-03 | ✅ | 成立，git 2.56 實測 `tar.zip.command` 會取代內建 zip。Create Archive 先查 repo 自己設定的 `tar.*.command`，有就拒絕並指出 key。 | `23f9256` |
| SEC-04 | ✅ | 成立。curl 加 `--globoff`，有測試（`{secret,a.png}` 只發一次請求）。 | `c00e351` |
| SEC-05 | ◐ | 成立。轉址改由 App 逐跳處理（最多 5 跳）：每跳解析名稱、拒絕 loopback／未指定／link-local／multicast／broadcast、用 `--resolve` 釘住位址；stderr 上限 64 KiB；Load 提示列出主機。**刻意不擋 RFC1918 私有網段**：公司內部 git 伺服器的 README 圖片就在那裡，擋掉是功能倒退——這點請你決定要不要改。 | `a80d28e` |
| SEC-06 | ◐ | 一半成立。補上會掛載／安裝的副檔名（`.dmg`、`.iso`、`.img`、`.cdr`、`.sparseimage`、`.sparsebundle`、`.workflow`、`.action`、`.prefPane`、`.saver`、`.xip`）。**「未知副檔名＋`+x` 會被 Terminal 執行」不成立**：用 NSWorkspace 實測（macOS 27），`setup.run`、`notes.v1`、甚至改名的 Mach-O 都是 dynamic type、沒有對應的 App；只有沒副檔名的可執行檔才是 `public.unix-executable`，原本就擋了。 | `c26624f` |
| SEC-07 | ✅ | 機制合理，直接擋：`terminal_do`、`remote::parse` 的路徑、`ops::unsafe_arg` 都拒絕控制字元。（沒有實際對 Terminal 送 Ctrl-C 重現。） | `8104a37` |
| SEC-08 | ◐ | `window.__gg.app` 確實無條件掛著（與 CLAUDE.md 寫的不符）：改成只在 self-test／preview 時由 `main.ts` 掛上；`cspViolations` 上限 100 筆。**沒有把 self-test 從正式版編譯掉**：release `.app` 必須能跑 self-test（被蓋住的視窗凍結只在打包後才出現），而且能替 App 設環境變數的人本來就能以使用者身分執行任何東西，`GG_SELFTEST` 不是權限邊界。 | `2c562cb` |
| SEC-09 | ◐ | 重複搜尋成立：`onFindChange` 改讀 derived（只搜一次），輸入停 150 ms 才搜（Enter、切換、上下一筆立即搜）。**沒有把 regex 移到 worker 或 Rust**：那是使用者自己輸入的運算式，災難性回溯仍會卡住，改動範圍比這項大。 | `2e6cb84` |
| SEC-10 | ✅ | 成立。Mermaid 改用 `mermaid.render` 出 SVG 字串、以 `<img>` 的 data URL 顯示（`htmlLabels: false`、`suppressErrorRendering`），self-test 檢查頁面上沒有 inline 的 svg／style。後續修正：圖片先給寬度與 aspect-ratio，否則解碼後版面跳動，讓 self-test 的捲動檢查偶爾失敗。 | `2d26bb0`、`ec61ee2` |
| SEC-11 | ✅ | 成立。預覽的連結把位址移到 `data-href`（沒有 `href`，Enter 與 click 仍可用）；diff 視窗加 `on_navigation`，只准 App 自己的頁面。沒有另外改 `validateLink`（沒有 `href` 之後多餘，而且它也管圖片路徑）。 | `cae83ab` |
| SEC-12 | ✅ | 成立。`diff::Shown` 記錄每個 diff 視窗的 repo，`worktree_file` 與 `engine_request` 檢查；`read_worktree_file` 拒絕 `.git` 元件（不分大小寫、解析 symlink 後），改成 `O_NONBLOCK` 開檔後再問檔案型態。 | `2ee5fed` |
| SEC-13 | ✅ | 成立。移除 `persist` 參數；每行 8 KiB、整檔 10 MiB。 | `25082c9` |
| SEC-14 | ✅ | 成立。輸出上限 16 MiB、stderr 64 KiB、快取合計 64 MiB、java 在自己的 process group 並整組結束。 | `7b9fd76` |
| SEC-15 | ◐ | 進度 frame 亂序成立：每個請求一個 task 依序送，結果等它們送完。bootstrap 沒有盡頭成立：連線嘗試上限 15 分鐘、每行 64 KiB。**沒改**：所有主機共用一把鎖（一次只問一個密碼是設計）；helper 對請求數與重複 id 的限制（它唯一的對象是部署它的 App）。 | `5abb03c` |
| SEC-16 | ✅ | 成立。最上層列不出 submodule 時也回報阻擋原因；bare repo 除外（沒有工作目錄）。 | `6dc225f` |
| SEC-17 | ✅ | 成立，實測有 `diff.trustExitCode` 時 `--quiet` 仍會跑 `diff.external`，而且採信它的 exit code。兩處共用 `ops::staged`（`--no-ext-diff`）。`--no-textconv` 實測不需要。 | `cfe7cf7` |
| SEC-18 | ✅ | 成立。`.git` 檔與 `commondir` 只跟到有 `HEAD` 的目錄；這些小檔改用 `files::read_marker`（不等 FIFO、最多 4 KiB）。 | `1c2c2b5` |
| SEC-19 | ✅ | 成立（`+name` 是合法的分支名稱）。refspec 位置的分支名稱不能以 `+` 開頭或含 `:`；刪遠端分支用 `refs/heads/<branch>`。沒有把 push 改成完整的 `src:dst`，以免改變 `push.default=upstream` 的行為。 | `a9ddcbc` |
| SEC-20 | ◐ | `repo_read` 不再帶 askpass 環境；`askpass_reply` 檢查視窗；兩邊讀一行上限 64 KiB；helper 送不出問題時清掉等待項。**沒改**：不碰遠端的操作仍帶 askpass（用 ssh key 或 gpg 簽 commit 會經它問 passphrase）。 | `c9bd0af` |
| SEC-21 | ◐ | `.your-git-graph.json` 的部分成立：`exportedAt` 超過現在一天以上不匯入（否則之後永遠匯不進來）、`hiddenRemotes` 最多 100 筆、每筆 200 字元；`invalidShare` 擋控制字元。**沒改**前後端其他的驗證落差：後端每個值都會再檢查並回錯誤，前端只是提早說。 | `40e2e61` |
| SEC-22 | ✅ | 成立（CLAUDE.md 本來就記著要做）。`diff/main.js` 改用 `@tauri-apps/api`，`theme.js` 不再呼叫 IPC，`withGlobalTauri` 關掉。 | `44cfd46` |
| SEC-23 | ✗ | 沒改。只影響 `cargo tauri dev`，而這裡沒辦法驗證改了之後 Vite HMR 還能不能用；要改請在開發環境試。 | — |
| SEC-24 | ✅ | 成立。KaTeX `maxSize: 50`；`DIAGRAMS` 改成 Map（` ```constructor ` 原本會變成 class 是函式原始碼的 `<pre>`）。 | `1eaff26` |
| SEC-25 | ✅ | 檢查順序確實顛倒（但出不了 repo）。改成先解碼再檢查。 | `259ca64` |
| SEC-26 | ✅ | 成立。暫存檔名加計數器；`write_setting` 一次一個，有測試。 | `c504dfd` |
| SEC-27 | ✅ | 成立。`PATH` 只看絕對路徑的項目。 | `179145f` |
| SEC-28 | ✅ | 成立（目前沒有任何地方會設這些路徑）。加 `:(literal)`。 | `641680f` |
| SEC-29 | ✅ | 成立，測試重現：`core.commentChar=p` 時 Drop Commit 失敗。rebase 帶 `-c core.commentChar=#`。 | `50fc1ae` |
| SEC-30 | ✗ | 不成立。這些物件的 key 是固定名稱、絕對路徑或 `ssh://…`，不可能是 `__proto__`；`state.json` 是 App 自己寫的。 | — |
| SEC-31 | ◐ | `self_test` 對 diff 視窗不再回密碼；`selftest_write` 加 `state.listed`（兩者都只在 `GG_SELFTEST` 下）。PlantUML 錯誤訊息裡的路徑是使用者自己設的、給他看的，沒改。 | `30b0f54` |
| SEC-32 | ✗ | 沒改。主視窗是可信任的、擁有全部 command 是設計（它本來就能 `settings_set`）；拿掉兩個唯讀的權限沒有效果。 | — |
| SEC-33 | ◐ | 錯誤 frame 截在 64 KiB。**沒限制 `git::pump`**：讀取的結果就是 git 的輸出（8.6 萬列的 log 有幾十 MB），加上限只會把它截斷。 | `4715730` |
| SEC-34 | ◐ | `gg.diffPrefs` 存了 `null` 會讓每個 diff 視窗壞掉：成立，已檢查型別。偏好仍留在 `localStorage`（搬到 `state.json` 等於給 diff 視窗一個會寫入的 command）。 | `fdceb3b` |
| SEC-35 | ◐ | `preview.sh` 與 `selftest.sh` 加 EXIT trap（截圖被拒時 App 會留在最上層——這次就遇到了）。`pkill -f` 與 `real-ssh.sh` 的 known-hosts 路徑沒改（前者 CLAUDE.md 有說明，後者只放測試用 Docker 伺服器的 key）。 | `2fa7db4` |

### 品質與多餘程式碼

| 編號 | 狀態 | 查證與處理 | Commit |
|---|---|---|---|
| QUAL-01 | ✅ | 成立，而且比報告寫的更糟：在這台 Mac 上 `npm run check` 會過，是因為 App crate 的測試把設定型別**寫到 repo 外面**的 `../web/src/lib/api/generated/`，錯的 import 剛好解析得到；乾淨的 clone 會失敗。`SettingsView` 移到 `gg_backend::settings`，App 不再依賴 `ts-rs`。**那個 repo 外的 `web/` 資料夾是測試留下的垃圾，我沒有刪（不在這個 repo 裡），你可以自己刪掉。** | `aba9d3d` |
| QUAL-02 | ✅ | 成立，有測試。 | `4da6580` |
| QUAL-03 | ✅ | 成立。改成「畫面上沒有對話框時」Esc 才關面板。 | `f56b0c5` |
| QUAL-04 | ✅ | 成立。 | `f99d501` |
| QUAL-05 | ✅ | 成立。建窗失敗時移除紀錄；`scan_repos` 改 `spawn_blocking`。 | `56e521a` |
| QUAL-06 | ✅ | 10 則（加上我改 askpass 多出的 1 則）全部清掉，clippy 0 警告。 | `0ef6ca4` |
| 2.2-1 | ✅ | `migratedFromLocalStorage` 沒有人讀，移除。 | `f96ee1a` |
| 2.2-2 | ✅ | 隨 SEC-13。 | `25082c9` |
| 2.2-3 | ✅ | 4 個殘留的權限檔是 gitignore 的建置產物，已從工作目錄刪除（沒有 commit）。 | — |
| 2.2-4 | ✅ | `src/git.rs` 併入 `askpass.rs`。 | `4a8c7a4` |
| 2.2-5 | ✗ | 沒改。`remote_disconnect`、`set_appearance` 只有主視窗能叫，加環境變數檢查沒有意義。 | — |
| 2.2-6 | ✅ | 5 個沒用到的 token 與只量它們的 3 個對比檢查移除；`--gg-sidebar-width` 改成直接寫 220px。 | `a9a50b8` |
| 2.2-7 | ✅ | `theme.js` 那個在 diff 視窗必然失敗的 `invoke('preview')` 隨 SEC-22 移除；`apply` 內部有用，留著。 | `44cfd46` |
| 2.3-1 | ✅ | `RepoConfig` 只留 remotes 與 user；省掉每次讀設定多打的一次引擎 `authors`。 | `1c62e3a` |
| 2.3-2 | ◐ | App 改成不要 stash 清單（`showStashes: false`）。型別裡的 `stashes`／`tags` 與 `struct Stash` 沒刪：backend 的測試從那裡拿 stash 的 hash。 | `e789f38` |
| 2.3-3 | ✗ | 沒改。`filter_paths`、`show_tags` 是 API 的選項，只是還沒有 UI。 | — |
| 2.3-4 | ✅ | App 不再直接依賴 `notify`、`ts-rs`；backend 的 tokio `time` 移到 dev-dependencies；過時註解改掉。 | `aba9d3d`、`a74cfaa` |
| 2.3-5 | ✗ | 沒改。`pub` 改 `pub(crate)` 不影響建出來的東西；`DANGLING` 與 `SPAN` 一起說明 layout 的格式。 | — |
| 2.4-1、2 | ✅ | 3 個沒用到的 import、`DialogContext.currentBranch`、tag 選單目標的 `annotated` 移除。 | `7162ef2` |
| 2.4-3 | ✗ | 沒改。18 個沒有外部引用的 `export` 是模組的型別與 helper，有些給測試與 self-test 用。 | — |
| 2.5 | ◐ | `UNIT`、`UNCOMMITTED`、`PALETTE` 各只留一個定義；staged 檢查隨 SEC-17。其餘（`AppHandle`、`diff/main.js` 的 helper、helper 的兩種 cancel、各 ops 模組的 catch-all、`labelOf`）沒改：很小，合併只是動到能用的程式。 | `e21778f` |

### 其他要知道的事

- `CLAUDE.md` 已跟著更新（最後一個 commit `52e0c87`）。
- Rust 測試 `remote::tests::a_connection_that_fails_says_why` 在整套一起跑、機器忙的時候失敗過一次，之後重跑都過：是既有的時間相依問題，跟這次的修改無關，沒有處理。
