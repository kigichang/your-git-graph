# CLAUDE.md

macOS 的 git graph App，使用 **Tauri 2**。讀取來自 Rust 引擎 git-graph-core（[vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs) 的 `native/core`，MIT，submodule 鎖在 v1.0.28），寫入走 `git` CLI。

**這個分支（`stage-2`）是 clean-room 重寫**：Stage 1（`main` 分支，可用的自用版）把上游受限授權的 webview 與 extension host 包進 App，所以不能散布；Stage 2 把那些全部換成自己的前端（Svelte 5 + TypeScript）與 host（Rust），只留引擎，目標是可以公開散布。目前進度見「里程碑」。

## 授權與 clean-room（每次動手前都要記得）

| 路徑 | 授權 | 能做什麼 |
|---|---|---|
| `vendor/vscode-git-graph-rs/native/`（引擎） | MIT | 可以用、可以看（`native/core/src/dispatch.rs` 是方法清單） |
| `vendor/vscode-git-graph-rs/` 的其他部分：`web/`、`src/`、`out/`、`media/`、`resources/`、`tests/`、`docs/`、`package.json`、`package.nls*.json`、`README.md` | mhutchie Git Graph 授權 | **禁止散布衍生作品；Stage 2 連看都不看** |

- **絕不打開上表第二列的任何檔案**，也不打開 `main` 分支上從它們衍生的東西：`app/ui/host/main.js`、`app/ui/shim.js`、`app/ui/sidebar.css`、`app/ui/theme.css` 的選擇器、`app/scripts/prepare-ui.mjs`、`app/scripts/zh-tw.mjs`、`app/tests/settings.test.mjs`。`main` 上**自己寫的**可以看、可以搬：`gitops.js`（git 語意與 data-loss 規則）、`tests/gitops.test.mjs`、`sidebar.js`、`askpass.js`、`addremote.js`、`repoconfig.js`、`app.js`、`reads.js`（只看它們呼叫引擎與 git 的方式，不看協定名稱）。取用時 `git show main:app/ui/host/gitops.js`。
- 新程式碼只依據 **`app/docs/spec/*.md`（功能規格）**、引擎的介面、git 的文件。規格寫使用者看得到的行為，不寫 DOM、class、內部協定；對話框文字自己寫。
- **`app/scripts/check-cleanroom.sh`**：`app/` 內出現上游才有的名稱（`acquireVsCodeApi`、`--vscode-`、`out.min.*`、`vscode-git-graph`、`git-graph-rs.`、`vscode-light|dark|high-contrast`）或 Stage 1 的目錄還在，就失敗。`npm test` 與 `build-app.sh` 都會跑；每次 commit 前跑。
- 可選：在這個分支工作時 `git -C vendor/vscode-git-graph-rs sparse-checkout set native licenses`（cone 模式，頂層檔案保留，引擎照常建置）；切回 `main` 前 `sparse-checkout disable`——這是 submodule 工作樹的設定，不隨分支切換。
- 本 repo 的原始碼以 MIT 公開（根目錄 `LICENSE`，範圍不含 `vendor/`）。公開 repo：https://github.com/kigichang/your-git-graph 。舊的私人 repo `kigichang/git-graph` 已封存，裡面的歷史含上游內容，**不要把它的 ref 或 tag 推到公開 repo**。
- 這份文件**不記錄上游的內部細節**（元素 id、它的協定、它的字典、它的 CSS 做法）。要描述行為就寫進 `docs/spec/`。

## 架構

```
app/
  web/                    前端（Vite root；Svelte 5 + TS）；npm run build → web/dist/，Tauri 編譯時嵌入
    index.html            graph 視窗；diff.html  diff 視窗（script 是 public/diff-dist/ 的 esbuild bundle）
    public/theme.css      --gg-* token，四種外觀（淺／深 × 增強對比）；theme.js 設 <html> 的 gg-dark／gg-contrast，window.__ggTheme
    public/diff-dist/     scripts/build-diff.mjs 的輸出（gitignore）
    src/main.ts           graph 視窗進入點；GG_SELFTEST=1 時載入 selftest.ts
    src/App.svelte        目前是骨架（M0）
    src/selftest.ts       內建 self-test（docs/spec/99-acceptance.md）
    src/lib/errors.ts     errorText、engineAnswer（引擎回應裡的錯誤 → throw）
    src/lib/diffspec.ts   diff 視窗的 spec（三種 mode）
    src/lib/remote.ts     ssh:// 名稱與 smb:// 位址的解析與檢查
    src/theme.test.ts     theme.css 的 WCAG 對比
    vite.config.ts、svelte.config.js、tsconfig.json
  diff/                   diff 視窗程式（Monaco ESM；main.js、mdview.js、markdown.js、preview.js、mermaid.js；沿用 Stage 1）
  docs/spec/              功能規格（README.md 是目錄）
  scripts/                build-diff.mjs、build-app.sh、build-remote.sh、selftest.sh、preview.sh、check-cleanroom.sh
  tests/                  fake-ssh.sh、fake-java.sh、ssh-server.sh、real-ssh.sh、basic_auth_server.py（self-test 與 cargo 測試用）
  package.json            scripts：dev、build、build:diff、check（svelte-check）、test（check-cleanroom ＋ vitest）
  src-tauri/              Rust（獨立 Cargo workspace：App、crates/backend、crates/remote）
    tauri.conf.json       frontendDist ../web/dist；beforeBuildCommand npm run build
    tauri.dev.conf.json   cargo tauri dev --config tauri.dev.conf.json：devUrl 指到 Vite（不放進主設定，否則 cargo build 的 debug 版會去連 dev server）
    crates/backend/       gg-backend：不依賴 Tauri 的核心，App 與遠端 helper 共用。api.rs（ReadRequest／ReadResponse／OpRequest／OpResult／OpProgress／Reason 的型別，ts-rs 輸出；引擎讀取 read_engine）、runtime.rs（Runtime trait、LocalRuntime）、ops/（操作：remote、branch、history、stash、identity）、loss.rs（執行前的詢問）、reads.rs（CLI 讀取）、graph.rs（lane 配置）、settings.rs、git.rs（run、locate_git）、repo.rs（operation state、寫 .your-git-graph.json）、files.rs（讀工作目錄、掃描、write_atomic）、watch.rs、wire.rs（App ↔ helper 協定）、askpass.rs、engine()；tests/ops.rs 對真的 git 測所有操作
    crates/remote/        gg-remote：遠端機器上的 helper
    remote-dist/          build-remote.sh 的輸出（gitignore），remote.rs 以 include_bytes! 嵌入；沒建時 build.rs 放空檔
    src/main.rs           initial_repo、engine_request、host_log、self_test、preview、preview_resize
    src/api.rs            repo_read、repo_op、repo_op_cancel（本機建 LocalRuntime；ssh:// 轉給 helper 的 read／op）
    src/git.rs            git_info；遠端 git 的 askpass 事件（remote_prompt）
    src/settings.rs       settings_get、settings_set
    src/remote.rs         遠端 repo：名稱、連線與 bootstrap、session、remote_connect／disconnect
    src/repo.rs、repos.rs、state.rs、system.rs、askpass.rs、diff.rs、plantuml.rs   見各檔案的說明
    capabilities/         default.json（main、repo-*）、diff.json（diff-*）
vendor/vscode-git-graph-rs  submodule；只用 native/core
```

