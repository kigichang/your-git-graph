# Commit 詳細資料

## 位置

- 停靠在底部（`details.location = bottom`）或 inline 在選取列的下方（`inline`）。改設定後，已打開的留在原處，下次打開才換。
- 自動置中（`details.autoCenter`）：打開時把列捲到可見範圍。

## 內容

| 種類 | 標頭 | 檔案 |
|---|---|---|
| 一個 commit | hash（可選取複製）、父 commit、作者與 email、作者日期、committer（與作者不同時才顯示，含 commit 日期）、完整訊息 | 這個 commit 改的檔案 |
| 比較兩個 commit | 兩個 hash | 兩者之間的差異 |
| 未 commit 的修改 | — | 工作目錄的修改（含未追蹤，依設定） |
| stash | stash 的名稱、基底 commit | stash 的修改（含未追蹤的部分） |
| tag | 名稱、tagger、日期、訊息（annotated 才有） | — |

- 訊息照原樣換行，套用輕量標記（`commits.markdown`，見 10）。日期依 `commits.dateFormat`，但「相對」在這裡顯示成日期與時間。
- 簽章不顯示；issue linking 不做；訊息裡的 URL 不可點（只是文字）。
- 高度可拖（見 00）；右上角 ✕ 或 Esc 關閉（焦點在輸入框或下拉選單時 Esc 不關）。

## 檔案清單

- 檔案樹（`details.fileView = tree`，資料夾可收合，`details.compactFolders` 把單一子資料夾串起來）或扁平清單（`list`）。
- 每個檔案：狀態（A／M／D／R／U）、路徑、+/- 行數。
- **點一下**：打開 diff 視窗（這個 commit 的父 ↔ 這個 commit；比較時是兩個 commit；未 commit 時是 HEAD ↔ 工作目錄）。
- **⌘-click**：打開檔案在「結果那一邊」的內容（刪除的檔案仍是 diff）。
- 右鍵選單（見 40）：View File at this Revision、Open File（用系統預設的 App 開工作目錄裡的檔案；遠端 repo 不提供）、Diff with Working File（這個版本 ↔ 工作目錄）、Reset File to this Revision…（先確認，`checkout <rev> -- <path>`）、Copy File Path（repo 內的相對路徑）。刪除的檔案只能 Reset 與 Copy；未 commit 列裡未追蹤的檔案不能 Reset。沒有外部 diff 工具。
- 檔案清單不做虛擬捲動：全部列出，在自己的欄裡捲動。換一個 commit 時資料夾全部展開。
