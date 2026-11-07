# Stage 2 Clean-Room Code Review & 公開發布授權審查報告

本文件彙整對 `stage-2` 分支（commit `f6fa97d`）的完整 Code Review、測試驗證，以及公開發布（GitHub 原始碼與 `.app` / `.dmg` 二進位發布）的版權／授權合規審查結果，供 Claude 檢視並逐項修復。

> **注意**：以下審查與後續修復皆須嚴格遵守 `CLAUDE.md` 的淨室原則（Clean-room rule），切勿讀取 `vendor/vscode-git-graph-rs/` 內除 `native/`、`LICENSE`、`licenses/` 以外的禁止檔案，亦不可讀取 `main` 分支上的 Stage 1 衍生檔案。

> **修復狀態（2026-11-07，Claude）**：除了「二-3 Git 歷史」依使用者決定暫不處理之外，各項都已查證屬實並修復，commit 為 `f2d78ca`、`c786be1`、`5363090`（都還沒推送）。每一項下方的「**修復**」段落說明做了什麼。
>
> | 項目 | 狀態 | Commit |
> |---|---|---|
> | 二-1 `LICENSE` 的 Stage 1 條文 | ✅ 已修 | `f2d78ca` |
> | 二-2 `THIRD-PARTY.md` 的著作權人與授權全文 | ✅ 已修 | `f2d78ca` |
> | 二-3 Git 歷史含 Stage 1 | ⏸ 使用者決定暫不處理 | — |
> | 三-1 四個設定沒接上 | ✅ 已修 | `f2d78ca` |
> | 三-2 匯出儲存庫設定的按鈕 | ✅ 已修 | `f2d78ca` |
> | 三-3 只接受側欄裡的 repo | ✅ 已修（範圍比報告大） | `f2d78ca` |
> | 三-4 Enter 鍵 | ✅ 已修 | `f2d78ca` |
> | 三-5 規格文件 | ✅ 已修 | `5363090` |
> | （另外）設定改動一律重新載入 graph、Esc 會連詳細資料一起關 | ✅ 已修 | `f2d78ca`、`c786be1` |

---

## 一、現況驗證摘要

- `bash app/scripts/check-cleanroom.sh`：**通過**（`clean room: ok`）
- `cargo test --workspace`：**通過**（166 tests：93 unit + 36 `ops` integration + 8 `gg-remote` + 29 `git-graph-app`）
- `npx vitest run`：**通過**（14 test files, 58 tests）
- `npx svelte-check`：**通過**（0 errors, 0 warnings）
- 編譯產物依賴檢查：`git-graph-app` 與 `gg-remote` 僅連結 `vendor/vscode-git-graph-rs/native/core`（MIT 授權），未打包任何上游受限前端、圖示或 VS Code 延伸模組程式碼。

**修復後**（`5363090`）：
- `check-cleanroom.sh`：通過。
- `cargo test --workspace`：167 個通過（App 30，多了 `state.rs` 的側欄檢查測試）。
- vitest：15 個檔案、62 個通過（多了 `marks.test.ts` 與 `draw.test.ts` 的線條風格測試）。
- svelte-check：0 errors、0 warnings。
- self-test：單一 repo、多 repo 資料夾、release 版 `.app` 都是 `selftest: PASS`；帳密伺服器兩次都收到帳密；`session.log` 只寫進了 `log.enabled` 開著時的那一行；三個 scratch repo 跑完後是乾淨的。release 版 `.app` 是在 `c786be1`（Esc 的修正）之前打包測的，那個修正很小，debug 版已經測過。

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
- **修復**（`f2d78ca`）：重寫 `LICENSE` 的 Scope 段落，MIT 授權本文不變。
  - 刪掉 Stage 1 對 webview 與 `prepare-ui.mjs` 的說明，也刪掉禁止散布打包產物的條文。
  - 授權範圍是 `vendor/` 以外的全部檔案。submodule 只有 `native/`（MIT，"Copyright (c) 2026 penghongxia"）會建進 App 與遠端 helper；上游受 Git Graph 授權的部分既不使用，也不在任何打包產物裡。
  - 打包產物（`.app`、`.dmg`、`gg-remote`）只包含本專案的程式碼、引擎，以及 `THIRD-PARTY.md` 列出的套件，可以依本授權與各套件的授權散布。每個打包產物都在 `Contents/Resources` 附上 `THIRD-PARTY.md` 與 `LICENSE`。
  - `README.md` 原本就寫可以散布，不必改。

