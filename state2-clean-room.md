# Stage 2 Clean-Room Code Review & 公開發布授權審查報告

本文件彙整對 `stage-2` 分支（commit `f6fa97d`）的完整 Code Review、測試驗證，以及公開發布（GitHub 原始碼與 `.app` / `.dmg` 二進位發布）的版權／授權合規審查結果，供 Claude 檢視並逐項修復。

> **注意**：以下審查與後續修復皆須嚴格遵守 `CLAUDE.md` 的淨室原則（Clean-room rule），切勿讀取 `vendor/vscode-git-graph-rs/` 內除 `native/`、`LICENSE`、`licenses/` 以外的禁止檔案，亦不可讀取 `main` 分支上的 Stage 1 衍生檔案。

---

## 一、現況驗證摘要

- `bash app/scripts/check-cleanroom.sh`：**通過**（`clean room: ok`）
- `cargo test --workspace`：**通過**（166 tests：93 unit + 36 `ops` integration + 8 `gg-remote` + 29 `git-graph-app`）
- `npx vitest run`：**通過**（14 test files, 58 tests）
- `npx svelte-check`：**通過**（0 errors, 0 warnings）
- 編譯產物依賴檢查：`git-graph-app` 與 `gg-remote` 僅連結 `vendor/vscode-git-graph-rs/native/core`（MIT 授權），未打包任何上游受限前端、圖示或 VS Code 延伸模組程式碼。

---

## 二、公開發布的版權與授權合規問題（Blockers）

### 1. [Blocker] 根目錄 `LICENSE` 仍保留 Stage 1「禁止發布 `.app` / `.dmg`」條文
- **位置**：`LICENSE` 第 22–42 行
- **問題描述**：
  - `LICENSE` 檔案內容仍停留在 Stage 1，第 36–39 行明確寫著：
    > `- Builds of the app. A build bundles that webview (media/out.min.js and its stylesheet, copied in by app/scripts/prepare-ui.mjs), so a built app may be used by whoever built it but must not be distributed (no .app, .dmg or other binary releases).`
  - 此外，`app/src-tauri/tauri.conf.json` 第 37 行將 `../../LICENSE` 打包進 `.app/Contents/Resources/LICENSE`。這導致建置出的 `.app` 內含禁止散布自身的授權聲明，且與 `README.md`（第 72–76 行）及 `THIRD-PARTY.md` 矛盾。
- **修復要求**：
  - 更新根目錄 `LICENSE`，移除 Stage 1 針對 `mhutchie/vscode-git-graph` webview 與 `prepare-ui.mjs` 的禁止散布說明。
  - 明確反映 Stage 2 架構：本專案自有程式碼為 MIT 授權，且仅使用 `vendor/vscode-git-graph-rs/native/core`（MIT 授權）與 `THIRD-PARTY.md` 所列之開放原始碼相依套件，原始碼與二進位建置產物（`.app` / `.dmg` / `gg-remote`）皆可依 MIT 與各套件授權條款公開散布。

### 2. [Blocker] `THIRD-PARTY.md` 的 MIT 授權條款全文與著作權人署名補齊
- **位置**：`THIRD-PARTY.md` 第 6 行、第 19 行
- **問題描述**：
  - `vendor/vscode-git-graph-rs/LICENSE` 第 3 行標示 `Copyright (c) 2026 penghongxia`（而 `vendor/vscode-git-graph-rs/licenses/LICENSE-MIT` 為 `Copyright (c) 2026 neophack`），`THIRD-PARTY.md` 第 19 行與 `app/scripts/third-party.mjs` 僅列出 `2026 neophack`。
  - MIT 等授權條款要求散布二進位時「The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software」，但目前 `THIRD-PARTY.md` 第 6 行僅寫 *"The licence text of each part is in its source repository"*，未附授權全文。
- **修復要求**：
  - 更新 `app/scripts/third-party.mjs`並重新產生 `THIRD-PARTY.md`：
    1. 將 `git-graph-core` 的著作權聲明更新為同時涵蓋 `2026 penghongxia, neophack`（或完整引用 `vendor/vscode-git-graph-rs/LICENSE` 內對 `./native/` 的 MIT 授權段落）。
    2. 在 `THIRD-PARTY.md` 尾端附上所使用開放原始碼授權（MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、MPL-2.0、Unicode-3.0、Zlib、Unlicense）的標準條款全文，或確保打包進 `.app/Contents/Resources/` 的授權文件包含完整 permission notice。

### 3. [Blocker] Git 歷史含 Stage 1 受限衍生作品（發布至公開 Repo 前需清理歷史）
- **問題描述**：
  - `CLAUDE.md` 第 18 行要求：「裡面的歷史含上游內容，不要把它的 ref 或 tag 推到公開 repo。」
  - 但目前 `stage-2` 分支是由 `main`（`2301958`，即 `v0.7.0`）直接分支出來，`git merge-base main stage-2` 為 `2301958`。因此 Stage 1 的 26 個 commits（含 `app/ui/host/main.js`、`app/ui/shim.js`、`app/scripts/prepare-ui.mjs`、`app/scripts/zh-tw.mjs`、`app/ui/theme.css` 等上游衍生檔案）全部存在於 `stage-2` 的 Git commit 祖先歷史中，且目前 `origin/main`（`git@github.com:kigichang/your-git-graph.git`）也指向 `2301958`。
