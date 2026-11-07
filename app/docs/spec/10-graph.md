# Graph

## 欄位

| 欄 | 內容 | 待填 |
|---|---|---|
| Graph | lane 與節點（自己的配置演算法，見 `crates/backend/src/graph.rs`） | 顏色數、節點樣式（圓／方）、未 commit 列的樣式 |
| Description | ref 標籤 ＋ commit 標題 | 標題的輕量標記（`commits.markdown`）、emoji |
| Date | 作者日期或 commit 日期（`commits.dateType`、`commits.dateFormat`） | 相對時間的格式 |
| Author | 作者名稱 | |
| Commit | 短 hash（8 碼） | |

- 欄寬可拖，存在視窗的 state。表頭可固定（`graph.stickyHeader`）。
- 列高 `graph.rowHeight`、字級 `graph.fontSize`、線條風格 `graph.style`（rounded／angular）。

## 列

- 一般 commit、merge commit（多個父）、stash（顯示為一列）、未 commit 的修改（最上面一列，`commits.showUncommitted`；未追蹤檔案依 `commits.showUntracked`）。
- 待填：目前 HEAD 的列如何標示；detached HEAD。

## ref 標籤

- 本地分支、遠端分支（可與同名本地合併顯示，`graph.combineLocalAndRemoteLabels`）、tag（annotated／lightweight）、stash、HEAD。
- 每種標籤有自己的右鍵選單（見 40）。
- 待填：標籤超出欄寬時的處理；上游的 ahead/behind 是否顯示在標籤上。

## 選取與鍵盤

| 動作 | 結果 |
|---|---|
| 點一列 | 選取並打開詳細資料（或關閉已打開的同一列） |
| ⇧-click 另一列 | 比較兩個 commit |
| ↑／↓ | 移動選取 |
| Enter | 打開詳細資料 |
| Esc | 關閉詳細資料／找尋 widget |
| ⌘J | 捲到 HEAD |
| End | 載入更多 |

待填：⌘-click、雙擊、拖拉是否有行為。

## 載入

- 起始載入 `commits.initialLoad` 筆（預設 300），「Load More」每次 `commits.loadMore` 筆（預設 100）；捲到底自動載入（`commits.loadMoreAutomatically`）。
- 排序 `commits.order`：date／author-date／topo。
- 只跟第一個父（first-parent）：repo 的 state。
- Reflog 裡提到的 commit（`commits.includeReflog`）。

## 篩選

- 分支下拉：全部、目前分支、勾選多個；remote 可整個隱藏（repo 的 state `hiddenRemotes`）。
- 作者篩選：待填。
- 路徑篩選：待填（Stage 1 是否有）。

## 刷新

- 操作完成後自動重新載入；檔案監看回報變動時也會（見 95）。
- 待填：刷新時保持選取與捲動位置的規則。
