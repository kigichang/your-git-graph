# 搜尋與篩選

## Find widget（⌘F、工具列按鈕、View > Find…）

- 輸入文字即時比對已載入的 commit（標題、作者名稱與 email、hash、分支／遠端分支／tag 名稱、stash 名稱）；大小寫敏感、regex 兩個開關（記在 state 的 `find`）。regex 無效時沒有符合。
- 顯示「第 n 筆 / 共 m 筆」（沒有時 No matches），上一筆／下一筆（Enter／⇧Enter，到頭繞回），符合的列高亮；輸入後第一筆被選取，跳到的那筆選取並捲到可見（選取同時打開它的詳細資料）。
- Esc 或 ✕ 關閉。
- 只搜尋已載入的 commit，不搜尋尚未載入的（不用引擎的 `searchHistory`）。

## 分支篩選

- 工具列的分支下拉：Show All，或勾選任意多個；勾了之後 graph 只載入那些分支。按鈕顯示 Show All、那一個分支的名稱、或「n branches」。
- 下拉頂端有搜尋框（不分大小寫，比對顯示的名稱）。本地分支與遠端分支在同一份清單，遠端分支顯示成 `origin/x`、字色較淡，不依 remote 分群；remote 的 HEAD 不列出。
- 篩選存在 repo 的 state，下次顯示這個 repo 時還原。

## 作者篩選

- 工具列的作者下拉，清單是引擎的 `authors`（這個 repo 的作者名稱）：All authors，或勾選任意多位；勾了之後 graph 只載入他們的 commit。有搜尋框，按鈕顯示 All authors、那一位、或「n authors」。
- 篩選存在 repo 的 state。