- **修復要求**：
  - 在所有 Stage 2 修復完成並準備同步至公開 repo 時，需將 `stage-2` 重建為 **不含 Stage 1 歷史的全新根分支（orphan branch 或從移除 Stage 1 檔案後的乾淨快照作為初始 commit）**，或確認使用者是否要將 `stage-2` 壓縮／rebase 至乾淨 root commit 後再強推至 `origin/main` 並刪除遠端舊 tag（`v0.1.0`～`v0.7.0`）。*(註：執行破壞性 Git 歷史改寫與 force push 前，請先向使用者確認。)*
  - 另外注意：若在 GitHub Release 發布，請勿上傳包含整個 `vendor/vscode-git-graph-rs` 子模組非 `native/` 目錄的打包檔。

---

## 三、Stage 2 功能缺漏與待修復項目（Code Review Findings）

### 1. 設定面板（`SettingsPanel.svelte`）中 4 個設定未接線（Dead Settings）

#### (1) `graph.style`（`"rounded"` | `"angular"`）未傳遞且未實作折線繪製
- **位置**：
  - `app/web/src/lib/components/SettingsPanel.svelte` 第 26–30 行
  - `app/web/src/App.svelte` 第 365–398 行
  - `app/web/src/lib/components/GraphTable.svelte`、`GraphCanvas.svelte`
  - `app/web/src/lib/graph/draw.ts` 第 50–120 行
- **問題描述**：
  - `SettingsPanel.svelte` 有 `graph.style` 下拉選單，但 `App.svelte` 未傳入 `GraphTable` / `GraphCanvas`。
  - `drawRows()`（`app/web/src/lib/graph/draw.ts` 第 100 行）一律使用 `ctx.bezierCurveTo(...)` 繪製曲線，未根據 `style === 'angular'` 改用直線段（`ctx.lineTo`）繪製折角連線。
- **修復要求**：
  - 在 `DrawOpts`（`draw.ts`）加入 `style?: 'rounded' | 'angular'`，當 `style === 'angular'` 時以折角直線繪製跨欄連線。
  - 從 `App.svelte` → `GraphTable.svelte` → `GraphCanvas.svelte` 傳遞 `settings.current.graph.style`。
  - 在 `app/web/src/lib/graph/__tests__/draw.test.ts` 補上 `angular` 與 `rounded` 的單元測試。

#### (2) `graph.stickyHeader`（表頭固定）未接線
- **位置**：
  - `app/web/src/lib/components/SettingsPanel.svelte` 第 31–32 行
  - `app/web/src/App.svelte` 第 365–398 行
  - `app/web/src/lib/components/GraphTable.svelte` 第 126–157 行
- **問題描述**：
  - `SettingsPanel.svelte` 提供 `graph.stickyHeader` 開關，但 `App.svelte` 與 `GraphTable.svelte` 完全沒有讀取此設定，`.gg-header` 永遠固定在 `.gg-viewport` 外部。
- **修復要求**：
  - 將 `stickyHeader={settings.current.graph.stickyHeader}` 傳入 `GraphTable.svelte`。
  - 當 `stickyHeader` 為 `true` 時維持表頭固定；當 `stickyHeader` 為 `false` 時讓表頭隨 `.gg-viewport` 一起捲動（或依 CSS sticky 切換）。

#### (3) `commits.markdown`（訊息簡易 Markdown）未接線
- **位置**：
  - `app/web/src/lib/components/SettingsPanel.svelte` 第 41–42 行
  - `app/web/src/lib/components/GraphTable.svelte` 第 185 行
  - `app/web/src/lib/components/DetailsPanel.svelte` 第 251 行
- **問題描述**：
  - `SettingsPanel.svelte` 提供 `commits.markdown` 開關，但 commit 列表的 `<span class="gg-message">{commit.message}</span>` 與詳細面板的 commit message 皆只做純文字渲染，未讀取 `commits.markdown`。
- **修復要求**：
  - 實作安全的行內簡易 Markdown 渲染（例如處理 `` `code` ``、`**bold**`、`*italic*`，務必先 escape HTML 防止 XSS），並在 `settings.current.commits.markdown` 為 `true` 時套用至 `GraphTable.svelte` 與 `DetailsPanel.svelte` 的 commit 訊息顯示，並補上單元測試。

#### (4) `log.enabled` 開啟時前端未傳遞 `persist: true` 給 `host_log`
- **位置**：
  - `CLAUDE.md` 第 215 行
  - `app/src-tauri/src/main.rs` 第 87–95 行
  - `app/web/src/lib/api/client.ts` 第 102 行
  - `app/diff/main.js` 第 20 行