資料流：Svelte 元件 → `web/src/lib/api/client.ts`（型別化的 `invoke`：`repoRead`、`repoOp`）→ Rust command（`src/api.rs` 的 `repo_read`、`repo_op`、`repo_op_cancel`）→ `gg_backend::api::read`／`gg_backend::ops::operate` 配一個 `Runtime`（本機 `LocalRuntime`；`ssh://` repo 經 wire 的 `read`／`op` 送給 helper，helper 用同一份程式與自己的 `LocalRuntime`）→ 引擎或 git。

## 建置與驗證

```sh
git submodule update --init
(cd app && npm ci)
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl   # 遠端 helper（一次）
brew install filosottile/musl-cross/musl-cross                           # 它的 linker（一次）
app/scripts/build-remote.sh                 # 遠端 helper → src-tauri/remote-dist/（改了 crates/ 之後要重跑）
(cd app && npm run build)                   # diff bundle ＋ Vite → web/dist/（改了 web/、diff/ 之後要重跑）
(cd app/src-tauri && cargo build --workspace)   # debug；--workspace 也建出 self-test 用的 target/debug/gg-remote
(cd app/src-tauri && cargo tauri dev --config tauri.dev.conf.json)   # 開發：Vite HMR
app/scripts/build-app.sh [--universal] [--dmg] [--install]           # 打包（含 check-cleanroom、npm run build、驗證簽章）
```

- **改了 `app/web/`、`app/diff/` 要先 `npm run build` 再 `cargo build`**：前端是編譯時嵌入執行檔的。
- `cd app && npm test`：check-cleanroom ＋ vitest（目前 29 個：diffspec、errors、remote、theme、markdown、draw、filetree）。`npm run check`：svelte-check。
- `cd app/src-tauri && cargo test --workspace`（目前 161 個：backend 91 ＋ `tests/ops.rs` 34、remote 8、App 28；App 的遠端測試用 `target/debug/gg-remote`，所以要 `--workspace`）。`tests/ops.rs` 對真的 git 測每個操作、data-loss 規則、CLI 讀取與全域作者同步，`GIT_CONFIG_GLOBAL` 指向臨時檔，不會動到你的全域設定。
- **self-test**：`app/scripts/selftest.sh <執行檔> <repo 或含多個 repo 的資料夾> [log]`（`GG_SELFTEST=1`，`GG_DATA_DIR` 指到臨時目錄）。檢查項目與狀態在 `docs/spec/99-acceptance.md`；目前只有第 1 項（三種 diff 視窗）。它會寫入目標 repo，對 scratch 的 clone 跑。每次改動前端或 host 都要跑。遠端段落（假 ssh：`GG_REMOTE_SSH=tests/fake-ssh.sh`）、真 ssh（Docker：`tests/ssh-server.sh`、`GG_SELFTEST_SSH=…`、`GG_REMOTE_SSH=tests/real-ssh.sh`）、HTTP 帳密（`tests/basic_auth_server.py`、`GG_SELFTEST_HTTP`）的做法沿用 Stage 1，在對應里程碑接回來。
- **看畫面**：`app/scripts/preview.sh <執行檔> <repo> <場景> <light|dark|system> <輸出前綴>`（`GG_PREVIEW`；場景由 `web/src/preview.ts` 實作，M4 起）。需要螢幕錄製權限。
- **監看的手動檢查**：開著 App 閒置幾秒應該 0 次刷新；終端機 `git commit`、`git checkout -b` 各剛好刷新一次。
- **模擬從 Finder 啟動**：`env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin GG_SELFTEST=1 target/debug/git-graph-app <repo>`。
- **引擎測試**：`cd vendor/vscode-git-graph-rs && cargo test -p git-graph-core`。
- **效能基準**（git/git，86,054 列，release 版；self-test 對大 repo 會自動量，`GG_SELFTEST=1 target/release/git-graph-app <git/git clone>`，log 裡的 `graph:` 與 `bench:` 行）。M1 的閘門與結果：

  | 量測 | Stage 1 | 閘門 | Stage 2（2026-11-07） |
  |---|---|---|---|
  | `Commits(300)`（引擎＋layout） | 約 85ms（暖） | ≤ 100ms | 33ms（冷）／30ms（暖） |
  | 首屏（導覽開始 → 畫出第一頁） | 155–190ms | ≤ 250ms | 112ms |
  | 全部 86k 列：引擎／layout／IPC 往返 | — | layout ≤ 20ms | 711ms／15ms／817ms |
  | 86k 列在 3 秒內捲到底（每幀換掉整頁的列，最壞情況） | — | 60fps | 平均 16.8ms/幀（59.5fps），最差 55ms，每幀 1 次 canvas 重畫 |
  | 記憶體 | — | 全部載入後 WebContent 增加 < 300MB | 第一頁時 WebContent 341MB（WebKit 本身），全部載入並捲動後 496MB（+155MB）；Rust 端 453→463MB（引擎的 repo 快取，Stage 1 相同） |
  | load more 後前綴不變 | — | 性質測試 | `graph.rs` 的測試 |

  之後的改動不應讓這些數字明顯變差。`.app` 22 MB。