### 2. [Blocker] `THIRD-PARTY.md` 的 MIT 授權條款全文與著作權人署名補齊
- **位置**：`THIRD-PARTY.md` 第 6 行、第 19 行
- **問題描述**：
  - `vendor/vscode-git-graph-rs/LICENSE` 第 3 行標示 `Copyright (c) 2026 penghongxia`（而 `vendor/vscode-git-graph-rs/licenses/LICENSE-MIT` 為 `Copyright (c) 2026 neophack`），`THIRD-PARTY.md` 第 19 行與 `app/scripts/third-party.mjs` 僅列出 `2026 neophack`。
  - MIT 等授權條款要求散布二進位時「The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software」，但目前 `THIRD-PARTY.md` 第 6 行僅寫 *"The licence text of each part is in its source repository"*，未附授權全文。
- **修復要求**：
  - 更新 `app/scripts/third-party.mjs`並重新產生 `THIRD-PARTY.md`：
    1. 將 `git-graph-core` 的著作權聲明更新為同時涵蓋 `2026 penghongxia, neophack`（或完整引用 `vendor/vscode-git-graph-rs/LICENSE` 內對 `./native/` 的 MIT 授權段落）。
    2. 在 `THIRD-PARTY.md` 尾端附上所使用開放原始碼授權（MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、MPL-2.0、Unicode-3.0、Zlib、Unlicense）的標準條款全文，或確保打包進 `.app/Contents/Resources/` 的授權文件包含完整 permission notice。
- **修復**（`f2d78ca`）：改寫 `app/scripts/third-party.mjs`，重新產生 `THIRD-PARTY.md`（約 450 KB）。
  1. **引擎**：照錄兩段原文。一段是 `vendor/vscode-git-graph-rs/LICENSE` 對原創部分（含 `./native/`）的授權（"Copyright (c) 2026 penghongxia" 加上 permission notice），另一段是 `licenses/LICENSE-MIT` 全文（"Copyright (c) 2026 neophack"）。兩段都由腳本從這兩個檔案讀出，不是手寫。
  2. **授權全文**：檔案最後新增「Licence texts」一節，共 233 段。
     - 選用的授權：「A OR B」有 MIT 就用 MIT，否則用 Apache-2.0；「A AND B」兩者都附。
     - 條文來源：每個套件自己附的授權檔。489 個 crate 中有 39 個沒附，就用標準條文，著作權人填 manifest 的作者；MIT 用本 repo `LICENSE` 的本文，Apache-2.0 用引擎 `licenses/LICENSE-APACHE`，BSD-3-Clause 用標準條文。
     - 相同的條文只印一次，並列出用到它的套件。Apache-2.0 套件有 `NOTICE` 檔時一併附上（目前沒有）。
  3. 報告的授權清單漏了兩種：**MPL-2.0**（cssparser、selectors 等）與 **EPL-2.0**（elkjs，Markdown 預覽的圖表排版）。這兩種授權要求告訴使用者去哪裡取得原始碼，因此新增「Source code」一節：所有套件都原樣使用、沒有修改，原始碼在表格連到的 repository，以及 crates.io／npm 上對應版本的套件。
  4. `build-app.sh` 原本就會跑這個腳本，並確認 `Contents/Resources/THIRD-PARTY.md` 存在；這次打包後確認過檔案在裡面。

### 3. [Blocker] Git 歷史含 Stage 1 受限衍生作品（發布至公開 Repo 前需清理歷史）
- **問題描述**：
  - `CLAUDE.md` 第 18 行要求：「裡面的歷史含上游內容，不要把它的 ref 或 tag 推到公開 repo。」
  - 但目前 `stage-2` 分支是由 `main`（`2301958`，即 `v0.7.0`）直接分支出來，`git merge-base main stage-2` 為 `2301958`。因此 Stage 1 的 26 個 commits（含 `app/ui/host/main.js`、`app/ui/shim.js`、`app/scripts/prepare-ui.mjs`、`app/scripts/zh-tw.mjs`、`app/ui/theme.css` 等上游衍生檔案）全部存在於 `stage-2` 的 Git commit 祖先歷史中，且目前 `origin/main`（`git@github.com:kigichang/your-git-graph.git`）也指向 `2301958`。
- **修復要求**：
  - 在所有 Stage 2 修復完成並準備同步至公開 repo 時，需將 `stage-2` 重建為 **不含 Stage 1 歷史的全新根分支（orphan branch 或從移除 Stage 1 檔案後的乾淨快照作為初始 commit）**，或確認使用者是否要將 `stage-2` 壓縮／rebase 至乾淨 root commit 後再強推至 `origin/main` 並刪除遠端舊 tag（`v0.1.0`～`v0.7.0`）。*(註：執行破壞性 Git 歷史改寫與 force push 前，請先向使用者確認。)*
  - 另外注意：若在 GitHub Release 發布，請勿上傳包含整個 `vendor/vscode-git-graph-rs` 子模組非 `native/` 目錄的打包檔。
