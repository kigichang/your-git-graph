# 總覽

## 視窗

- **graph 視窗**：第一個是 `main`，之後的是 `repo-N`（⌘N、側欄的 Open in New Window）。每個視窗一次顯示一個 repo。
- **diff 視窗**：`diff-N`，由 graph 視窗打開，見 [90-diff-window.md](90-diff-window.md)。
- graph 視窗打開時 1280×820，最小 640×400；大小與位置不記住。關閉最後一個視窗 App 就結束。

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

- 側欄固定 220px 寬，不能拖；Graph 欄寬依 lane 數（最寬 360px），Date／Author 各 150px、Commit 90px，欄寬不能拖。
- 停靠底部的詳細資料：上緣可拖改高度（預設 280px，最少 120px，最多到視窗高度減 160px）；inline 時拖下緣。
- 工具列右邊的狀態文字：載入的 commit 數、是否還有更多、各階段耗時；載入失敗時是錯誤訊息。
- git 留下進行中的 merge／rebase／cherry-pick／revert 時，graph 下方出現狀態列：「… in progress」（rebase 有進度時加 n/m）、衝突檔案數（滑過列出檔名）、Continue／Abort。
- 沒有另外的「載入中」指示；詳細資料讀取中顯示 Loading…。

## 起始畫面（沒有 repo 時）

- 視窗沒有顯示 repo 時（側欄清單是空的，或顯示的 repo 被移除）出現；側欄清單是空的時側欄不顯示。
- 標題 Your Git Graph；上次的錯誤（有的話）；三個按鈕：Open Repository…（資料夾選擇器，可多選）、Add SSH Repository…、Connect to Server (SMB)…。
- Recent：最近清單（見 50），每筆是資料夾名稱與完整路徑，點了加進側欄並顯示。

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

Edit 選單是系統預設的（輸入框的 ⌘C／⌘V 要能用）。選單指令送給取得焦點的視窗。graph 有焦點時另有 ↑／↓、Home、End、Enter、Esc、⌘J（見 10）；Esc 也關閉詳細資料、找尋 widget、選單、對話框、設定面板。

## 語言

- 英文與繁體中文（臺灣）。設定 `language`：`auto`（系統語言是任何中文就用繁體）、`en`、`zh-TW`。
- 切換即時生效，不重新載入。
- 日期格式（`commits.dateFormat`）與語言無關，都是數字（`2026-11-07 14:30`）；只有「相對」格式的文字（「3 天前」）跟著語言。