## 里程碑

| M | 內容 | 狀態 |
|---|---|---|
| M0 | 分支、clean-room 檢查、規格骨架、Vite＋Svelte 骨架、diff 視窗在新建置下可開、刪除 Stage 1 的 UI、CLAUDE.md 重寫 | ✅ 2026-11-07 |
| M1 | `crates/backend/src/graph.rs` lane 配置 ＋ 測試；`repo_read(Commits)`（`api.rs`，ts-rs 產生型別）；`GraphTable`／`GraphCanvas` 虛擬捲動；git/git 量測 | ✅ 2026-11-07，閘門全過（數字見「效能基準」） |
| M2 | 引擎提供的讀取全部進 `api.rs`（repo info、commit／stash／未 commit 的詳細資料、比較、行數、tag、count before、authors）；工具列（分支篩選、remote 開關、refresh）；詳細資料面板（檔案樹／清單、行數、點檔案開 diff、⌘-click 開檔案、⇧-click 比較、tag）；`settings.rs` schema 與 Stage 1 key 的搬移、`settings_get`／`settings_set`、設定即時套用到 graph | ✅ 2026-11-07。CLI 的讀取（reflog、worktree、predictConflicts、repo config、ahead/behind）隨 M3 的 Runtime 一起做 |
| M3 | `runtime.rs`（`Runtime` trait、`LocalRuntime`）、`ops/*`（42 個操作）、`loss.rs`（data-loss 與「tag 的 commit 不在 remote」的詢問）、`reads.rs`（CLI 讀取：operation state、reflog、worktree、predict conflicts、repo config、ahead/behind）；`main` 的 gitops 測試搬成 `crates/backend/tests/ops.rs`（34 個）；App 的 `repo_op`／`repo_op_cancel`（取消、進度 Channel、askpass）；helper 的 `read`／`op`（進度與 askpass 走 `V` 事件，`C` 取消）；`git_exec`／`git_cancel` 移除 | ✅ 2026-11-07 |
| M4 | 右鍵選單（`lib/menus.ts`：commit／HEAD／未 commit 列／本地分支／遠端分支／tag／stash／檔案／空白處）、對話框（`lib/dialogs.ts` 的 spec → `FormDialog.svelte`；預設值來自 `dialogs.*`）、`OpDialogs.svelte`（data-loss 詢問、串流進度與取消、錯誤）、`lib/ops.svelte.ts`（執行、再送 confirmed、刷新）、`StatusBar.svelte`（merge／rebase 進行中：Continue／Abort）、監看事件 `repo-changed` 的去重（`ECHO_MS`）、互動式 rebase 經 Terminal、Create Archive 經存檔對話框、`lib/i18n/en.ts` | ✅ 2026-11-07。Remote 的增刪改與 user details 隨 M6 的設定面板；fixup／squash 目前一律可選（staged 的判斷隨 M6）；選單列的快捷鍵（⌘R、⌘⇧F）隨 M6 接上 |
| M5 | 側欄（`lib/sidebar.ts` 純函式＋`Sidebar.svelte`：群組、pointer 拖拉排序與拖進群組、⌘／⇧ 多選、收合、變淡、ahead/behind、右鍵選單）、起始畫面（`StartPage.svelte`：最近清單、三種加入）、`lib/state.svelte.ts`（state.json 的共用快照，`state-changed` 跟其他視窗同步）、多視窗（Open in New Window、`open-repo`、`menu-command`）、Finder 拖放（`onDragDropEvent`）、遠端 repo（Add SSH Repository 對話框、`remote_connect`、斷線變淡、點了重連）、SMB（Connect to Server 對話框、`mount_volume`、`mounts`）、`AskpassDialog.svelte`、`repo-changed` → 刷新與 ahead/behind、焦點回來時遠端／share 的 repo 刷新 | ✅ 2026-11-07。askpass 對話框還沒在 self-test 裡跑（要 HTTP 帳密伺服器，M7）；監看觸發的刷新只有手動驗證 |
| M6 | 設定面板（`SettingsPanel.svelte`：每個設定即時寫入、作者身分＋全域作者同步、顯示中 repo 的 remote 增刪改與 user details、開 settings.json／session log、列出被略過的 key）、`state.json` 的 `migrate_v2`（刪 Stage 1 的 key）、每個 repo 的狀態 `repo:<repo>`（分支／作者篩選、remote 分支、first parent、order）與 `.your-git-graph.json` 匯出／匯入（`lib/repoconfig.ts`）、Find（`lib/find.ts`＋`FindWidget.svelte`，⌘F）、作者篩選與 first-parent（`MultiFilter.svelte`）、Reflog 與 Worktree 面板、⌘J 未載入時先數再載入、i18n（`lib/i18n/strings.svelte.ts` 是 reactive 的字典，`zh-TW.ts` 全部翻譯，切換不重載；測試比對 key 與佔位符、擋簡體字）、日期格式（`dates.ts`）、本機與遠端同名分支合併標籤 | ✅ 2026-11-07。`details.location = inline` 沒做（面板只停靠底部）；`commits.dateType` 沒接（引擎的清單只有作者日期）；`includeReflog` 沒接（引擎不支援，要 CLI 後備） |
| M7 | self-test 全部、preview 場景、`THIRD-PARTY.md`、Developer ID／notarization 的設定位置、README | |

