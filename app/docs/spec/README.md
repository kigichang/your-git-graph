# 功能規格

Stage 2 的程式碼只依據這裡的規格、引擎（`vendor/vscode-git-graph-rs/native/core`，MIT）的介面、以及 git 的文件來寫。規格描述**使用者看得到的行為**：畫面上有什麼、能做什麼、結果是什麼、背後執行哪個 git 指令。不描述 DOM、class 名稱、內部協定。

來源：Stage 1 的 App（tag `v0.7.0`）實際的行為，用執行中的 App 與截圖觀察而得；git 語意的部分對照那個 tag 上我們自己寫的 `app/ui/host/gitops.js`（那是自己的程式碼，可以看）。

| 檔案 | 內容 | 狀態 |
|---|---|---|
| [00-overview.md](00-overview.md) | 視窗、版面、起始畫面、選單列與快捷鍵、語言 | 完成 |
| [10-graph.md](10-graph.md) | graph 的欄位、ref 標籤、選取、鍵盤、載入更多、排序、篩選 | 完成 |
| [20-commit-details.md](20-commit-details.md) | commit／比較／未 commit／stash 的詳細資料與檔案清單 | 完成 |
| [30-operations.md](30-operations.md) | 每個 git 操作：輸入、指令、data-loss 規則、刷新、錯誤、進度 | 完成 |
| [40-dialogs-menus.md](40-dialogs-menus.md) | 右鍵選單的項目、對話框的共同規則 | 完成 |
| [50-sidebar-repos.md](50-sidebar-repos.md) | 側欄、群組、拖拉、多視窗、最近清單、Finder 拖放 | 完成 |
| [60-settings-state.md](60-settings-state.md) | `settings.json`、`state.json`、repo 設定匯出 | 完成 |
| [70-find-filters.md](70-find-filters.md) | 搜尋、分支與作者篩選 | 完成 |
| [80-reflog-worktree.md](80-reflog-worktree.md) | Reflog 與 Worktree 面板 | 完成 |
| [90-diff-window.md](90-diff-window.md) | diff 視窗（沿用 Stage 1 的程式） | 完成 |
| [95-remote-askpass-watch.md](95-remote-askpass-watch.md) | 遠端 repo、SMB、帳密提示、檔案監看 | 完成 |
| [99-acceptance.md](99-acceptance.md) | self-test 的驗收清單 | 完成 |

全部檔案都已補完，描述 M0–M8 完成時 App 實際的行為；「不做」「沒有」是第一版刻意不提供的。之後改動行為時同步改這裡。
