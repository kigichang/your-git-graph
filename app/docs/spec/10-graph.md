# Graph

## 欄位

| 欄 | 內容 | 細節 |
|---|---|---|
| Graph | lane 與節點（自己的配置演算法，見 `crates/backend/src/graph.rs`） | 線條顏色依 `graph.colours` 輪流（預設 8 色）；節點是實心圓，HEAD 的節點是空心圈，選取的列節點大一號；未 commit 列與 stash 列是一般節點 |
| Description | ref 標籤 ＋ commit 標題 | 標題的輕量標記（`commits.markdown`，見下）；emoji 照原字顯示，不轉換 `:shortcode:` |
| Date | 作者日期或 commit 日期（`commits.dateType`、`commits.dateFormat`） | 相對時間取放得下的最大單位（年＝365 天、月＝30 天、週、天、小時、分鐘），「3 天前」／「3 days ago」，不到一分鐘是「剛剛」；未 commit 列空白 |
| Author | 作者名稱 | |
| Commit | 短 hash（8 碼） | 未 commit 列空白 |

- 欄寬固定（Graph 欄依 lane 數，Date／Author 各 150px、Commit 90px），不能拖（第一版）。
- 表頭：`graph.stickyHeader` 開著（預設）時固定在表格頂端；關掉時表頭是捲動內容的第一列，跟著列一起捲走，第一列緊接在它下方。
- Graph 欄最寬 360px，右緣 10px 淡出；更多的 lane 看不到，lane 不壓縮。
- 列高 `graph.rowHeight`、字級 `graph.fontSize`。
- 線條風格 `graph.style`：`rounded`（預設）換 lane 時畫曲線；`angular` 畫成一段直的斜線。改了立刻重畫。
- 標題的輕量標記（`commits.markdown`，預設開）：`` `code` ``、`**粗體**`／`__粗體__`、`*斜體*`／`_斜體_`，只在同一行內；底線只在字的邊界才算（`snake_case` 不變），code 裡的符號照字面。只產生文字，訊息裡的 HTML 永遠是文字。詳細資料的訊息也一樣。

## 列

- 一般 commit、merge commit（多個父）、stash（顯示為一列）、未 commit 的修改（最上面一列，`commits.showUncommitted`；未追蹤檔案依 `commits.showUntracked`）。repo 自己的設定（`.git/config`，不是使用者的全域設定）指定了讀檔時要執行的 clean filter 時（Git LFS 的標準設定除外），這一列不讀也不顯示，graph 下方說明是哪個設定；按「顯示（會執行它）」後，這個 repo 到 App 結束前照常讀取。
- HEAD 的列：標題粗體、節點是空心圈；目前分支的標籤粗體。detached HEAD 時沒有粗體的分支標籤，HEAD 的列一樣標示。

## ref 標籤

- 本地分支、遠端分支（可與同名本地合併顯示，`graph.combineLocalAndRemoteLabels`：本地標籤後面加「· origin」）、tag（annotated／lightweight）、stash、HEAD。
- 每種標籤有自己的右鍵選單（見 40）；點 tag 標籤打開 tag 的詳細資料。
- 標籤與標題放在同一格，超出欄寬就截斷加省略號（不換行、不另外收合）。上游的 ahead/behind 不顯示在標籤上（只在側欄，見 50）。

## 選取與鍵盤

| 動作 | 結果 |
|---|---|
| 點一列 | 選取並打開詳細資料（或關閉已打開的同一列） |
| ⇧-click 另一列 | 比較兩個 commit |
| 右鍵一列 | 選取它（未 commit 列除外）並打開選單 |
| ↑／↓ | 移動選取（並打開那一列的詳細資料） |
| Home | 選第一列 |
| Enter | 打開選取列的詳細資料（例如 Esc 關掉之後）；已經在顯示就不動 |
| Esc | 關閉找尋 widget，沒有的話關閉詳細資料 |
| ⌘J | 選取 HEAD 的列；還沒載入到它時先載入到它 |
| End | 還有更多就載入更多，否則選最後一列 |

⌘-click 一列和點一下相同；雙擊、拖拉沒有行為。

## 載入

- 起始載入 `commits.initialLoad` 筆（預設 300），「Load More」每次 `commits.loadMore` 筆（預設 100）；捲到底自動載入（`commits.loadMoreAutomatically`）。
- 排序 `commits.order`：date／author-date／topo。
- 只跟第一個父（first-parent）：工具列的勾選，存在 repo 的 state。
- Reflog 裡提到的 commit（`commits.includeReflog`）。

## 篩選

- 分支下拉：Show All，或勾選多個分支（本地與 remote 分支在同一份清單，見 70）；remote 分支整體可由工具列的 Remote branches 關掉；個別 remote 可隱藏（repo 的 state `hiddenRemotes`，目前只能由 `.your-git-graph.json` 帶入）。
- 作者篩選：工具列的作者下拉，勾選一位或多位作者後 graph 只載入他們的 commit（見 70）。
- 路徑篩選：沒有。

## 刷新

- 操作完成後自動重新載入；檔案監看回報變動時也會（見 95）。
- 刷新時捲動位置不動，選取停在同一個列號（以列號，不跟著 commit 移動）；打開的詳細資料不重讀。切換 repo 時才清掉選取與詳細資料。