## 設計（決定了的）

- **協定**：三個型別化 command 取代 Stage 1 的逐請求 handler：`repo_read(repo, ReadRequest) -> ReadResponse`、`repo_op(repo, OpRequest, confirmed, id, Channel<OpProgress>) -> OpResult`、`repo_op_cancel(id)`。`ReadRequest`／`OpRequest` 是 serde 的 tagged enum（`kind`，camelCase），derive `ts_rs::TS`，`cargo test -p gg-backend` 輸出到 `web/src/lib/api/generated/`（commit 進 repo，有測試比對不漂移）。`OpResult = Done { refresh } | NeedsConfirmation { reasons: Vec<LossReason> } | Failed { message }`；`LossReason` 是結構化 enum，文字由前端 i18n 產生，**不送 HTML**。diff 視窗繼續用 `engine_request`、`worktree_file`。
- **gg-backend 的模組**：`api.rs`（型別與 `read`／`operate` 兩個總入口）、`runtime.rs`（`trait Runtime { git, engine, repo }`，`LocalRuntime` 固定帶 `GIT_OPTIONAL_LOCKS=0`、`GIT_EDITOR=true`、`GIT_TERMINAL_PROMPT=0`）、`ops/`（每個操作 `argv(&Req)` ＋ `run(rt, &Req, progress)`）、`loss.rs`、`reads.rs`、`graph.rs`、`settings.rs`、`repostate.rs`。
- **graph**：lane 配置在 Rust（`crates/backend/src/graph.rs`，自己的演算法：依引擎順序逐列處理，等著這個 commit 的 lane 匯入節點、第一個父接手節點 lane、其他父分出到已在等的 lane 或新 lane、空位重用且不左移、父不在清單時 dangling（還能載入更多時 lane 延伸到底）、`MAX_LANES = 200`）。輸出 `Layout { lanes, node_lane[], node_colour[], spans[], dangling[] }`：**線條是 span**（每條 6 個數：起列、迄列、lane、起點欄、終點欄、顏色，依起列排序），不是每列每 lane 一段——git/git 8.6 萬列 × 100 多條 lane 若逐列輸出會有 3500 萬個數字，IPC 與 WebContent 都撐不住。前端（`web/src/lib/graph/draw.ts`）只畫可視列：掃 span 清單找出跨過可視範圍的，直線段合併成一條 `lineTo`。
- **設定**：`settings.json` 用自己的 key（`language`、`graph.*`、`commits.*`、`repository.*`、`details.*`、`dialogs.*`、`authors`、`plantuml.jar`、`log.enabled`，見 `docs/spec/60`）。schema 在 `crates/backend/src/settings.rs`（`Settings` 型別化、`apply(key, value)` 驗證、`from_entries` 回傳被略過的 key 與原因、`migrate` 把 Stage 1 的 key 搬過來——`legacy_keys()` 那張表，讀檔時執行一次並寫回）。App 的 `src/settings.rs`：`settings_get`（讀、搬移、回 `SettingsView { settings, ignored }`）、`settings_set(key, value)`（`null` 回預設；無效的值拒絕並說明範圍；寫檔後發 `settings-changed`）。前端 `web/src/lib/settings.svelte.ts` 是全域的 reactive 狀態，`settings-changed` 與視窗取得焦點時重讀；App 比對 JSON 有變才重載 graph。`dialogs.*` 目前只是透傳（M4 定欄位）。`state.json`：保留 `sidebar`、`lastActiveRepo`、`mounts`、`appearance`，Stage 1 其餘的 key 第一次啟動時刪掉（`stateVersion: 2`），新的 `repo:<repo>`、`window:<label>`。Repo 設定匯出改成 `<repo>/.your-git-graph.json`（`repo.rs` 的 `REPO_CONFIG_FILE`，已改）。
- **i18n**：英文與繁體中文（臺灣），`web/src/lib/i18n/{en,zh-TW}.ts` 同一個 `Strings` 型別；切換即時生效、不重載；vitest 檢查兩份 key 一致、沒有簡體字元。
- **選單與對話框**：`menuFor(target, ctx)` 回項目 id，App 的 `doAction(id, target)` 分派：直接執行的（checkout、fixup、copy、open）、開對話框的（`dialogFor` 回 spec，`FormDialog` 渲染；`spec.build(values)` 回 `OpRequest` 或 `{ error }`）、檔案的（用詳細資料面板顯示的 revision）。`runOperation` 的流程：`repoOp` → `needsConfirmation` 就把 `ops.question` 給 `OpDialogs` 顯示（`reasons.ts` 把 `Reason` 變句子），同意後帶 `confirmed` 重送 → `failed` 進 `ops.error`（串流的操作則留在進度視窗）→ 之後 App 一律 `reload()`。`isStreamed()` 決定哪些操作開進度視窗（fetch、pull、push、碰 remote 的 tag／branch 刪除）。i18n 的 key 全部在 `lib/i18n/en.ts`，`t(key, values)`；zh-TW 隨 M6。CSS class 名稱要獨一無二：`.gg-message` 同時是列的標題與錯誤文字時，self-test 的 `querySelector` 抓錯過。
- **側欄與 repo 的生命週期**（`App.svelte`）：清單在 `appState.sidebar`（state.json，所有視窗共用；`saveSidebar` 存回，其他視窗經 `state-changed` 跟著變）。`addAndShow(paths)`：本機路徑先 `scan_repos`（資料夾裡的 repo 全加，找不到就當它本身是 repo），`ssh://` 直接加；`show(repo)`：遠端先 `remote_connect`、變淡的 share repo 先 `mount_volume`，載入失敗就 `repoStatus[repo].missing` 變淡（點了再 `show` 就是重連）；載入後 `repo_opened(folder, repos)` 告訴 Rust 要監看哪些、`lastActiveRepo`、`network_volume` 記 share、`recent_repos` 更新起始畫面。開機：`__GG_OPEN_REPO`（新視窗）→ `initial_repo`（main 的命令列與 Dock）→ `lastActiveRepo`；其他遠端 repo 一律先變淡（不自動連線）。`removeRepos` 用 `sidebar.ts` 的 `removeRepos` 決定接著顯示誰。
- **i18n**：`t(key, values)` 讀 `strings.svelte.ts` 的 `$state` 字典，元件裡呼叫的會跟著語言重畫；純模組（menus、dialogs）是建構時呼叫，下一次用就是新語言。新字串兩邊都要加（`i18n.test.ts` 會比對 key、`{}` 佔位符，並擋常見的簡體字）。`languageFor('auto')` 遇到任何 `zh*` 系統語言都是 zh-TW。
- **每個 repo 的狀態**（`repo:<repo>`，`lib/repoconfig.ts` 的 `RepoState`）：顯示時 `restoreRepoState` 先讀 state、再讀 repo 裡的 `.your-git-graph.json`（`worktree_file`），檔案的 `exportedAt` 比 `lastImportAt` 新就合併進來；工具列的篩選改動即存。匯出只在檔案不存在時寫（`export_repo_config`），self-test 用 `cleanUntracked` 把它清掉。
- **主題**：token 是 `--gg-*`（`web/public/theme.css`），四種外觀由 `<html>` 的 `gg-dark`／`gg-contrast` 決定；`web/src/theme.test.ts` 檢查文字 4.5:1、增強對比時主要文字 7:1、邊框 3:1。View > Appearance 經 Rust 的 `set_theme` 存在 `state.json` 的 `appearance`。強調色上的文字固定白色（WebKit 把 `AccentColorText` 解析成黑色）。
- **元件**（Svelte）：殼 `App`、`StartPage`、`Toolbar`、`StatusBar`；graph `GraphTable`、`GraphCanvas`、`RefLabels`；詳細資料 `DetailsPanel`、`CommitDetails`、`CompareDetails`、`UncommittedDetails`、`StashDetails`、`FileTree`／`FileList`；`ContextMenu` ＋ `lib/menus.ts`；`Dialog` 共用殼 ＋ `dialogs/*`；`DataLossDialog`、`ProgressDialog`、`ErrorDialog`；`FindWidget`、`BranchFilter`、`AuthorFilter`；`SettingsPanel`、`ReflogPanel`、`WorktreePanel`；`Sidebar`、`SidebarGroup`、`SidebarRepo`、`AddMenu`；`AskpassDialog`。
- **測試**：Rust（backend 的 ops／loss／graph／settings、remote 的 `read`／`op`、App 的路由）、vitest（純函式、i18n、元件）、self-test（`web/src/selftest.ts`，經 `window.__gg.test` 驅動 store 與元件，只在 selftest 下掛）。

