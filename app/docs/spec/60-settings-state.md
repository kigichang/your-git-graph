# 設定與狀態

都在 `~/Library/Application Support/dev.kigi.gitgraph/`（`GG_DATA_DIR` 可改）。

## `settings.json`

扁平的點號 key，可手動編輯（設定面板的 Open settings.json 用文字編輯器打開）。每次都重新讀檔；無法解析時拒絕寫入並以預設值執行。經 App 改動即時套用到所有視窗；手動編輯在視窗取得焦點時生效。

| key | 預設 | 說明 |
|---|---|---|
| `language` | `auto` | `auto`／`en`／`zh-TW` |
| `graph.style` | `rounded` | `rounded`（換 lane 畫曲線）／`angular`（一段直的斜線） |
| `graph.rowHeight` | 24 | 16–48 |
| `graph.fontSize` | 13 | 8–24 |
| `graph.colours` | 8 色 | 線條顏色陣列（CSS 顏色，至少一個），依序輪流 |
| `graph.combineLocalAndRemoteLabels` | true | |
| `graph.stickyHeader` | true | 表頭固定在頂端；關掉時跟著列捲走 |
| `commits.initialLoad` | 300 | 1–100000 |
| `commits.loadMore` | 100 | 1–100000 |
| `commits.loadMoreAutomatically` | true | |
| `commits.order` | `date` | `date`／`author-date`／`topo` |
| `commits.showUncommitted` | true | |
| `commits.showUntracked` | true | |
| `commits.includeReflog` | false | 也顯示只剩 reflog 記得的 commit（amend、rebase、reset 留下的）；有分支篩選時不適用 |
| `commits.dateType` | `author` | `author`／`commit`：Date 欄顯示作者日期或 committer 日期（引擎列出 committer 日期，作者日期另外讀，見 CLAUDE.md） |
| `commits.dateFormat` | `date-time` | `date-time`（`2026-11-07 14:30`，本地時間）／`date`（`2026-11-07`）／`iso-date-time`（`2026-11-07 06:30Z`，UTC）／`iso-date`（UTC 的日期）／`relative`（「3 天前」；詳細資料裡仍顯示日期與時間） |
| `commits.markdown` | true | graph 的標題與詳細資料的訊息裡的輕量標記：`` `code` ``、`**粗體**`／`__粗體__`、`*斜體*`／`_斜體_`（底線只在字的邊界）；不產生 HTML |
| `repository.showRemoteBranches` | true | |
| `repository.showRemoteHeads` | true | |
| `repository.fetchAndPrune` | false | |
| `repository.fetchAndPruneTags` | false | |
| `details.location` | `inline` | `inline`／`bottom` |
| `details.fileView` | `list` | `list`／`tree` |
| `details.compactFolders` | true | |
| `details.autoCenter` | true | |
| `dialogs.<對話框>.<欄位>` | | 對話框的預設值（型別不符就用內建的預設）：`createBranch.checkout`、`deleteBranch.force`、`fetch.prune`、`fetch.pruneTags`、`fetchIntoLocalBranch.force`、`pull.noFastForward`、`pull.squash`、`merge.noFastForward`、`merge.squash`、`merge.noCommit`、`rebase.ignoreDate`、`rebase.autosquash`、`rebase.interactive`、`cherryPick.recordOrigin`、`cherryPick.noCommit`、`reset.mode`（`soft`／`mixed`／`hard`）、`resetUncommitted.mode`（`mixed`／`hard`）、`addTag.type`（`annotated`／`lightweight`）、`addTag.pushToRemote`、`stash.includeUntracked`、`applyStash.reinstateIndex`、`popStash.reinstateIndex`、`general.spaceSubstitution`（`none`／`hyphen`／`underscore`）；其餘為 true／false |
| `authors` | `[]` | `[{ name, email }]`；存檔後同步全域作者 |
| `plantuml.jar` | 無 | Markdown 預覽的 PlantUML |
| `log.enabled` | false | 開著時 App 的 log 行也附加到 `session.log`（每次啟動清空）；改了立刻生效。設定面板的 View session log 打開它 |

舊 key（Stage 1 沿用上游擴充套件的名稱）第一次讀到時搬過來並寫回（`crates/backend/src/settings.rs` 的 `legacy_keys()`；對照表在那裡，含值的改寫：`date.type` 的 `Author Date` → `author`、`commitDetailsView.location` 的 `Docked to Bottom` → `bottom`、`dialog.*` → `dialogs.*` 等）；Stage 1 只能關閉的 `fetchAvatars`、`pullRequests.enabled`、`trackRemoteTags`、`mobileAdaptation` 直接刪除；未知 key 記 log、保留不刪；同名的 key 已經有值時舊 key 只刪不覆蓋。無效的值（超出範圍、不在列舉裡）用預設值，`settings_get` 回報 `ignored: [{ key, reason }]`。

**同步全域作者**（`authors` 存檔時）：還沒有全域作者 → 設為第一位；全域作者原本是清單中的某一位而被改掉或刪除 → 跟著改（全刪則 unset）；不在清單裡的全域作者是使用者自己的，不動。

## `state.json`

| key | 內容 |
|---|---|
| `stateVersion` | 2 |
| `sidebar` | `{ repos, collapsed, groups, groupOf, foldedGroups }` |
| `lastActiveRepo` | 最後顯示的 repo |
| `mounts` | repo → `smb://…`（share 上的 repo） |
| `appearance` | `system`／`light`／`dark` |
| `repo:<repo>` | `{ hiddenRemotes, showRemoteBranches, firstParentOnly, order, branches, authors, lastImportAt }`：工具列的分支／作者篩選、Remote branches、First parent only 一改就存，顯示 repo 時還原 |
| `find` | `{ caseSensitive, regex }`：Find widget 的兩個開關 |

視窗大小、側欄寬度、欄寬、詳細資料的高度不存。

第一次以 Stage 2 啟動時刪掉 Stage 1 的 `repoState:*`、`codeReviews:*`、`webviewState:*`、`globalViewState`、`workspaceViewState`、`lastActive:*`。

## Repo 設定匯出

`<repo>/.your-git-graph.json`：`{ version: 1, hiddenRemotes, showRemoteBranches, firstParentOnly, order, exportedAt }`。開啟 repo 時 `exportedAt` 比 `lastImportAt` 新就匯入；只寫這一個路徑，不經 symlink。

- 匯出：設定面板「儲存庫設定」段的 Export Repository Configuration 按鈕（有顯示中的 repo 時）。檔案不存在才寫，寫完顯示寫到哪個路徑；已經有這個檔時不覆寫，顯示「已經有 .your-git-graph.json，維持原樣」。
