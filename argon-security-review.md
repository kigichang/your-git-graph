# Security Audit Report — Your Git Graph

- **Audit Date**: 2026-11-08
- **Scope**: `app/src-tauri` (Tauri host, `gg-backend`, `gg-remote`), `app/web` (Svelte 5 frontend), `app/diff` (Diff & Markdown preview window), `vendor/vscode-git-graph-rs` (`git-graph-core` Rust engine)

---

## Executive Summary (執行摘要)

整體而言，本專案在多項核心安全邊界上展現了良好的安全設計意識，包括：
- **Sidebar 儲存庫白名單檢查** (`StateStore::listed`)
- **Git 參數注入防護** (`unsafe_arg` 阻擋前導 `-` 與控制字元)
- **SSH 連線目標驗證與參數強化** (`remote::parse` 搭配 `-o RemoteCommand=none -o ClearAllForwardings=yes --`)
- **Askpass Unix Domain Socket 隔離與驗證** (`0700` 臨時目錄與 `/dev/urandom` 128-bit 隨機 token)
- **Interactive Rebase 環境變數傳遞** (`GG_TODO`、`GG_MESSAGE`、`GG_AUTHOR`，避免 shell interpolation)

然而，本次審計發現數個 **High (高風險)** 與 **Medium (中風險)** 漏洞，主要集中在 **Tauri IPC 命令權限範圍未限制 (`open_path`, `open_terminal`)**、**停用 Content Security Policy (`csp: null`)**、**`git archive` 輸出路徑與檔案開啟之符號連結 (Symlink) / 路徑穿越風險**，以及 **`.gitmodules` 子模組路徑未驗證是否逃逸出儲存庫根目錄**。

---

## High Severity Findings (高風險問題)

### 1. `openFile` 與 `open_path` 缺乏路徑正規化與 Symlink 檢查，可導致任意程式/檔案執行
- **位置**:
  - `app/src-tauri/src/system.rs#L53-L65` (`open_path`)
  - `app/web/src/App.svelte#L596-L601` (`openFile`)
- **問題分析**:
  當使用者在檔案列表右鍵選單點擊 **「Open File」** 時，`App.svelte` 直接將儲存庫路徑與檔案路徑字串相加，並呼叫 `open_path`：
  ```ts
  async function openFile(target: FileMenu) {
      const r = repo();
      if (!r) return;
      await invoke('open_path', { path: r + '/' + target.change.newPath, text: null });
  }
  ```
  而在 Rust 端，`open_path` 未驗證 `state.listed(&repo)`，也未執行 `canonicalize()` 或檢查 Symlink，便直接交由 `/usr/bin/open -- <path>` 執行：
  ```rust
  #[tauri::command]
  pub async fn open_path(path: String, text: Option<bool>) -> Result<(), ApiError> {
      tokio::task::spawn_blocking(move || {
          let mut cmd = Command::new("/usr/bin/open");
          if text.unwrap_or(false) {
              cmd.arg("-t");
          }
          let status = cmd
              .arg("--")
              .arg(&path)
              .status()
              .map_err(|e| ApiError::from(format!("open failed: {e}")))?;
          ...
  ```
- **風險影響**:
  1. **惡意儲存庫 Symlink 觸發執行**: 惡意 Git 儲存庫可在工作目錄中提交指向外部應用程式或腳本的 Symlink（例如 `README.md -> /System/Applications/Calculator.app` 或指向儲存庫內的 `.app`、`.command`、`.terminal`、`.pkg`）。當使用者點擊「Open File」預期檢視檔案時，macOS `/usr/bin/open` 會透過 LaunchServices **直接執行**該目標程式或腳本。
  2. **IPC 未受限存取**: 任何 Webview 視窗皆可傳入任意路徑呼叫 `open_path`（且 `text: null` 預設不會加上 `-t`）。