## 已知坑與慣例

### 一般

- **改了 `app/web/*`、`app/diff/*` 要先 `npm run build` 再 `cargo build`**。
- **引擎的錯誤放在回應內容裡**：回應只有 `{"error": "Kind: message"}` 時代表失敗（`errors.ts` 的 `engineAnswer()` 轉成 throw）；一般的成功回應也可能帶 `error: null` 欄位，不能把它當失敗。
- **不要直接修改 `vendor/`**。引擎的方法和參數看 `native/core/src/dispatch.rs`（42 個方法，全部唯讀）。
- **gix 不支援 push、fetch**：所有寫入一律走 `git` CLI。
- **使用者輸入的值進 git 的 argv 前一律檢查**，以 `-` 開頭就拒絕（防止被當成選項，例如 `--upload-pack=…`）。路由只接受這個視窗側欄清單裡的 repo。
- **data-loss 規則**（git 語意，自己寫的）：離開 detached HEAD 時 HEAD 上有不在任何分支、tag、remote-tracking 分支裡的 commit；reset 讓目前分支的 commit 不在其他 ref 上（hard reset 時已追蹤檔案有未 commit 的修改，`git status --porcelain --untracked-files=no`）；強制移動既有分支讓它的 commit 不在其他 ref 上（`rev-list <branch> --not <target> --exclude=<branch> --branches --tags --remotes`）；force／force-with-lease push 時 remote-tracking 分支上有本地分支沒有的 commit。檢查只讀；不安全的值不檢查、照原本的錯誤回應。
- **git 一律 `GIT_EDITOR=true`**：沒有終端機可以編輯，`rebase --continue`、`commit --squash`、`merge --no-ff` 採用預設訊息。互動式 rebase 在 Terminal.app 執行（`system.rs` 的 `open_terminal`）。
- **改寫歷史（drop commit、改舊訊息）**：自己產生 rebase todo，經環境變數 `GG_TODO` 給 `GIT_SEQUENCE_EDITOR`；新訊息與作者走 `GG_MESSAGE`、`GG_AUTHOR`，由 `exec git commit --amend` 讀取，所以不必跳脫。範圍內有 merge commit 就拒絕。
- `GIT_OPTIONAL_LOCKS=0`：避免 `git diff` 之類順手改寫 index 觸發監看而無限刷新。
- **呼叫 git 一律經 `Runtime::git`**（`crates/backend/src/runtime.rs`；底層是 `gg_backend::git::run`）：回 `GitExecResult { exit_code, stdout, stderr, timed_out, cancelled, duration_ms }`，非 0 不是 `Err`（`ops::error_of` 轉成訊息）。`LocalRuntime` 每次都帶 `GIT_EDITOR=true`、`GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0` 與 askpass 的環境變數；`GitOpts { stream: true }` 才串流（fetch、pull、push）。取消是 `watch` 旗標：殺掉正在跑的 git，之後的 git 不再啟動（`Err("Cancelled.")`）。前端不直接組 git 參數：只有 `repo_read`／`repo_op`。
- **操作的結果**是 `OpResult`：`Done`、`NeedsConfirmation { reasons }`（沒帶 `confirmed` 時先檢查 `loss.rs`；前端顯示原因、使用者同意後帶 `confirmed: true` 重送）、`Failed { message, step }`（多步驟操作失敗在哪一步，例如 tag 建好了但 push 失敗）。進度 `OpProgress::Output { stderr, text }`／`Step { index, total, label }` 經 Tauri `Channel`（遠端經 `V` 事件 `{ progress }`）。同一時間每個 id 只有一個操作（`api::Jobs`）。
- **互動式 rebase** 由 `Runtime::terminal` 打開 Terminal（App 的 `system::open_terminal`，遠端是 `ssh -t`）；`CreateArchive` 的路徑由前端先用存檔對話框問好再送，遠端拒絕。
- **git 的選擇順序**：`GIT_GRAPH_GIT` → `PATH`（略過 `/usr/bin/git`）→ Homebrew → `/usr/bin/git`（只有 `xcode-select -p` 成功時）。每個 process 只解析一次。
- **每次執行 git 都在獨立的 process group**：逾時或取消時 `killpg` 連同 hook、ssh 一起終止。
- **事件要指定視窗**：Rust 的 `emit` 送給所有視窗；只給單一視窗的事件（`open-repo`、`menu-command`、`askpass`）用 `app.emit_to(label, …)`，JS 用 `getCurrentWindow().listen`。
- **選單**：用 `Menu::default` 再往 File、View 插入項目。**不要整個自建選單而漏掉 Edit**，否則輸入框的 ⌘C/⌘V 會失效。選單指令以 `menu-command` 送給取得焦點的視窗。⌘J 用於 Show HEAD Commit（⌘H 被系統的「隱藏」佔走）。
- **視窗**：`main` 是設定檔裡的第一個視窗，其他是 `repo-N`；只有 `main` 讀命令列路徑（`initial_repo`）。`repo_opened` 在顯示的 repo 或清單改變時呼叫，只有清單變了才重建監看。視窗關閉時 `WindowEvent::Destroyed` 停掉它的監看。
- **Finder 與 Dock**：拖到視窗上是 Tauri 的 drag-drop 事件（`getCurrentWebview().onDragDropEvent`）；拖到 Dock 圖示、`open -a` 是 macOS 的 Opened 事件（`main.rs` 的 `opened`），`main` 還沒呼叫 `initial_repo` 前先存在 `Launch`。Dock 接受資料夾靠 `Info.plist` 的 `CFBundleDocumentTypes`。
- **側欄的拖拉不用 HTML5 drag and drop**：Tauri 的檔案拖放會攔走。
- **最近清單**：`recent.json`，最多 10 筆，不存在的路徑略過。
- **不上 Mac App Store**（Sandbox 擋掉 git 與 `~/.ssh`）。最低 macOS 13。

