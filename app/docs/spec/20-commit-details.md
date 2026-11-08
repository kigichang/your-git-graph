# Commit 詳細資料

## 位置

- inline 在選取列的下方（`details.location = inline`，預設）或停靠在底部（`bottom`）。inline 時面板從 graph 欄的右邊開始，graph 的線在面板旁邊繼續畫下去。改設定後，已打開的留在原處，下次打開才換。
- 自動置中（`details.autoCenter`）：打開時把列捲到可見範圍。

## 內容

| 種類 | 標頭 | 檔案 |
|---|---|---|
| 一個 commit | 逐行 `標籤: 值`：Commit（完整 hash）、Parents（完整 hash，每個都是連結）、Author、Committer（名字與 email，email 是 `mailto:` 連結）、Date（作者日期）、Commit Date（與作者日期不同時才有）；空一行後是完整訊息。全部可選取複製 | 這個 commit 改的檔案 |
| 比較兩個 commit | 兩個 hash | 兩者之間的差異 |
| 未 commit 的修改 | — | 工作目錄的修改（含未追蹤，依設定） |
| stash | 標題是 stash 的名稱，其餘同 commit | stash 的修改（含未追蹤的部分） |
| tag | 名稱、tagger、日期、訊息（annotated 才有） | — |

- 訊息照原樣換行，套用輕量標記（`commits.markdown`，見 10）。日期一律是完整的當地時間含時區（`Sun Nov 01 2026 16:12:33 GMT+0800 (Taiwan Standard Time)`），不看 `commits.dateFormat`（它只管 graph 的 Date 欄）。
- 點父 commit 的連結：選取它那一列（不在已載入範圍就先載入到它）；graph 沒有列出它時（被篩選掉、不在 first-parent 線上）只顯示它的詳細資料。點 email：交給系統的郵件程式。
- 簽章不顯示；issue linking 不做；訊息裡的 URL 不可點（只是文字）。
- 高度可拖（見 00）；右邊 icon 欄的 ✕ 或 Esc 關閉（焦點在輸入框或下拉選單時 Esc 不關）。
- 右邊的直向 icon 欄，由上而下：關閉；以清單顯示、以樹狀顯示（目前的那個有底色；改的是 `details.fileView`，所有視窗一起變，以後打開也照這樣）；收合所有資料夾、展開所有資料夾（清單檢視時不能按）。tag 與錯誤訊息沒有檔案，只有關閉。

## 檔案清單

- 扁平清單（`details.fileView = list`，預設：完整路徑，同資料夾的排在一起，子資料夾在前）或檔案樹（`tree`，資料夾可收合，`details.compactFolders` 把單一子資料夾串起來）。
- 每個檔案：檔案圖示、名稱（顏色表示狀態：新增與未追蹤綠、修改橘、刪除紅、改名綠）、`( +12 | -0 )`（+ 綠、- 紅；二進位檔沒有這段）。狀態字母（A／M／D／R／U）只給螢幕閱讀器。
- **點一下**：打開 diff 視窗（這個 commit 的父 ↔ 這個 commit；比較時是兩個 commit；未 commit 時是 HEAD ↔ 工作目錄）。
- **⌘-click**：打開檔案在「結果那一邊」的內容（刪除的檔案仍是 diff）。
- 右鍵選單（見 40）：View File at this Revision、Open File（用系統預設的 App 開工作目錄裡的檔案；指到 repo 外的 symlink 拒絕，打開會執行的檔案——腳本、安裝檔、捷徑、沒有副檔名的可執行檔——改用文字編輯器開，資料夾（submodule）在 Finder 裡顯示；遠端 repo 不提供）、Diff with Working File（這個版本 ↔ 工作目錄）、Reset File to this Revision…（先確認，`checkout <rev> -- <path>`）、Copy File Path（repo 內的相對路徑）。刪除的檔案只能 Reset 與 Copy；未 commit 列裡未追蹤的檔案不能 Reset。沒有外部 diff 工具。
- 檔案清單不做虛擬捲動：全部列出，在自己的欄裡捲動。換一個 commit 時資料夾全部展開；行數隨後補上時不影響已收合的資料夾。