- **修復建議**:
  - 將 `open_path` 改為接收 `(repo: String, relative_path: String, text: Option<bool>)`，先檢查 `state.listed(&repo)`，並採用與 `gg_backend::files::read_worktree_file` (`app/src-tauri/crates/backend/src/files.rs#L48-L65`) 相同的 `canonicalize()` 與 `real.starts_with(&root)` 檢查，拒絕逃逸出儲存庫的 Symlink。
  - 開啟工作樹檔案時強制加上 `-t`（以預設文字編輯器開啟）或攔截可執行套件副檔名（`.app`, `.command`, `.tool`, `.terminal`, `.pkg`）。

---

### 2. `open_terminal` IPC 命令未驗證參數與視窗權限，且 `csp: null` 放大 XSS 至 RCE 風險
- **位置**:
  - `app/src-tauri/src/system.rs#L108-L124` (`open_terminal`)
  - `app/src-tauri/tauri.conf.json#L10-L24`
  - `app/src-tauri/capabilities/default.json`、`app/src-tauri/capabilities/diff.json`
- **問題分析**:
  1. `open_terminal` 接受任意 `cwd: String` 與 `git_args: Option<Vec<String>>`，並透過 `osascript` 在 `Terminal.app` 執行 `cd <cwd> && git <git_args>`。
  2. 與 `repo_op` 不同，`open_terminal` **未檢查 `state.listed(&cwd)`**，且 **未對 `git_args` 執行 `unsafe_arg` 檢查**。
  3. `tauri.conf.json` 設定了 `"withGlobalTauri": true` 與 `"security": { "csp": null }`。在 Tauri 2 中，所有註冊於 `invoke_handler!` 的自訂 `#[tauri::command]` 預設對所有視窗開放（包含用來預覽不受信任 Markdown、KaTeX、Mermaid 的 `diff-*` 視窗）。
- **風險影響**:
  一旦主視窗或 `diff-*` 預覽視窗中的第三方渲染套件（`markdown-it`、`@vscode/markdown-it-katex`、`mermaid`、`monaco.editor.colorize`）出現任何 XSS 漏洞，由於 `csp: null` 無任何阻擋，攻擊腳本可直接呼叫 `window.__TAURI__.core.invoke('open_terminal', { cwd: '/tmp', gitArgs: ['-c', 'alias.x=!...', 'x'] })`（或透過 `settings_set` 修改 `plantuml.jar` 並呼叫 `render_plantuml`），立即取得主機端任意指令執行 (RCE)。
- **修復建議**:
  - 在 `open_terminal` 中驗證 `state.listed(&cwd)`。
  - 不要讓前端直接傳入自由格式的 `git_args: Option<Vec<String>>`，改為定義結構化列舉（例如僅支援開啟 Shell 或 `InteractiveRebase { onto: String }`），並對 `onto` 進行 `unsafe_arg` 驗證。
  - 在具有寫入或執行副作用的 Tauri command (`repo_op`, `open_terminal`, `settings_set`, `state_set`, `open_path`) 中檢查呼叫來源的 `WebviewWindow::label()`，禁止 `diff-*` 視窗呼叫。
  - 於 `tauri.conf.json` 設定嚴格的 Content Security Policy (`csp`)。

---

### 3. `OpRequest::CreateArchive` 與 `ResetFile` 於 `argv_values` 漏檢 `path` 參數，可覆寫任意檔案
- **位置**:
  - `app/src-tauri/crates/backend/src/ops/mod.rs#L139-L143` (`argv_values`)
  - `app/src-tauri/crates/backend/src/ops/stash.rs#L35-L43` (`reset_file`, `create_archive`)
- **問題分析**:
  在 `ops/mod.rs` 的 `argv_values` 中，`ResetFile` 與 `CreateArchive` 皆以 `..` 忽略了 `path` 欄位：
  ```rust
  OpRequest::ResetFile { commit, .. } => vec![commit],
  OpRequest::CreateArchive { reference, .. } => vec![reference],
  ```
  接著 `create_archive` 直接執行：
  ```rust
  git(repo, &["archive", "--format=zip", "-o", &path, &reference], askpass)
  ```