### 前端（Svelte 5）

- 大陣列（commits、layout）用 `$state.raw`，不要 `$state`：深層 proxy 對 86k 個物件太慢。
- `$effect` 裡不要讀寫同一個 `$state`（例如計數器 `n++`）：effect 會依賴它而重跑。只給測試看的計數器用普通變數。
- 虛擬捲動（`GraphTable.svelte`）：spacer 撐出高度，只渲染可視範圍 ±8 列，列以 `translateY` 定位；canvas 放在 viewport 外的絕對定位層，捲動時只改它畫的內容。graph 欄最寬 360px（約 25 條 lane），更右的 lane 在淡出範圍外。git/git 以日期排序的第一頁就有 135 條 lane（很多 topic branch 的 commit 等著更深的父）——這是這種配置法的本性，要不要壓縮待 M2 之後看畫面決定。
- 型別：`web/src/lib/api/generated/*.ts` 由 `cargo test -p gg-backend` 產生，不要手改；改了 Rust 的型別就重跑測試並一起 commit。

### diff 視窗（`app/diff/main.js`，沿用 Stage 1）

- Monaco 0.53 起只有 ESM 版；進入點 `monaco-editor/editor`、`features/register.all`、`languages/definitions/register.all`。**不要**引入 `languages/features`（語言服務，`ts.worker` 就 6.7 MB）。worker 經 `self.MonacoEnvironment.getWorker` 指向 `diff-dist/editor.worker.js`；self-test 攔截 worker 警告，有就失敗。
- spec 由主視窗算好（`diffspec.ts`），經 `open_diff_window` 以 `initialization_script` 注入 `window.__GG_DIFF_SPEC`（不放 URL query）。內容由 diff 視窗自己讀：revision 走引擎 `loadCommitFile`／`fileBytes`，工作目錄走 `worktree_file`（拒絕 `..`、絕對路徑、指向 repo 外的 symlink；超過 50 MB 不載入）。
- `from === to` 代表「那一個 commit」（父 ↔ 它）；`*` 代表 HEAD ↔ 工作目錄。A/U 狀態左側為空，D 狀態右側為空。
- 偏好存在 diff 視窗的 `localStorage`（`gg.diffPrefs`）。
- Markdown 預覽：`diff/markdown.js`（markdown-it `html: false`、task list、KaTeX）與 Mermaid 各是延後載入的 bundle（`loadBundle`）；不要把 `markdown.js` import 進 `main.js`。程式碼用 `monaco.editor.colorize()` 上色。圖片相對路徑用 `mdview.js` 的 `resolveRelative` 從顯示的那個 revision 讀成 data URL；HTML 先放進 `<template>` 處理完圖片才接上頁面。連結不導覽，`http(s)`、`mailto` 交給 `open_url`。
- PlantUML（`plantuml.rs`）：只用本機 jar（設定 `plantuml.jar`），`-DPLANTUML_SECURITY_PROFILE=SANDBOX`，30 秒逾時，結果快取，輸出放 `<img>` 的 data URL。`GG_PLANTUML_JAVA`、`GG_SELFTEST_PLANTUML_JAR` 只給測試。
- 捲動同步：區塊帶 `data-line`，`mdview.js` 內插；只有使用者正在操作的那一邊帶動另一邊。
- Esc 關閉視窗（Monaco 處理過的按鍵不關；`isComposing` 不關）。不要改成 capture 階段。
- diff 視窗還用 `window.__TAURI__`（所以 `tauri.conf.json` 的 `withGlobalTauri` 暫時保持 true）；改成 `@tauri-apps/api` 時一併關掉。
- self-test 的 log 會有 `diff: rejection: cancel@…`：送 Esc 時 Monaco 取消它未完成的工作（搜尋框的動作），不是錯誤；`diff/main.js` 的這段和 Stage 1 相同。

