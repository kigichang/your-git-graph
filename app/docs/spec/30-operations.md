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

## 清單

輸入欄位的完整清單與預設值見 40；「進度」表示開進度視窗、串流 git 的輸出、可取消。

| 操作 | 觸發處 | 輸入 | git | 備註 |
|---|---|---|---|---|
| Fetch | 工具列、⌘⇧F、空白處選單 | remote（All 或一個）、prune、prune tags（預設依 `repository.fetchAndPrune*`） | `fetch [--prune [--prune-tags]] <remote>|--all` | 進度 |
| Fetch into local branch | 遠端分支選單 | 本地分支名稱、force | `fetch [--force] <remote> <branch>:<local>` | 進度 |
| Pull | 遠端分支選單 | no-ff、squash | `pull [--squash|--no-ff] <remote> <branch>`；squash 後有 staged 就 `commit --no-edit` | 進度 |
| Push branch | 本地分支選單 | remote（一個）、set upstream（預設勾）、normal／force-with-lease／force | `push [--set-upstream] [--force|--force-with-lease] <remote> <branch>` | 進度；force 類有 data-loss 檢查 |
| Create branch | commit 選單 | 名稱、checkout | `branch <name> <hash>`；勾 checkout 再 `checkout <name>` | checkout 時有離開 detached HEAD 的檢查；force 介面不提供 |
| Checkout branch | 本地分支選單 | — | `checkout <branch>` | 離開 detached HEAD 的檢查 |
| Checkout remote branch | 遠端分支選單 | 本地分支名稱（預設去掉 remote 的名稱） | `checkout -b <local> <remote>/<branch>` | 同上 |
| Checkout commit | commit 選單 | — | `checkout --detach <hash>` | 同上 |
| Delete branch | 本地分支選單（目前分支不可） | force、也刪哪個 remote 上的（None 或一個） | `branch -d|-D <name>`；`push <remote> --delete <name>`（remote 上已經沒有就改刪 remote-tracking 分支） | 刪 remote 時進度 |
| Delete remote branch | 遠端分支選單 | — | `push <remote> --delete <branch>`（同上） | 進度 |
| Rename branch | 本地分支選單 | 新名稱 | `branch -m <old> <new>` | |
| Merge | 分支／遠端分支／commit 選單 | no-ff、squash、no-commit | `merge [--squash|--no-ff] [--no-commit] <target>`；squash 且沒勾 no-commit 時有 staged 就 `commit --no-edit` | |
| Rebase | 分支／遠端分支／commit 選單 | ignore-date、autosquash、interactive | `rebase [--ignore-date] [--autosquash] <onto>`（autosquash 時加 `-i`，`GIT_EDITOR=true` 下自動進行）；interactive 在 Terminal 執行 `rebase -i …` | |
| Cherry-pick | commit 選單 | mainline parent（merge commit 才有）、record origin、no-commit | `cherry-pick [-m N] [-x] [--no-commit] <hash>` | |
| Revert | commit 選單 | mainline parent（merge commit 才有） | `revert --no-edit [-m N] <hash>` | |
| Continue／Abort | 狀態列 | — | `<merge|rebase|cherry-pick|revert> --continue|--abort` | |
| Reset | commit 選單 | soft／mixed／hard（預設 mixed） | `reset --<mode> <hash>` | data-loss |
| Discard changes | 未 commit 列選單 | mixed／hard（預設 mixed） | `reset --mixed|--hard HEAD` | hard 時 data-loss |
| Undo last commit | HEAD 的 commit 選單 | — | `reset --soft HEAD~1` | |
| Drop commit | commit 選單 | — | 自製 rebase todo（`rebase -i --autostash`）；commit 不在目前分支、或之後有 merge commit 就拒絕 | |
| Edit commit message | commit 選單 | 訊息、作者名稱與 email（改了才套用） | HEAD：`commit --amend --only --allow-empty -m <msg> [--author]`；較舊的：自製 rebase todo ＋ 同樣的 amend | 規則同 Drop |
| Fixup／Squash | commit 選單（有 staged 才可選） | — | `commit --fixup=<hash>`／`commit --squash=<hash>` | 之後 Rebase 勾 autosquash 才合進去 |
| Add tag | commit 選單 | 名稱、annotated／lightweight、訊息、push 到哪個 remote（None 或一個） | `tag -a <name> -m <msg> <hash>`／`tag <name> <hash>`；`push <remote> refs/tags/<name>` | push 時進度；commit 不在該 remote 上時先問 |
| Delete tag | tag 選單 | 也刪哪個 remote 上的 | `push <remote> --delete refs/tags/<tag>`，再 `tag -d <tag>` | 刪 remote 時進度 |
| Push tag | tag 選單 | remote（一個） | `push <remote> refs/tags/<tag>` | 進度；commit 不在 remote 上時先問 |
| Add／Edit／Delete／Prune remote | 設定面板 | 名稱、fetch URL、push URL（空白＝相同）、加入後 fetch（預設勾） | `remote add`、`remote set-url [--push]`、`fetch <name>`；`remote rename`、`remote set-url [--push] [--add|--delete]`；`remote remove`；`remote prune` | 加入時進度 |
| Stash | 未 commit 列選單 | 訊息、含未追蹤 | `stash push [--include-untracked] [-m <msg>]` | |
| Apply／Pop／Drop stash | stash 選單 | reinstate index | `stash apply|pop [--index] <stash>`、`stash drop <stash>` | |
| Branch from stash | stash 選單 | 名稱 | `stash branch <name> <stash>` | 離開 detached HEAD 的檢查 |
| Clean untracked | 未 commit 列選單 | 含目錄（預設勾） | `clean -f [-d]` | |
| Reset file to revision | 檔案選單 | （確認） | `checkout <rev> -- <path>` | |
| Create archive | commit／tag 選單 | 存檔對話框（`<repo>-<ref>.zip`） | `archive -o <path> <ref>` | 遠端 repo 不提供 |
| Worktree add／remove／prune | Worktree 面板 | 資料夾（預設 `<repo>-worktree`）、要 checkout 的分支、新分支名稱；remove 的 force | `worktree add [-b <new>] <path> [<branch>]`、`worktree remove [--force] <path>`、`worktree prune` | |
| Edit／Delete user details | 設定面板 | 名稱、email（global 時可一併刪 repo 自己的）；刪除時勾名稱／email | `config --local|--global user.name|user.email <值>`；`config --local|--global --unset-all …` | |
| Set authors | 設定面板 | 清單 | 同步全域作者（規則見 60；遠端 repo 不同步） | |
