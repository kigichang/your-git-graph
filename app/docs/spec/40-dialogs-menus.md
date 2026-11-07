# 右鍵選單與對話框

## 右鍵選單

選單在游標旁打開（相對視窗定位，側欄展開時不會被側欄蓋住），點外面或 Esc 關閉。項目依目標：

| 目標 | 項目（待填完整順序與分隔線） |
|---|---|
| commit | Create Branch、Checkout、Cherry Pick、Revert、Merge into current、Rebase current on、Reset current to、Add Tag、Create Archive、Drop、Edit Message、Fixup、Squash、Copy Hash、Copy Subject、Compare with… |
| HEAD 的 commit | 加 Undo Last Commit |
| 本地分支 | Checkout、Rename、Delete、Merge、Rebase、Push、Create Pull Request（不做）、Copy Name |
| 遠端分支 | Checkout（建立本地）、Delete、Fetch into local、Pull into current、Merge、Rebase、Copy Name |
| tag | View Details、Delete、Push、Create Archive、Copy Name |
| stash | Apply、Pop、Drop、Branch from…、Copy Name |
| 未 commit 列 | Stash、Clean Untracked、Reset（discard）、Open in Terminal |
| 檔案 | View File、Open File、Copy Path、Reset to Revision、Diff with Working File、Open External Diff |
| 空白處 | Refresh、Fetch、Open in Terminal、Reveal in Finder |

## 對話框

- 共同殼：標題、欄位表、Cancel／主要動作按鈕；Enter 執行、Esc 取消；打開時焦點在第一個輸入框。
- 參照名稱（分支、tag）輸入時的空白替換（`dialogs.general.spaceSubstitution`：none／hyphen／underscore）。
- 欄位預設值來自設定 `dialogs.<對話框>.<欄位>`（見 60）。
- data-loss 警告是另一個對話框：原因（可多條）、Cancel／Continue。
- 進度對話框：串流輸出（stderr 另一色）、Cancel；完成後自動關閉或顯示錯誤。
- 待填：每個對話框的欄位（照 30 的表）。