- **風險影響**:
  1. `CreateArchive` 的 `path` 未經過 `unsafe_arg` 檢查（未過濾控制字元或前導 `-`），且後端未限制輸出路徑必須來自原生檔案儲存對話框，因此 IPC 呼叫端可指定任意可寫入路徑（在本地主機或遠端 SSH 伺服器上），以 zip 壓縮檔覆寫任意使用者檔案。
  2. `ResetFile` 的 `path` 同樣未經過控制字元與路徑穿越 (`..`) 驗證。
- **修復建議**:
  - 將 `path` 納入 `argv_values` 的檢查範圍（或針對檔案路徑提供專屬的驗證函式，阻擋 `\0`、`\n`、`\r` 與 `..`）。
  - 對於本地儲存庫的 `CreateArchive`，建議改由 Rust 後端直接呼叫檔案儲存對話框取得目標路徑，而非完全信任前端傳入的任意路徑字串。

---

## Medium Severity Findings (中風險問題)

### 4. `git-graph-core` 子模組路徑穿越 (`.gitmodules` Path Traversal & Existence Oracle)
- **位置**:
  - `vendor/vscode-git-graph-rs/native/core/src/config.rs#L148-L159` (`submodule_root`)
- **問題分析**:
  `submodules` 在讀取 `.gitmodules` 中的 `submodule.<name>.path` 時，`submodule_root` 將 `root.join(path)` 執行 `canonicalize()` 後，**未檢查結果是否仍在 `root` 目錄底下**：
  ```rust
  fn submodule_root(root: &Path, path: &str) -> Option<String> {
      let dir = root.join(path);
      if !dir.join(".git").exists() {
          return None;
      }
      let canonical = dir.canonicalize().ok()?;
      Some(canonical.to_string_lossy().into_owned())
  }
  ```
- **風險影響**:
  惡意儲存庫可在 `.gitmodules` 設定 `path = ../../other-repo` 或絕對路徑：
  1. 可作為目錄探測 Oracle，判斷主機（或遠端 SSH 主機）特定路徑下是否存在 `.git` 並回傳其真實路徑 (`canonicalize`)。
  2. 使用者若在介面點擊該子模組，應用程式會被導向開啟儲存庫外部的其他 Git 儲存庫。
- **修復建議**:
  - 在 `submodule_root` 中同時對 `root` 執行 `canonicalize()`，並強制檢查 `canonical.starts_with(&canonical_root)`。

---

### 5. Diff 視窗 Markdown 預覽允許自動載入外部 `http:` / `https:` 圖片 (隱私洩漏與內部網路探測)
- **位置**:
  - `app/diff/main.js#L222-L235` (`repositoryImages`)
- **問題分析**:
  在預覽 Markdown 檔案時，`repositoryImages` 保留所有 `http:` 與 `https:` 圖片網址：
  ```js
  const src = img.getAttribute('src');
  if (!src || /^(https?:|data:image\/)/i.test(src)) return;
  ```
- **風險影響**:
  當使用者預覽不受信任儲存庫中的 Markdown 檔案時，Webview 會自動向外部伺服器發起 HTTP(S) 請求（洩漏使用者 IP、User-Agent 與檢視時間），或被用來向本機內部服務（如 `http://127.0.0.1:...`）發送 GET 請求。
- **修復建議**:
  - 預設阻擋外部 `http:` / `https:` 圖片（透過 CSP `img-src 'self' data: blob:` 或在 `repositoryImages` 中攔截），並提供使用者手動啟用外部圖片的選項。

---

### 6. `git-graph-core` 的 `working_tree_path` 僅做語法檢查，未阻擋 Symlink 逃逸
- **位置**:
  - `vendor/vscode-git-graph-rs/native/core/src/blob.rs#L133-L145` (`working_tree_path`)
