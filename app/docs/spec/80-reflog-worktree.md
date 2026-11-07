# Reflog 與 Worktree

## Reflog 面板

- 工具列的 Reflog 按鈕打開（再按一次關閉）；可選參照：HEAD（預設）或某個本地分支。清單：`git reflog show <ref>`（selector、短 hash、日期、動作與訊息）；已不在任何 ref 上的 commit 標示 dangling（`rev-list <hashes> --not --all`）。
- 點一筆：graph 已載入那個 commit 就選取它（並打開詳細資料）；沒載入時面板上顯示「Not among the loaded commits」。不 checkout。
- 先列 50 筆，還有更多時 Load more 每次多 100 筆。

## Worktree 面板

- 工具列的 Worktrees 按鈕打開（再按一次關閉）；清單：`git worktree list --porcelain`（路徑、分支或短 hash、main／detached／locked／prunable 標記）。
- Add…（對話框：資料夾、要 checkout 的分支、新分支名稱）、每個非主 worktree 的 Remove…（force）、Prune。操作後清單重讀。
- 點一筆本身沒有行為；非主 worktree 有 Add to sidebar 按鈕，把它加進側欄並顯示。
