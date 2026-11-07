# 設定與狀態

都在 `~/Library/Application Support/dev.kigi.gitgraph/`（`GG_DATA_DIR` 可改）。

## `settings.json`

扁平的點號 key，可手動編輯（設定面板的 Open settings.json 用文字編輯器打開）。每次都重新讀檔；無法解析時拒絕寫入並以預設值執行。經 App 改動即時套用到所有視窗；手動編輯在視窗取得焦點時生效。

| key | 預設 | 說明 |
|---|---|---|
| `language` | `auto` | `auto`／`en`／`zh-TW` |
| `graph.style` | `rounded` | `rounded`／`angular` |
| `graph.rowHeight` | 24 | 18–40 |
| `graph.fontSize` | 13 | 10–20 |
| `graph.colours` | 色盤 | 線條顏色陣列 |
| `graph.combineLocalAndRemoteLabels` | true | |
| `graph.stickyHeader` | true | |
| `commits.initialLoad` | 300 | |
| `commits.loadMore` | 100 | |
| `commits.loadMoreAutomatically` | true | |
| `commits.order` | `date` | `date`／`author-date`／`topo` |
| `commits.showUncommitted` | true | |
| `commits.showUntracked` | true | |
| `commits.includeReflog` | false | |
| `commits.dateType` | `author` | `author`／`commit` |
| `commits.dateFormat` | `date-time` | 待填：有哪些 |
| `commits.markdown` | true | 標題的輕量標記 |
| `repository.showRemoteBranches` | true | |
| `repository.showRemoteHeads` | true | |
| `repository.fetchAndPrune` | false | |
| `repository.fetchAndPruneTags` | false | |
| `details.location` | `bottom` | `bottom`／`inline` |
| `details.fileView` | `tree` | `tree`／`list` |
| `details.compactFolders` | true | |
| `details.autoCenter` | true | |
| `dialogs.<對話框>.<欄位>` | | 對話框的預設值；待填完整清單 |
| `authors` | `[]` | `[{ name, email }]`；存檔後同步全域作者 |
| `plantuml.jar` | 無 | Markdown 預覽的 PlantUML |
| `log.enabled` | false | 寫 session.log |

舊 key（Stage 1 沿用上游擴充套件的名稱）第一次讀到時搬過來並寫回（`settings.rs` 的 `LEGACY_KEYS`）；未知 key 記 log、不刪。

**同步全域作者**（`authors` 存檔時）：還沒有全域作者 → 設為第一位；全域作者原本是清單中的某一位而被改掉或刪除 → 跟著改（全刪則 unset）；不在清單裡的全域作者是使用者自己的，不動。

## `state.json`

| key | 內容 |
|---|---|
| `stateVersion` | 2 |
| `sidebar` | `{ repos, collapsed, groups, groupOf, foldedGroups }` |
| `lastActiveRepo` | 最後顯示的 repo |
| `mounts` | repo → `smb://…`（share 上的 repo） |
| `appearance` | `system`／`light`／`dark` |
| `repo:<repo>` | `{ hiddenRemotes, showRemoteBranches, onlyFollowFirstParent, order, includeReflog, branchFilter, authorFilter, columnWidths, detailsLocation, lastImportAt }` |
| `window:<label>` | `{ sidebarWidth, detailsHeight, columns }` |

第一次以 Stage 2 啟動時刪掉 Stage 1 的 `repoState:*`、`codeReviews:*`、`webviewState:*`、`globalViewState`、`workspaceViewState`、`lastActive:*`。

## Repo 設定匯出

`<repo>/.your-git-graph.json`：`{ version: 1, hiddenRemotes, order, onlyFollowFirstParent, showRemoteBranches, exportedAt }`。開啟 repo 時 `exportedAt` 比 `lastImportAt` 新就匯入；只寫這一個路徑，不經 symlink。