- **問題分析**:
  與 `gg_backend::files::read_worktree_file` 不同，`vendor/vscode-git-graph-rs/native/core/src/blob.rs` 中的 `working_tree_path` 僅檢查 `Component::ParentDir` 與字面上的 `joined.starts_with(root)`，未呼叫 `canonicalize()`：
  ```rust
  fn working_tree_path(root: &Path, path: &str) -> Result<PathBuf, GitError> {
      let joined = root.join(path);
      if !joined.starts_with(root)
          || Path::new(path)
              .components()
              .any(|c| matches!(c, std::path::Component::ParentDir))
      {
          return Err(GitError::InvalidArg(format!("path escapes repo: {path}")));
      }
      Ok(joined)
  }
  ```
  雖然目前 `dispatch.rs` 未將 `blob::working_tree_file` 暴露於 dispatch 方法中，但該函式為 `pub`，若未來被串接使用將允許透過儲存庫內的 Symlink 讀取任意外部檔案。
- **修復建議**:
  - 在 `working_tree_path` 中加入 `canonicalize()` 並確認解析後的真實路徑位於 `root.canonicalize()` 之下。

---

### 7. 遠端代理 (`gg-remote`) 快取目錄權限與未使用的 `Request::Git` 原始執行介面
- **位置**:
  - `app/src-tauri/src/remote.rs#L120-L125` (`BOOTSTRAP`)
  - `app/src-tauri/crates/remote/src/main.rs#L131-L163` (`handle`)
  - `app/src-tauri/crates/backend/src/wire.rs#L13-L25` (`Request`)
- **問題分析**:
  1. `BOOTSTRAP` 腳本執行 `mkdir -p "$d"` 建立 `${XDG_CACHE_HOME:-$HOME/.cache}/your-git-graph` 時未指定 `-m 700`（僅對執行檔本身執行 `chmod 700 "$f.$$"`）。在共用 SSH 伺服器且 `umask` 較寬鬆的環境下，其他使用者可能列出該快取目錄。
  2. `gg-remote` 的通訊協定保留了 `Request::Git { request: GitExecRequest }`，允許直接傳入任意 `args`、`cwd`、`env` 執行 `git`。由於主程式中的 `git_exec` (`app/src-tauri/src/git.rs`) 已標記為 `#[allow(dead_code)]` 且未掛載於 Tauri handler，保留此介面屬於多餘的攻擊面。
- **修復建議**:
  - 將 `BOOTSTRAP` 中的 `mkdir -p "$d"` 改為 `mkdir -m 700 -p "$d"`。
  - 從 `wire.rs` 與 `crates/remote/src/main.rs` 移除未使用的 `Request::Git` 分支與 `git.rs`。

---

## Low / Informational Findings (低風險與建議事項)

### 8. `engine_request` 直接暴露底層 `git_graph_core::dispatch::request`
- **位置**:
  - `app/src-tauri/src/main.rs#L73-L108` (`engine_request`)
- **說明**:
  前端目前已全面改用強型別的 `repo_read`，但 `main.rs` 仍將 `engine_request` 暴露給所有 Webview 視窗。
- **修復建議**:
  - 若前端已不再呼叫 `engine_request`，建議將其自 `tauri::generate_handler!` 移除，統一由 `repo_read` 作為唯一讀取入口。

---

### 9. Commit 搜尋功能 (`find.ts`) 之正規表示式 ReDoS 風險
- **位置**:
  - `app/web/src/lib/find.ts#L6-L18` (`compileQuery`)
- **說明**:
  當開啟 Regex 搜尋模式時，`compileQuery` 於每次按鍵輸入 (`oninput`) 同步在主執行緒上對所有已載入的 Commit 執行 `new RegExp(query, flags).test(...)`。若輸入具有災難性回溯 (Catastrophic Backtracking) 的正規表示式（如 `(a+)+b`），可能導致 UI 執行緒暫時卡死。
- **修復建議**:
  - 對搜尋輸入加入 Debounce，或限制單次掃描時間 / 移至 Web Worker 執行。

---

### 10. 自動對本地不受信任儲存庫執行外部 `git` CLI 命令
- **位置**:
  - `app/src-tauri/crates/backend/src/watch.rs#L78-L90` (`is_ignored`)
  - `app/src-tauri/crates/backend/src/repo.rs#L156-L163` (`operation_state`)
