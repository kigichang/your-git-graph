# 遠端 repo、SMB、帳密提示、檔案監看

這些是 Stage 1 自己設計的（Rust：`remote.rs`、`crates/remote`、`system.rs`、`askpass.rs`、`crates/backend/src/watch.rs`），Stage 2 沿用；這裡只寫使用者看得到的行為。

## 遠端 repo（SSH）

- 名稱 `ssh://[user@]host[:port]/絕對路徑`，`host` 可以是 `~/.ssh/config` 的別名。側欄與標題顯示主機。
- Add SSH Repository… 對話框：destination（`[user@]host`）、port、path（相對路徑從家目錄起算）。以 `-` 開頭的主機或使用者被拒絕。
- 只有「加入」「顯示」「點變淡的項目」會連線；開機只連最後顯示的那個，其他遠端 repo 變淡。
- 連線的密碼、passphrase、host key 確認出現在發出連線的視窗。
- 遠端的 git 帳密提示也出現在 App 裡。
- 斷線：項目變淡、請求失敗；點一下重連。
- 不提供：Reveal in Finder、開啟檔案、外部 diff 工具、archive。Copy File Path 複製遠端路徑。
- 遠端的 commit、checkout、stage、fetch 即時刷新；工作目錄未暫存的修改在視窗取得焦點時刷新。

## 網路磁碟（SMB）

- Connect to Server (SMB)…：`smb://server/share`（不含空白），帳密由 macOS 對話框與 Keychain 處理，掛載後開資料夾選擇器。
- share 上的 repo 記住它的 share；沒掛載時變淡，點了重新掛載。視窗取得焦點時刷新（其他機器的變動不會回報）。

## 帳密提示（askpass）

- git／ssh 要帳密、passphrase、host key 確認時，在**發出請求的視窗**顯示對話框：提示文字（來自 git／ssh，只當文字顯示）、輸入框（密碼遮罩）、OK／Cancel。
- 多個提示排隊依序顯示。git 先結束（逾時、取消）就自動關閉。未回答 5 分鐘後放棄。
- Keychain、ssh-agent 有答案時不會問。

## 檔案監看

- 本機 repo 用 FSEvents：`.git` 裡的 HEAD、refs、packed-refs、index、config、進行中操作的標記檔，以及工作目錄未被忽略的檔案。事件合併 300ms。
- 變動的 repo 正是目前顯示的 repo 才刷新；自己的寫入操作執行中與結束後 1 秒內的事件忽略。載入途中發生的變動在載入完後補刷新一次。
- linked worktree 與 submodule（`.git` 是檔案）也監看它們的 git dir 與共用的 git dir。
- 閒置時 0 次刷新；終端機 `git commit`、`git checkout -b` 各剛好刷新一次。
