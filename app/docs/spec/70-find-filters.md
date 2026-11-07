# 搜尋與篩選

## Find widget（⌘F、工具列按鈕、View > Find…）

- 輸入文字即時比對已載入的 commit（標題、作者、hash、日期、ref 名稱）；大小寫敏感、regex 兩個開關（記在 state）。
- 顯示「第 n 筆 / 共 m 筆」，上一筆／下一筆（Enter／⇧Enter），符合的列高亮、目前那筆捲到可見。
- Esc 關閉；關閉時可選擇是否打開目前那筆的詳細資料（記在 state）。
- 待填：是否搜尋尚未載入的 commit（引擎的 `searchHistory`）。

## 分支篩選

- 工具列的分支下拉：Show All、目前分支、各分支與 remote 分支可勾選多個；有篩選時 graph 只載入那些分支。
- 待填：下拉內的搜尋框、remote 的群組顯示。

## 作者篩選

- 待填：Stage 1 的行為（引擎提供 `authors` 清單）。