- **說明**:
  雖然 Commit Graph 載入使用 `libgit2`（不會執行 `.git/config` 中的外部指令），但開啟儲存庫與檔案變動監聽 (`watch.rs`) 時會自動呼叫外部 `git` 執行檔（如 `git check-ignore`、`git diff`、`git rev-list`）。若使用者開啟來路不明的本地 `.git` 目錄，惡意 `.git/config` 中的 `core.fsmonitor` 或 `diff.external` 會被 `git` CLI 執行。
- **修復建議**:
  - 在 `watch.rs` 的 `is_ignored` 中改用 `git2::Repository::status_should_ignore` 取代呼叫外部 `git check-ignore` 子行程；對背景唯讀 `git` 命令可加上 `-c core.fsmonitor=false`。

---

## Positive Security Controls Observed (現有良好安全機制)

| 領域 | 實作位置 | 安全機制說明 |
| :--- | :--- | :--- |
| **儲存庫存取白名單** | `app/src-tauri/src/state.rs#L112-L120` | `StateStore::listed` 確保 `repo_read`、`repo_op`、`worktree_file`、`export_repo_config` 僅能操作使用者已加入側邊欄的儲存庫。 |
| **Git 參數注入防護** | `app/src-tauri/crates/backend/src/ops/mod.rs#L53-L59` | `unsafe_arg` 阻擋空字串、前導 `-` 與控制字元 (`\0`, `\n`, `\r`)，防止 `--upload-pack` 等選項注入。 |
| **Rebase 參數環境變數隔離** | `app/src-tauri/crates/backend/src/ops/history.rs#L55-L125` | Interactive Rebase 的 Todo、Message 與 Author 皆透過環境變數 (`GG_TODO`、`GG_MESSAGE`、`GG_AUTHOR`) 與 `sh -c '... "$1"' -` 傳遞，避免命令注入。 |
| **SSH 連線目標嚴格驗證** | `app/src-tauri/src/remote.rs#L24-L82` | `remote::parse` 嚴格檢查 `user`、`host`、`port` 字元集並拒絕前導 `-`，且加上 `-o RemoteCommand=none -o ClearAllForwardings=yes --`。 |
| **Askpass Socket 認證** | `app/src-tauri/crates/backend/src/askpass.rs#L97-L143` | 於 `$TMPDIR` 建立 `0700` 專屬目錄與 128-bit 隨機 hex token，並使用 `MSG_PEEK \| MSG_DONTWAIT` 偵測連線中斷。 |
| **Worktree 讀取防穿越** | `app/src-tauri/crates/backend/src/files.rs#L48-L65` | `read_worktree_file` 對 `repo` 與目標檔案皆執行 `canonicalize()` 並檢查 `real.starts_with(&root)`，阻擋 Symlink 逃逸。 |
| **PlantUML 沙箱隔離** | `app/src-tauri/src/plantuml.rs#L83-L94` | 強制加上 `-DPLANTUML_SECURITY_PROFILE=SANDBOX` 與 `-Djava.awt.headless=true`，且前端以 `<img src="data:image/svg+xml;base64,...">` 渲染，避免內嵌 `<svg>` 腳本執行。 |

---

## 驗證與修復結果（2026-11-08，Claude Code 逐項對照程式碼與實測）

報告引用的程式碼有多處與實際不符（`open_path` 不是 async、沒有 `ApiError`；`git archive` 沒有 `--format=zip`；`compileQuery` 實際是 `matcherFor`；`git.rs` 已沒有 `git_exec`；引擎用的是 gix，不是 libgit2），所以每項都重新確認過。