### 檔案監看（`crates/backend/src/watch.rs`）

- 事件合併 300ms。`.git` 裡只有 HEAD、refs、packed-refs、index、config 和進行中操作的標記檔算數（objects、logs、`*.lock` 忽略）；工作目錄的變動用 `git check-ignore --stdin` 過濾。路徑歸屬於包含它的最深一層 repo。
- linked worktree 與 submodule：`.git` 是指向別處的檔案（`repo.rs` 的 `git_dir`），另外監看它的 git dir 與 `commondir` 指向的共用 git dir；共用 git dir 裡只有 refs、packed-refs、config 算所有用它的 repo 的。
- 前端去重：只在變動的 repo 正是目前顯示的 repo 時才刷新；寫入操作執行中與結束後 1 秒內的事件忽略（`ECHO_MS`），讀取類不觸發這個忽略。ahead/behind 在某個 repo 變動時重算那一個。

### 遠端 repo（SSH）（`remote.rs`、`crates/remote`、`web/src/lib/remote.ts`）

- 做法和 VS Code Remote-SSH 一樣：不掛載。helper 複製到遠端的 `~/.cache/your-git-graph/gg-remote-<id>`，每台主機一條常駐 `ssh`，經 stdin/stdout 用 frame 溝通；引擎、git、讀檔、監看都在遠端執行。helper 只含 `native/`（MIT）與自己的程式碼。
- 名稱 `ssh://[user@]host[:port]/絕對路徑`，不做 percent-encoding，凡是本機 repo 用路徑的地方都直接放這個字串；`host` 可以是 `~/.ssh/config` 的別名。
- **路由在 Rust**：收 repo 的 command 先問 `remote::parse()`，是遠端就轉給該主機的 session。新增收 repo 路徑的 command 時也要這樣做。git 要**先路由、再加 askpass 環境變數**。
- **只有 `remote_connect` 會連線**（加入、顯示、點變淡的項目）。沒連線時其他 command 立刻回 `Not connected to …`。不要改成自動連線；開機只連最後顯示的那個。
- 安全：user、host 只允許 `[A-Za-z0-9._-]+`（或方括號 IPv6），不能以 `-` 開頭；ssh 的 argv 用陣列，目的地前有 `--`；repo 路徑只放在協定的 JSON 裡。終端機（`ssh -t`）用 `remote_quote` 再套 `shell_quote`、`applescript_quote`。
- bootstrap（`BOOTSTRAP`）：`exec sh -c '…'`，內容不能有 `'`、`\`、`!`、換行（有測試）。流程：`@@GG-BOOT@@ <uname -s> <uname -m>` → App 送 `<id> <gzip 大小> <原始大小>` → `@@GG-HAVE@@` 或 `@@GG-SEND@@` → `exec` helper → `@@GG-READY@@ <hello JSON>`。雙方一來一往，不能預先多送。
- ssh 選項：`-T -o RemoteCommand=none -o ClearAllForwardings=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15`，不用 ControlMaster、BatchMode。連線是整個 App 共用的。
- 協定（`wire.rs`）：frame 是 `<id> <kind> <len>\n` 加 body。App 送 `Q`、`C`；helper 回 `P`／`R`（結果的片段，每片最多 64 KiB）、`E`、`O`／`S`（git 的串流）、`V`（事件：監看、askpass）。op：`engine`、`git`、`operationState`、`worktreeFile`、`exportRepoConfig`、`scan`、`watch`、`answer`；M3 加 `read`、`op`。
- helper 的 id 是內容的 sha256 前 16 碼；新的 helper 啟動時刪掉同目錄的舊版；stdin EOF 時取消所有 git 後結束。`GG_REMOTE_SSH`、`GG_REMOTE_HELPER` 只給測試。
- helper 只監看 git 目錄（inotify 的上限），工作目錄的修改在視窗取得焦點時刷新。
- 遠端 git 的帳密：helper 自己當 askpass（`GG_REMOTE_ASKPASS_SOCKET`），問題以 `V` 事件送回，App 顯示在發出請求的視窗，以 `answer` 回覆；git 先結束時送 `{askpassClosed}`。
- 不提供：Reveal in Finder、開啟檔案、外部 diff、archive。`git_info` 看本機的 git；遠端沒有 git 時連線失敗並說明。
- 平台：Linux x86_64、arm64（musl 靜態），macOS arm64。遠端需要 git、gzip、sh。
- 還沒做／沒驗證：helper 被強制終止時 askpass socket 目錄不會清掉；引擎請求不能取消；`safe.directory` 的行為；`open_terminal` 的 `ssh -t` 沒在真的 Terminal 跑過。

### 網路磁碟（SMB）（`system.rs`）

- Connect to Server (SMB)… 用 `osascript` 的 `mount volume`（帳密由 macOS 處理；已掛載就直接回掛載點）。只接受 `smb://server/share`，不含空白。
- share 上的 repo 用 `network_volume`（`statfs`）記在 `state.json` 的 `mounts`；重新掛載前先送引擎 `close`。其他機器的變動不會回報，所以在視窗取得焦點時刷新。
- `write_atomic` 忽略 `ENOTSUP`（SMB 不支援 fsync）。Linux 建立的 repo 經 SMB 會顯示所有檔案被修改，要設 `core.fileMode false`。掛載卡死時同步的檔案系統呼叫可能卡住。