- **狀態：使用者決定暫不處理**。查證後屬實，而且比報告寫的更嚴重：公開 repo `kigichang/your-git-graph` 的 `main`（`2301958`）與 tag `v0.3.3`～`v0.7.0` **已經在遠端**，內容就是 Stage 1 的歷史，裡面有從上游衍生的檔案（`git ls-remote origin` 確認過；遠端沒有 `v0.1.0`～`v0.3.2`）。清理需要做兩件事：用 stage-2 目前的內容建一個沒有父 commit 的新分支（或把 M0～M8 的 commit 接到一個乾淨的 root 上），強推到 `origin/main`；再刪除遠端的這些 tag。這是不可逆的動作，等使用者決定才做。GitHub Release 的提醒照辦：發布時只上傳 `.app`／`.dmg`。

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
- **修復**（`f2d78ca`）：
  - `draw.ts` 的 `DrawOptions` 加上 `style?: GraphStyle`。`angular` 時換 lane 畫成一條斜直線（`lineTo`）；跨過 inline 詳細資料的空白時，同樣先直線穿過，再在最後一列的高度內斜過去。
  - 設定由 `App.svelte` 傳到 `GraphTable`（`graphStyle`），再傳到 `GraphCanvas`（`style`）。
  - 測試放在 `app/web/src/lib/graph/draw.test.ts`（專案沒有 `__tests__` 目錄）：rounded 是曲線；angular 沒有曲線、從節點直線連到下一個節點；跨空白時的畫法。
  - self-test 14e：改成 angular 後 canvas 重畫。

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
- **修復**（`f2d78ca`）：
  - `GraphTable` 加上 `stickyHeader` 屬性，表頭改寫成 snippet：固定時放在 viewport 外面（和原本一樣），不固定時放進 viewport、跟著列一起捲動。
  - 不固定時，列的位置一律加上表頭的高度（`headerOffset`）：可視範圍、`reveal`、`showRow` 都用它，傳給 canvas 的 `scrollTop` 扣掉它（可能是負的）。
  - self-test 14d：關掉後表頭在 viewport 裡、第一列緊接在表頭下方，改回後又固定。

#### (3) `commits.markdown`（訊息簡易 Markdown）未接線
- **位置**：
  - `app/web/src/lib/components/SettingsPanel.svelte` 第 41–42 行
  - `app/web/src/lib/components/GraphTable.svelte` 第 185 行
  - `app/web/src/lib/components/DetailsPanel.svelte` 第 251 行
- **問題描述**：
  - `SettingsPanel.svelte` 提供 `commits.markdown` 開關，但 commit 列表的 `<span class="gg-message">{commit.message}</span>` 與詳細面板的 commit message 皆只做純文字渲染，未讀取 `commits.markdown`。
- **修復要求**：
  - 實作安全的行內簡易 Markdown 渲染（例如處理 `` `code` ``、`**bold**`、`*italic*`，務必先 escape HTML 防止 XSS），並在 `settings.current.commits.markdown` 為 `true` 時套用至 `GraphTable.svelte` 與 `DetailsPanel.svelte` 的 commit 訊息顯示，並補上單元測試。