| # | 結論 | 處理 |
|---|---|---|
| 1 | **成立**。clone 下來的檔案沒有 quarantine，`open` 會直接執行 `.command` 與指向 App 的 symlink | `open_path` 移除。`open_repo_file(repo, path)`：檢查側欄白名單，`files::inside_repo` 拒絕逃出 repo 的 symlink；會執行的檔案（`RUNS_WHEN_OPENED`、沒有副檔名的可執行檔）改用文字編輯器開；資料夾只在 Finder 顯示。另有 `reveal_repo`、`open_settings_file`、`open_session_log`，都不收任意路徑 |
| 2 | **成立**（`state_set` 還能自己把路徑加進白名單） | `open_terminal` 檢查白名單，不再收 git 參數（前端本來就沒傳；內部 `system::terminal` 只給 ops）。`AppManifest::commands` 讓所有 command 改為需授權，diff 視窗只有 7 個讀取類。CSP 啟用 |
| 3 | **部分成立，嚴重度高估**。`ResetFile` 不成立：實測 git 自己拒絕 `../`，`--` 之後的 `-` 開頭不是選項。`CreateArchive` 的路徑確實沒檢查，但要先能在主視窗執行腳本，那時 `repo_op` 能做的事更多 | `CreateArchive` 的路徑納入 `argv_values`。不改成 Rust 端開對話框：沒有實質收益 |
| 4 | **程式碼描述正確，但碰不到**。App 沒有任何地方呼叫 `submodules`，也沒有報告說的「點擊子模組」介面 | `vendor/` 不改（專案規定）。`engine_request` 只接受 diff 視窗要用的 5 個方法，頁面呼叫不到 |
| 5 | **成立** | `http(s)` 圖片預設不載入，頁面上方顯示數量與 Load 按鈕（只影響該文件）。CSP 的 `img-src` 必須允許 `http: https:` 才能讓按鈕生效，所以攔截在 `diff/main.js`，不在 CSP |
| 6 | **不成立**。`working_tree_path` 是私有函式，`dispatch.rs` 走不到它 | 不改 |
| 7 | **部分成立**。`mkdir` 沒有 700 屬實；`Request::Git` 確實無人使用，但只有 App 經 ssh 送得到，不是實質攻擊面；報告提到的 `git_exec` 已不存在 | `mkdir -m 700`。移除 `Request::Git` 與 `O`／`S` frame；原本經由它的測試改走 `op`（這才是正式路徑） |
| 8 | **前提錯誤**。diff 視窗仍在使用 `engine_request`，不能移除 | 不移除，改用第 4 項的方法白名單 |
| 9 | **不算安全問題**。pattern 是使用者自己輸入的，只會卡住自己的視窗 | 不改 |
| 10 | **成立，範圍比報告廣**。實測 `git check-ignore`、`git diff --cached --quiet`、`git diff --name-only` 都會啟動 `.git/config` 的 `core.fsmonitor`；`diff --name-only` 還會跑 clean filter。引擎實測不會。報告建議的 `git2` 不適用 | `git::config_overrides` 對每次 git 關掉 `core.fsmonitor`；衝突檔案改用 `ls-files --unmerged` |

「現有良好安全機制」也有一處不正確：`unsafe_arg` 只擋前導 `-`，不擋空字串與控制字元。argv 不經 shell，所以目前不構成問題。

### 驗證

- `npm test`（63 個）、`npm run check`、`cargo test --workspace`（174 個）全部通過。
- self-test：debug 版的單一 repo 與多 repo 資料夾、release `.app` 的單一 repo 都 PASS。新增檢查（第 5b 項）：`eval` 被 CSP 擋下、全程沒有其他東西被 CSP 擋掉、diff 視窗呼叫 10 個危險 command 全部回 not allowed、網路圖片不載入。
- 看過 release 版的畫面：graph、Markdown 預覽（KaTeX、Mermaid、Monaco、Load 按鈕）顯示正常。

### 仍存在的限制

- **主視窗仍可呼叫所有 command**，它的防線是 CSP 與 `html: false` 等渲染設定。
- **`RUNS_WHEN_OPENED` 是黑名單**，無法窮舉 macOS 所有會執行的類型。
- **Open File 沒有端對端點過**（會開外部 App）：路徑判斷與分類有單元測試，`open` 的實際行為沒有自動化驗證。
- **不受信任的 `.git` 目錄仍有風險**：使用者發動的操作照常跑 hook、filter、merge driver，這是 git 的語意。實測 `git merge-tree --write-tree` 會執行 `merge.<driver>.driver`，但 `predictConflicts` 目前在前端沒有呼叫者，打開 Merge／Rebase／Cherry-pick 對話框不會觸發；將來接上 UI 時要關掉 merge driver（見 `CLAUDE.md`）。
