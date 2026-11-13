# 側欄與 repo 管理

## 清單

- 所有視窗共用一份 repo 清單（`state.json` 的 `sidebar.repos`），依群組顯示；沒分群的在最上面的 **default** 群組（固定存在，不能改名、刪除，名稱不能被其他群組用）。
- 每個項目：字母頭像（名稱的第一個字母，顏色依名稱固定）、名稱（資料夾名稱）、提示、ahead/behind（有 upstream 才顯示：`rev-list --left-right --count @{upstream}...HEAD`）。
- 目前顯示的 repo 高亮；打不開的（資料夾不存在、主機未連線、share 未掛載）變淡，點了重試。
- 名稱下方的提示：`ssh://` 的 repo 顯示主機（`[user@]host[:port]`）；本機 repo 的資料夾名稱與清單裡別的 repo 相同時，顯示它所在的上一層資料夾名稱；否則沒有提示。滑過項目顯示完整路徑。
- 收 repo 的指令（讀取、操作、引擎請求、讀工作目錄的檔案、匯出 repo 設定）只接受側欄清單裡的 repo（所有視窗共用的那一份）；其他路徑一律拒絕，錯誤是「… is not in the sidebar」。

## 加入

- ＋ 選單：Add Local Repository…（可一次選多個資料夾）、Add SSH Repository…、Connect to Server (SMB)…。
- File > Open Repository…（⌘O）、Open Recent、命令列路徑、拖到視窗、拖到 Dock 圖示、`open -a`。
- 路徑在某個 repo 裡就加那個 repo；否則往下掃最多 3 層（找到的 repo 不再往裡找；略過隱藏資料夾、`node_modules`、`target`、`build`、`dist`），全部加入，最後一個留在畫面上。
- 新加入的 repo（本機與 `ssh://`）放進目前顯示的 repo 所在的群組；沒有顯示中的 repo、或它不在任何群組時放進 default。已在清單裡的 repo 不動。

## 切換、移除、排序、群組

- 點項目切換這個視窗顯示的 repo；全域記住最後顯示的，下次沒帶路徑啟動就開它。
- 右鍵：Open in New Window、Reveal in Finder（本機）、Open in Terminal ｜ Move to “群組”（每個群組一項）、Move out of its group（在群組裡時） ｜ Remove from Sidebar。多選時只有移動與移除。
- 拖拉排序（移動超過 4px 才算拖；Esc 取消）；拖進群組範圍就移進去。**不用** HTML5 drag and drop（Tauri 的檔案拖放會攔走）。
- 多選：⌘-click 加減一列、⇧-click 選到上次點的那列；選取的列可整批移動或移除。
- 群組：New Group…、Rename Group…、Delete Group（裡面的 repo 回 default）；拖群組標題排序；點標題收合（顯示數量）。
- 移除目前顯示的 repo：改顯示接替它位置的那一個；清單空了回起始畫面。

## 收合

- 側欄按鈕、View > Toggle Sidebar（⌃⌘S）。收合時左上角有展開按鈕，工具列出現 repo 下拉選單。

## 多視窗

- ⌘N 開新視窗顯示最後看的 repo；Open in New Window 顯示指定的 repo。
- 某個視窗改了清單，其他視窗跟著更新。

## 最近清單

- 最多 10 筆，每次顯示 repo 就更新；不存在的路徑略過。起始畫面與 File > Open Recent 顯示。