- **問題描述**：
  - `CLAUDE.md` 載明：`enableLog`（Stage 2：`log.enabled`）開啟時 `host_log` 也會寫入 `session.log`。
  - 後端 `main.rs` 的 `host_log(state, line, persist)` 只有在 `persist == Some(true)` 時才會寫入 `session.log`（或者後端可直接讀取 `state.settings` 的 `log.enabled`）。
  - 前端 `client.ts` 的 `log(line)` 只呼叫 `invoke<void>('host_log', { line })` 未傳 `persist`，導致 `session.log` 永遠不會被寫入。
- **修復要求**：
  - 可在後端 `host_log`（`app/src-tauri/src/main.rs`）中當 `persist` 為 `None` 時自動檢查 `state.settings` 內的 `log.enabled`，及／或在前端呼叫 `host_log` 時傳入 `persist: settings.current.log.enabled`。

---

### 2. 「匯出倉庫設定（Export Repository Config）」缺少 UI 按鈕入口
- **位置**：
  - `README.md` 第 70 行
  - `app/web/src/App.svelte` 第 124–132 行、第 252 行
  - `app/web/src/lib/components/SettingsPanel.svelte`
  - `app/web/src/lib/i18n/zh-TW.ts`、`en.ts`
- **問題描述**：
  - `README.md` 說明可透過「Export Repository Config」將倉庫設定匯出至 `<repo>/.your-git-graph.json`。
  - `App.svelte` 已實作 `exportRepoState()` 並掛載於 `window.__gg.app.exportRepoState` 供 `selftest.ts` 測試，但 UI（如 `SettingsPanel.svelte` 或 `Toolbar.svelte`）中**沒有任何按鈕**呼叫 `exportRepoState()`，一般使用者無法從介面觸發此功能。
- **修復要求**：
  - 在 `SettingsPanel.svelte`（或適合的工具列／選單位置）新增「匯出倉庫設定 / Export Repository Config」按鈕，綁定 `exportRepoState()`，並在匯出成功／失敗時給予狀態提示或通知。

---

### 3. 後端 `repo_read` / `repo_op` 缺少視窗側欄清單路由檢查（M5 驗收項）
- **位置**：
  - `CLAUDE.md` 第 134 行（M5）
  - `app/docs/spec/99-acceptance.md` 第 12 行（驗收標準 #5）
  - `app/src-tauri/src/api.rs` 第 49–77 行
  - `app/src-tauri/src/repos.rs`
- **問題描述**：
  - `CLAUDE.md` M5 與 `99-acceptance.md` #5 均規定：「路由只接受這個視窗側欄清單裡的 repo（拒絕其他視窗沒有的 repo 路徑）」。
  - 目前 `app/src-tauri/src/api.rs` 的 `repo_read` 與 `repo_op` 未檢查傳入的 `repo` 是否存在於該視窗（或已註冊的倉庫清單）中，任何路徑傳入都會直接執行。
- **修復要求**：
  - 在 `repo_read` 與 `repo_op`（`app/src-tauri/src/api.rs`）中加入 `window: tauri::WebviewWindow` 與 `windows: State<'_, repos::Windows>`（或 `state: State<'_, AppState>`）檢查，確認 `repo` 屬於該視窗允許操作的倉庫清單，否則回傳 `ApiError` 拒絕請求。
  - 在 `selftest.ts` 或後端測試中補上拒絕未列於側欄之 repo 路徑的測試驗證。

---

### 4. 圖表鍵盤導覽缺少 `Enter` 鍵重開詳細面板（規格 `10-graph.md`）
- **位置**：
  - `app/docs/spec/10-graph.md` 第 27 行
  - `app/web/src/lib/components/GraphTable.svelte` 第 107–124 行
- **問題描述**：
  - `10-graph.md` 規定鍵盤快捷鍵：`↑` / `↓` 移動選取、`Home` / `End` 跳首尾、`Enter` 開啟詳細、`Esc` 關閉詳細或對話框、`⌘F` 開啟 Find、`⌘J` 聚焦分支選單。
  - `GraphTable.svelte` 的 `onKeydown` 處理了 `ArrowDown`、`ArrowUp`、`Home`、`End`、`Escape`、`⌘J`，但漏掉了 `Enter`（當使用者按 `Escape` 關閉詳細面板後，選中列仍在，但按 `Enter` 不會重新開啟詳細面板）。
- **修復要求**：
  - 在 `GraphTable.svelte` 的 `onKeydown` 加入 `else if (e.key === 'Enter' && selectedRow >= 0 && selectedRow < rows.length)`，觸發開啟該列的詳細面板。

---

### 5. 規格文件 `app/docs/spec/*.md` 狀態收尾（選修／文件同步）
- **位置**：`app/docs/spec/README.md` 及 `00-overview.md`～`80-reflog-worktree.md`、`95-remote-askpass-watch.md`
- **問題描述**：
  - `app/docs/spec/README.md` 的狀態表與多份規格檔內文仍標記為「骨架」與「待填」，與目前已完成的 M0～M8 實作狀態不同步。
- **修復要求**：
  - 更新 `app/docs/spec/README.md` 狀態表為已完成，並視需要清理各規格檔案中的「待填」佔位文字，使其與最終 Stage 2 實作一致。
