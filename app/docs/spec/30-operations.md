# 操作

每個操作一列：使用者在哪裡觸發、對話框問什麼、執行什麼 git 指令、data-loss 規則、完成後的刷新、錯誤怎麼顯示。git 指令照 `main` 分支的 `app/ui/host/gitops.js`（自己的程式碼）搬成 Rust（`crates/backend/src/ops/`）。

## 共同規則

- 所有 git 都帶 `GIT_EDITOR=true`、`GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`，帳密走 askpass（見 95）。
- 使用者輸入的值進 argv 前檢查：以 `-` 開頭就拒絕。
- 同一個 repo 同時只執行一個寫入操作；執行中按鈕鎖住。
- 錯誤：git 的 stderr（沒有就 stdout，再沒有就 exit code）顯示在對話框裡。
- 有進度的操作（fetch、pull、push）顯示串流輸出，可取消。
- 完成後 graph 重新載入；檔案監看在操作期間與結束後 1 秒內的事件忽略。

## data-loss 警告

執行前先檢查，會丟資料就先問，使用者確認後才執行：

| 情況 | 規則 |
|---|---|
| 離開 detached HEAD（checkout commit／branch、建立並 checkout 分支、stash branch） | HEAD 上有不在任何分支、tag、remote-tracking 分支裡的 commit |
| reset | 目前分支的 commit 不在其他 ref 上（detached 時同上）；hard reset 時已追蹤檔案有未 commit 的修改 |
| 強制移動既有分支（create branch 的 force） | 它的 commit 不在其他 ref 上 |
| force／force-with-lease push | remote-tracking 分支上有本地分支沒有的 commit（以上次 fetch 為準） |

警告的文字由前端依語言產生（Rust 回結構化的原因與數量）。

## 清單（待填每一列的細節）

| 操作 | 觸發處 | 輸入 | git | 備註 |
|---|---|---|---|---|
| Fetch | 工具列、⌘⇧F | prune、prune tags（設定） | `fetch --all [--prune] [--prune-tags]` | 進度 |
| Fetch into local branch | 遠端分支選單 | | `fetch <remote> <branch>:<local>` | |
| Pull | 遠端分支選單 | no-ff、squash | `pull [--no-ff|--squash] <remote> <branch>`；squash 後 `commit --no-edit` | 進度 |
| Push branch | 分支選單 | remote、force／force-with-lease、set upstream | `push [--force|--force-with-lease] [-u] <remote> <branch>` | 進度；多個 remote 時依序 |
| Create branch | commit 選單 | 名稱、checkout、force | `branch [-f] <name> <hash>`／`checkout -b` | |
| Checkout branch | 分支選單 | （遠端分支：建立本地） | `checkout <branch>`／`checkout -b <local> <remote>/<branch>` | |
| Checkout commit | commit 選單 | | `checkout <hash>` | |
| Delete branch | 分支選單 | force、也刪遠端 | `branch -d|-D`；`push <remote> --delete` | |
| Delete remote branch | 遠端分支選單 | | `push <remote> --delete <branch>` | |
| Rename branch | 分支選單 | 新名稱 | `branch -m` | |
| Merge | 分支／commit 選單 | no-ff、squash、no-commit | `merge [--no-ff] [--squash] [--no-commit]` | |
| Rebase | 分支／commit 選單 | ignore-date、interactive | `rebase`；互動式在 Terminal 執行 | |
| Cherry-pick | commit 選單 | parent（merge 時）、record origin、no-commit | `cherry-pick [-m N] [-x] [--no-commit]` | |
| Revert | commit 選單 | parent（merge 時） | `revert [-m N]` | |
| Continue／Abort | 狀態列 | | `<merge|rebase|cherry-pick|revert> --continue|--abort` | |
| Reset | commit 選單 | soft／mixed／hard | `reset --<mode> <hash>` | data-loss |
| Undo last commit | HEAD 選單 | | `reset --soft HEAD~1` | |
| Drop commit | commit 選單 | | 自製 rebase todo（範圍含 merge 就拒絕） | |
| Edit commit message | commit 選單 | 新訊息、作者 | 自製 rebase todo ＋ `commit --amend` | |
| Fixup／Squash | commit 選單 | | `commit --fixup|--squash` 再 autosquash rebase | |
| Add tag | commit 選單 | 名稱、annotated、訊息、push | `tag [-a -m]`；`push <remote> <tag>` | |
| Delete tag | tag 選單 | 也刪遠端 | `tag -d`；`push <remote> --delete <tag>` | |
| Push tag | tag 選單 | remote | `push <remote> <tag>` | commit 不在 remote 上時先提醒 |
| Add／Edit／Delete／Prune remote | 設定 | 名稱、fetch URL、push URL | `remote add|rename|set-url|remove|prune` | |
| Stash | 未 commit 列選單 | 訊息、含未追蹤 | `stash push [-u] [-m]` | |
| Apply／Pop／Drop stash | stash 選單 | reinstate index | `stash apply|pop [--index]`、`stash drop` | |
| Branch from stash | stash 選單 | 名稱 | `stash branch` | data-loss |
| Clean untracked | 未 commit 列選單 | 含目錄 | `clean -f [-d]` | |
| Reset file to revision | 檔案選單 | | `checkout <hash> -- <path>` | |
| Create archive | commit／tag 選單 | 格式、儲存位置 | `archive` | 遠端 repo 不提供 |
| Worktree add／remove／prune | Worktree 面板 | 路徑、分支 | `worktree add|remove|prune` | |
| Edit／Delete user details | 設定 | 名稱、email、global | `config [--global] user.name|user.email` | |
| Set authors | 設定 | 清單 | 同步全域作者（規則見 60） | |
