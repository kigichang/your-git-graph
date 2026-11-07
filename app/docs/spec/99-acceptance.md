# 驗收清單（self-test）

`GG_SELFTEST=1`（`scripts/selftest.sh <執行檔> <repo 或含多個 repo 的資料夾>`）時，`web/src/selftest.ts` 依序做下列檢查，最後在 stderr 輸出 `selftest: PASS` 或 `selftest: FAIL <原因>`。它會寫入目標 repo（臨時分支、臨時檔、`.your-git-graph.json`，都會刪掉），要對 scratch 的 clone 跑。

| # | 檢查 | 里程碑 | 狀態 |
|---|---|---|---|
| 1 | 打開三種 diff 視窗（一個檔案的變更、檔案內容、比較）：每個都畫出內容、Monaco worker 沒有警告、搜尋框開著時 Esc 只關搜尋框、Esc 關閉視窗；最後只剩主視窗 | M0 | ✅ |
| 1b | graph 載入：有列、layout 的列數與 commit 數一致、canvas 有畫、只有可視範圍的列在 DOM；暖機重載一次記時間；大 repo（還有更多時）全部載入並在 3 秒內捲到底，平均每幀 < 20ms | M1 | ✅ |
| 2 | 介面語言切成繁體中文再切回英文：工具列與側欄文字跟著變、`settings.json` 存的是 `zh-TW`；不重新載入 | M6 | |
| 3 | 載入 repo：graph 有列、HEAD 的列有標籤、點一列打開詳細資料、檔案清單有檔案 | M2 | |
| 4 | 讀取：repo info、commits、details（commit／stash／未 commit／比較）、line counts、tag details、reflog、worktree list | M2 | |
| 5 | 寫入：建立再刪除 `gg-selftest-*` 分支；拒絕其他視窗沒有的 repo 路徑 | M3 | |
| 6 | data-loss：用 `commit-tree` 做只有某分支才有的 commit，強制移動該分支 → 收到需要確認 → 對話框顯示原因 → 繼續後分支真的移動 → 刪掉 | M3／M4 | |
| 7 | 進度與取消：fetch 的串流輸出、取消後 git 結束 | M3 | |
| 8 | askpass：回答並遮罩、取消、git 逾時後對話框自動關閉、ssh-keygen 的 passphrase | M5 | |
| 9 | 詳細資料裡的檔案：點一次開 diff、⌘-click 開檔案內容 | M4 | |
| 10 | Markdown 預覽：表格、程式碼上色、數學式、repo 裡的圖片、Mermaid、PlantUML（假 java）、`<script>` 是文字、捲動同步 | M0（沿用） | |
| 11 | 圖片 diff（commit 同時改文字檔與 PNG 時） | M0（沿用） | |
| 12 | 子 repo 掃描、最近清單、多 repo 視窗切換 | M5 | |
| 13 | 檔案監看：工作目錄建立與刪除檔案各刷新一次 | M5 | |
| 14 | 設定：存檔後各視窗套用、超出範圍的值被拒絕、對話框預設值、details 位置 | M6 | |
| 15 | state 經 Rust 寫入 `state.json`，不留在 `localStorage` | M6 | |
| 16 | 匯出 repo 設定再讀回；已有該檔時不覆寫 | M6 | |
| 17 | Find：⌘F 打開、符合數、上下一筆、Esc 關閉 | M6 | |
| 18 | 側欄：清單與目前的 repo、收合／展開、右鍵選單位置、Open 另一個 repo、切回、Open in New Window（askpass 只在新視窗）、拖拉排序、群組（建立、拖進、排序、收合、改名、多選整批移動、刪除）、Remove、拖資料夾到視窗 | M5 | |
| 19 | 主題：AccentColor 可解析、強調色上的文字是白色、切淺色／深色後 WebKit 跟著變、增強對比的 class 與顏色、diff 視窗的 Monaco 主題一致 | M6 | |
| 20 | 遠端 repo（假 ssh）：加入、標題與側欄顯示主機、git 與引擎在遠端路徑執行、讀工作目錄檔案、拒絕 archive、遠端 git 的帳密提示、背後建立與刪除分支各刷新一次、斷線變淡且請求失敗、點一下重連、移除 | M5 | |