### 帳密提示（`askpass.rs`）

- git 執行時加上 `GIT_ASKPASS`／`SSH_ASKPASS`（指向 App 執行檔本身）、`SSH_ASKPASS_REQUIRE=force`、`GG_ASKPASS_SOCKET`、`GG_ASKPASS_TOKEN`；`GIT_TERMINAL_PROMPT=0`。
- **helper 模式**：`main()` 一開頭就檢查 `GG_ASKPASS_SOCKET`，有就當 helper 執行完立刻結束。不要在那之前加任何初始化。
- socket 在 0700 的臨時目錄，請求要帶 token；提示文字只用 `textContent` 顯示。token 依視窗分開，伺服器 `emit_to` 給發出請求的視窗；視窗已關掉時直接回沒有答案。連線讀到 EOF 視為 helper 已死，自動送 `close`。未回答 5 分鐘後放棄。
- Keychain（`osxkeychain`）與 ssh-agent 有答案時不會問。殘留的 `$TMPDIR/gg-askpass-<pid>-*` 下次啟動時清掉。

### 狀態與設定（`state.rs`）

- `state.json`：`store.set` 經 `state_set`，Rust 合併 300ms 後原子寫入，結束時 flush，發 `state-changed` 給其他視窗。`localStorage` 不受 `GG_DATA_DIR` 影響，所以設了 `GG_DATA_DIR` 時 Rust 先標記 `migratedFromLocalStorage`。
- `settings.json`：每次重新讀檔、逐 key 改寫；無法解析時拒絕寫入、不覆蓋、以預設值執行。經 App 改動發 `settings-changed`；手動編輯在視窗取得焦點時生效。
- `enableLog`（Stage 2：`log.enabled`）開啟時 `host_log` 也寫 `session.log`（每次啟動清空）。

### 簽章（個人使用，沒有 Apple Developer 帳號）

- `tauri.conf.json` 的 `signingIdentity` 是 `"-"`（ad-hoc；識別碼 `dev.kigi.gitgraph`、hardened runtime），不做 notarization。`build-app.sh` 驗證 `codesign --verify --deep --strict` 與識別碼。`spctl` 回 rejected 是正常的。傳到另一台 Mac 要 `xattr -dr com.apple.quarantine`。
- ad-hoc 的 cdhash 每次建置不同，macOS 可能重複問權限；可用 Keychain 自簽的憑證 `APPLE_SIGNING_IDENTITY=… app/scripts/build-app.sh` 固定。
- 公開散布時：`signingIdentity` 改成 Developer ID 憑證，加 `APPLE_ID`／`APPLE_PASSWORD`／`APPLE_TEAM_ID` 做 notarization（M7 準備設定位置）。

## Stage 1（`main` 分支）

自用版，功能完整：上游 webview ＋ 自己寫的 JS host ＋ 這裡沿用的 Rust。它的 CLAUDE.md 在 `main` 上。這個分支不合併回 `main`；`main` 不再開發。