- **修復**（`f2d78ca`）：
  - 新增 `lib/marks.ts`：把訊息切成 text／code／strong／em 四種片段。支援 `` `code` ``、`**粗**`／`__粗__`、`*斜*`／`_斜_`；底線只在字的邊界才算（`snake_case` 不變）；反引號裡的記號當文字。
  - 新增 `Message.svelte`：只產生文字節點與 `<code>`／`<strong>`／`<em>`，**不用 `{@html}`**，所以不必 escape，也不會被注入 HTML。
  - 套用在 graph 的列與詳細資料面板的訊息，依 `commits.markdown` 開關。
  - 單元測試 `marks.test.ts`（3 個）：標記、非標記（snake_case、`2 * 3`、未閉合的反引號）、HTML 只會是文字、關掉時整段都是文字。

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
- **修復**（`f2d78ca`）：採用第一種做法。`host_log` 在 `persist` 為 `None` 時讀設定檔的 `log.enabled`（`settings::load`，每次都讀，所以在面板或手動改了立即生效）；`persist` 仍可覆蓋。前端與 diff 視窗都不必改。self-test 14f：開著時記一行記號再關掉，`selftest.sh` 檢查 `session.log` 有那一行、其他時候的 log 行沒有寫進去。

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
- **修復**（`f2d78ca`）：
  - 設定面板新增「儲存庫設定／Repository configuration」一節：說明文字加上「匯出儲存庫設定／Export Repository Configuration」按鈕。
  - `exportRepoState()` 改成回傳寫入的路徑，檔案已存在時回 `null`。面板會顯示「已寫入 …」、「已經有這個檔案，維持原樣」，或錯誤訊息。
  - 中英文字串都加了。README 改成「Export Repository Configuration (in the settings)」。
  - self-test 16b：按按鈕會寫出檔案並顯示路徑，再按一次顯示檔案已存在。

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
- **修復**（`f2d78ca`）：側欄清單是所有視窗共用的（`state.json` 的 `sidebar.repos`），所以檢查的是這份清單，不是單一視窗。
  - `state.rs` 新增 `State::lists_repo`／`State::listed`。
  - 檢查範圍比報告提的大：`repo_read`、`repo_op` 以外，`engine_request`、`worktree_file`、`repo_operation_state`、`export_repo_config` 也都在開頭呼叫 `state.listed(&repo)?`。不在清單裡就回 `… is not in the sidebar`，git 與引擎都不會執行。
  - 時序：前端加入 repo 時要先等 Rust 收到新清單，才能顯示它。所以 `appState.set` 改成回傳 Promise，`addAndShow` 會等 `saveSidebar` 完成。
  - 測試：Rust 單元測試 `only_the_sidebars_repositories_are_served`；self-test 第 5 項對讀取、操作、引擎、檔案各送一次 `<repo>/..`，確認都被拒絕。
  - CLAUDE.md 記下這條規則：之後新增收 repo 的 command 也要檢查。

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
- **修復**（`f2d78ca`）：`GraphTable` 的 `onKeydown` 處理 Enter（輸入法組字中不處理），呼叫新的 `onOpen`。`App.svelte` 在面板沒開、或開的不是這一列時才打開，所以重複按 Enter 不會把已開的面板關掉。self-test 3c：Esc 關掉後按 Enter，打開的是同一個 commit 的詳細資料。

---

### 5. 規格文件 `app/docs/spec/*.md` 狀態收尾（選修／文件同步）
- **位置**：`app/docs/spec/README.md` 及 `00-overview.md`～`80-reflog-worktree.md`、`95-remote-askpass-watch.md`
- **問題描述**：
  - `app/docs/spec/README.md` 的狀態表與多份規格檔內文仍標記為「骨架」與「待填」，與目前已完成的 M0～M8 實作狀態不同步。
- **修復要求**：
  - 更新 `app/docs/spec/README.md` 狀態表為已完成，並視需要清理各規格檔案中的「待填」佔位文字，使其與最終 Stage 2 實作一致。
- **修復**（`5363090`）：
  - 所有「待填」／「待做」都依程式實際的行為補上；沒做的明寫「不做」或「沒有」，沒有留下「未定」。README 狀態表全部改成「完成」。
  - 同時修正了原本寫錯的地方：列高與字級的範圍（16–48、8–24）、`repo:<repo>` 與匯出檔的欄位、fixup／squash／checkout／revert 實際執行的 git 指令、進度對話框、Find、分支下拉選單、右鍵選單。
  - `30-operations.md` 依 `ops/` 重寫成每個操作一列；`40-dialogs-menus.md` 列出每個選單項目與對話框欄位。
  - `99-acceptance.md` 第 5 項改寫，並新增 3c、14d、14e、14f、16b。第 17 項加上：在 graph 按 Esc 只關 Find。
  - 規格只描述使用者看得到的行為，沒有 class 名稱（grep 過）；`check-cleanroom.sh` 通過。

---

## 四、修復時另外發現並修正的問題

1. **改任何設定都會重新載入 graph**（`f2d78ca`）：`App.svelte` 原本比對整份設定，改 `log.enabled` 之類無關的設定也會重新載入，self-test 接著呼叫的 `load()` 會因為「載入中」直接回 false。現在只比對會影響載入內容的設定（`commits.*` 除了 `markdown`、`dateFormat`、`loadMoreAutomatically`，加上 `repository.*`）；外觀、語言、log 等在顯示的地方即時套用。
2. **Find 開著時在 graph 按 Esc，會連詳細資料一起關掉**（`c786be1`）：graph 的 Esc 關掉 Find 後沒有標記成已處理，詳細資料面板監聽整個視窗的 Esc，於是也把自己關掉。現在 graph 處理後會 `preventDefault`。self-test 第 17 項檢查只關 Find、詳細資料留著。
