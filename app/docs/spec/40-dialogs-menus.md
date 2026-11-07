# 右鍵選單與對話框

## 右鍵選單

選單在游標旁打開（相對視窗定位，側欄展開時不會被側欄蓋住），點外面或 Esc 關閉。項目依目標：

| 目標 | 項目（依序；「｜」是分隔線） |
|---|---|
| commit | Create Branch…、Checkout、Cherry Pick…、Revert… ｜ Merge into current branch…、Rebase current branch on this…、Reset current branch to this… ｜ Add Tag…、Create Archive… ｜ （HEAD 的 commit 才有）Undo Last Commit…、Drop…、Edit Message…、Fixup staged changes into this、Squash staged changes into this ｜ Compare with selected、Copy Hash、Copy Subject |
| 未 commit 列 | Stash…、Clean untracked files…、Discard changes… ｜ Open in Terminal、Compare with selected |
| 本地分支 | Checkout、Rename…、Delete… ｜ Merge into current branch…、Rebase current branch on this…、Push… ｜ Copy Name |
| 遠端分支 | Checkout as local branch…、Fetch into local branch…、Pull into current branch… ｜ Merge into current branch…、Rebase current branch on this…、Delete on remote… ｜ Copy Name |
| tag | View Details、Push…、Delete…、Create Archive… ｜ Copy Name |
| stash 列 | Apply…、Pop…、Drop…、Create branch from stash… ｜ Copy Name |
| 檔案（詳細資料裡） | View File at this Revision、Open File、Diff with Working File ｜ Reset File to this Revision… ｜ Copy File Path |
| 空白處 | Refresh、Fetch from Remotes… ｜ Open in Terminal、Reveal in Finder |

- 會丟東西的項目（Reset、Drop、Delete、Discard、Clean、Undo、Reset File）以警示色顯示。
- 不能用時變灰：Create Archive、Open File、Reveal in Finder 在遠端 repo；Fixup／Squash 沒有 staged 的修改；Compare 沒有選取另一列；目前分支的 Checkout、Delete、Merge、Rebase；remote 不在這個 repo 的 remote 清單時遠端分支的 Fetch into、Pull、Delete；刪除的檔案的 View／Open／Diff；未追蹤檔案的 Reset File。
- 沒有 Create Pull Request、外部 diff 工具。

## 對話框

- 共同殼：標題、欄位表、Cancel／主要動作按鈕；Enter 執行、Esc 取消；打開時焦點在第一個輸入框。
- 參照名稱（分支、tag）輸入時的空白替換（`dialogs.general.spaceSubstitution`：none／hyphen／underscore）。
- 欄位預設值來自設定 `dialogs.<對話框>.<欄位>`（見 60）。
- data-loss 警告是另一個對話框：原因（可多條）、Cancel／Continue。
- 進度對話框：串流輸出（stderr 另一色）、Cancel；結束後留著，標題顯示完成或失敗（失敗時加上錯誤訊息），按 Close 或 Esc 關閉。
- 錯誤對話框：git 的訊息；多步驟操作失敗時說明在哪一步（例如 tag 建好了但 push 失敗）；Close 關閉。
- 欄位驗證：必填的名稱或 remote 空白時對話框不關，顯示「Name?」之類的提示。
- 每個對話框的欄位（括號是預設值與對應的 `dialogs.*` key，見 60）：

| 對話框 | 欄位 |
|---|---|
| Create Branch | 名稱；Check out（否，`createBranch.checkout`） |
| Checkout `<remote>/<branch>` | 本地分支名稱（remote 分支去掉 remote 的名稱） |
| Rename | 名稱（原名） |
| Delete 分支 | Force delete（否，`deleteBranch.force`）；Also delete on remote（None／各 remote） |
| Delete on remote | 說明文字 |
| Push | Remote（第一個）；Set as upstream（是）；Mode：Normal／Force with lease／Force（Normal） |
| Fetch from Remotes | Remote（All／各 remote）；Prune（`fetch.prune`，否則 `repository.fetchAndPrune`）；Prune tags（`fetch.pruneTags`，否則 `repository.fetchAndPruneTags`） |
| Fetch into local branch | 本地分支名稱；Force（否，`fetchIntoLocalBranch.force`） |
| Pull | no-ff（`pull.noFastForward`）；squash（`pull.squash`） |
| Merge | no-ff（`merge.noFastForward`）；squash（`merge.squash`）；no-commit（`merge.noCommit`） |
| Rebase | ignore date（`rebase.ignoreDate`）；autosquash（`rebase.autosquash`）；interactive（`rebase.interactive`） |
| Cherry Pick | Mainline parent（merge commit 才有，1）；record origin（`cherryPick.recordOrigin`）；no-commit（`cherryPick.noCommit`） |
| Revert | Mainline parent（merge commit 才有，1）；一般 commit 沒有欄位 |
| Reset | Soft／Mixed／Hard（Mixed，`reset.mode`） |
| Discard changes | Mixed／Hard（Mixed，`resetUncommitted.mode`） |
| Undo Last Commit、Drop、Drop stash、Clean untracked、Reset File | 說明文字（Clean untracked 另有 Untracked directories too，是） |
| Edit Message | 訊息（完整訊息）；作者名稱；作者 email |
| Add Tag | 名稱；Annotated／Lightweight（Annotated，`addTag.type`）；訊息；Push to remote（None，`addTag.pushToRemote` 為真時第一個 remote） |
| Delete tag | Also delete on remote（None／各 remote） |
| Push tag | Remote（第一個） |
| Stash | 訊息；Include untracked（否，`stash.includeUntracked`） |
| Apply／Pop | Reinstate the index（否，`applyStash.reinstateIndex`／`popStash.reinstateIndex`） |
| Create branch from stash | 名稱 |
| Add Worktree | 資料夾（`<repo>-worktree`）；要 checkout 的分支（空白：從 HEAD 開新的）；新分支名稱 |
| Remove worktree | Force（否） |
| Add／Edit Remote、User details | 見 60 與設定面板 |

未特別註明的勾選框預設「否」。
