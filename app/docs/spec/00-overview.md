# 總覽

## 視窗

- **graph 視窗**：第一個是 `main`，之後的是 `repo-N`（⌘N、側欄的 Open in New Window）。每個視窗一次顯示一個 repo。
- **diff 視窗**：`diff-N`，由 graph 視窗打開，見 [90-diff-window.md](90-diff-window.md)。
- 待填：視窗大小與位置是否記住；關閉最後一個視窗後 App 是否繼續執行。

## 版面（graph 視窗）

```
┌──────────┬──────────────────────────────────────────┐
│ 側欄     │ 工具列：repo 名稱／分支下拉／作者篩選／按鈕 │
│（可收合）├──────────────────────────────────────────┤
│          │ graph 表格（Graph │ Description │ Date │ Author │ Commit）│
│          ├──────────────────────────────────────────┤
│          │ commit 詳細資料（停靠底部，或 inline 在列下方）│
└──────────┴──────────────────────────────────────────┘
```

待填：各區塊的最小尺寸、可拖的分隔線、底部狀態列（operation state、載入中）。

## 起始畫面（沒有 repo 時）

- 待填：最近清單的呈現、Open Repository…、Add SSH Repository…、Connect to Server (SMB)… 三個入口。

## 選單列與快捷鍵

| 選單 | 項目 | 快捷鍵 |
|---|---|---|
| App | Settings… | ⌘, |
| File | New Window | ⌘N |
| File | Open Repository… | ⌘O |
| File | Open Recent ▸ | |
| File | Add SSH Repository… | |
| File | Connect to Server (SMB)… | |
| View | Refresh | ⌘R |
| View | Find… | ⌘F |
| View | Show HEAD Commit | ⌘J |
| View | Fetch from Remotes | ⌘⇧F |
| View | Toggle Sidebar | ⌃⌘S |
| View | Appearance ▸ System／Light／Dark | |

Edit 選單是系統預設的（輸入框的 ⌘C／⌘V 要能用）。待填：graph 內的鍵盤操作（見 10）。

## 語言

- 英文與繁體中文（臺灣）。設定 `language`：`auto`（系統語言是任何中文就用繁體）、`en`、`zh-TW`。
- 切換即時生效，不重新載入。
- 待填：日期格式與語言的關係。
