# Commit 詳細資料

## 位置

- 停靠在底部（`details.location = bottom`）或 inline 在選取列的下方（`inline`）。改設定後，已打開的留在原處，下次打開才換。
- 自動置中（`details.autoCenter`）：打開時把列捲到可見範圍。

## 內容

| 種類 | 標頭 | 檔案 |
|---|---|---|
| 一個 commit | hash（可複製）、作者、日期、committer、完整訊息、父 commit | 這個 commit 改的檔案 |
| 比較兩個 commit | 兩個 hash | 兩者之間的差異 |
| 未 commit 的修改 | — | 工作目錄的修改（含未追蹤，依設定） |
| stash | stash 的名稱、基底 commit | stash 的修改（含未追蹤的部分） |
| tag | 名稱、tagger、日期、訊息（annotated 才有） | — |

待填：簽章的顯示（Stage 1 決定不做）、issue linking（不做）、訊息裡的 URL 是否可點。

## 檔案清單

- 檔案樹（`details.fileView = tree`，資料夾可收合，`details.compactFolders` 把單一子資料夾串起來）或扁平清單（`list`）。
- 每個檔案：狀態（A／M／D／R／U）、路徑、+/- 行數。
- **點一下**：打開 diff 視窗（這個 commit 的父 ↔ 這個 commit；比較時是兩個 commit；未 commit 時是 HEAD ↔ 工作目錄）。
- **⌘-click**：打開檔案在「結果那一邊」的內容（刪除的檔案仍是 diff）。
- 右鍵選單：待填（View File at this Revision、Open File、Copy File Path、Reset File to this Revision、Open Diff with Working File…）。
- 待填：檔案清單過長時的虛擬捲動需求。
