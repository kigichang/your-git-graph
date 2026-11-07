# 驗收清單（self-test）

`GG_SELFTEST=1`（`scripts/selftest.sh <執行檔> <repo 或含多個 repo 的資料夾>`）時，`web/src/selftest.ts` 依序做下列檢查，最後在 stderr 輸出 `selftest: PASS` 或 `selftest: FAIL <原因>`。它會寫入目標 repo（臨時分支、`gg-selftest/` 裡的檔案、`gg-selftest-*` remote、`.your-git-graph.json`，都會刪掉），要對 scratch 的 clone 跑。腳本自己起 `tests/basic_auth_server.py` 當要帳密的 HTTP 位址，並檢查伺服器收到對話框輸入的帳密。

| # | 檢查 | 里程碑 | 狀態 |
|---|---|---|---|
| 1 | 打開三種 diff 視窗（一個檔案的變更、檔案內容、比較）：每個都畫出內容、Monaco worker 沒有警告、搜尋框開著時 Esc 只關搜尋框、Esc 關閉視窗；最後只剩主視窗 | M0 | ✅ |
| 1b | graph 載入：有列、layout 的列數與 commit 數一致、canvas 有畫、只有可視範圍的列在 DOM；暖機重載一次記時間；大 repo（還有更多時）全部載入並在 3 秒內捲到底，平均每幀 < 20ms | M1 | ✅ |
| 2 | 介面語言切成繁體中文再切回英文：工具列與側欄文字跟著變、`settings.json` 存的是 `zh-TW`；不重新載入 | M6 | ✅ |
| 3 | 載入 repo：graph 有列、點一列打開詳細資料（列被選取、訊息、檔案清單、行數）、分支篩選（選一個分支後列數不多於全部、Show All 回來）、Esc 關閉面板 | M2 | ✅ |
| 4 | 讀取：repo info、commits、details（commit／stash／未 commit／比較）、line counts、tag details（annotated 與否）、reflog 面板有項目、worktree 面板列出主 worktree | M2／M6 | ✅ |
| 5 | 寫入（`repo_op`）：建立並 checkout `gg-selftest-*` 分支、repo info 列出它、切回原分支、最後刪掉；拒絕其他視窗沒有的 repo 路徑（M5） | M3 | ✅ |
| 6 | data-loss：在臨時分支上 revert 一個 commit（只有它才有的 commit），強制移動該分支 → `needsConfirmation`（`branchMoveDropsCommits`，1 個）→ 帶 `confirmed` 重送 → 分支真的移動；經視窗執行時對話框列出原因的句子，按 Continue 才執行 | M3／M4 | ✅ |
| 7 | 進度與取消：加入指向自己的 remote 並 fetch，串流輸出含 `From `；fetch 一個不會回應的位址（10.255.255.1，需要網路）後取消，5 秒內回 `Cancelled.` | M3 | ✅ |
| 8 | askpass：對要帳密的位址 fetch，對話框先問名稱（明文）再問密碼（遮罩），伺服器拒絕後操作失敗；在對話框按 Cancel 操作失敗；問題開著時取消操作，對話框自己關掉；本機 git 一輪、遠端 helper 的 git 一輪（伺服器的 log 各看到一次帳密）。ssh-keygen 的 passphrase 只有手動 | M5／M7 | ✅ |
| 9 | 詳細資料裡的檔案：點一次開 diff、⌘-click 開檔案內容；⇧-click 兩列的比較（較舊的在前）與比較視窗 | M2 | ✅ |
| 9b | 選單與對話框：右鍵一列打開選單（列出 commit 的動作）→ Create Branch… → 對話框打開、輸入名稱、Enter → 分支出現在 graph、對話框關閉；右鍵分支標籤 → Delete… → Enter → 分支消失；建立已存在的分支 → 錯誤對話框顯示 git 的訊息、Close 關掉；Esc 關閉選單 | M4 | ✅ |
| 10 | Markdown 預覽：`selftest_write` 把 `gg-selftest/doc.md` 與 `pic.png` 放進工作目錄，未 commit 列的詳細資料列出它們；⌘-click 開檔案視窗：區塊帶行號、程式碼上色、KaTeX、repo 裡的圖片、Mermaid、PlantUML（假 java，jar 設到 `gg-selftest/plantuml.jar`）、`<script>` 是文字、捲動同步；最後 clean 清掉 | M7 | ✅ |
| 11 | 圖片 diff：點未 commit 列裡的 `pic.png`，視窗以圖片顯示並解出 1×1 | M7 | ✅ |
| 12 | 子 repo 掃描（含多個 repo 的資料夾全部加入）、最近清單、多 repo 視窗切換 | M5 | ✅ |
| 13 | 檔案監看：工作目錄建立與刪除檔案各刷新一次（`repo-changed` → 150ms 合併 → reload；操作中與結束後 1 秒忽略）；自動測試不能寫檔，手動驗證 | M5 | 手動 |
| 14 | 設定：讀到預設值、超出範圍的值被拒絕（訊息含範圍）、改列高後視窗的列跟著變、`null` 回預設；設定面板打開與關閉；對話框預設值經 `dialogs.*`（單元測試） | M2／M6 | ✅ |
| 15 | state 經 Rust 寫入 `state.json`（`state_set`；前端不用 `localStorage`，diff 視窗的偏好除外）；第一次啟動刪掉 Stage 1 的 key（Rust 測試） | M6 | ✅ |
| 16 | 匯出 repo 設定（`.your-git-graph.json`）；已有該檔時不覆寫；寫入一個較新的檔後再顯示 repo，設定被讀回（order=topo）；最後用 clean 清掉 | M6 | ✅ |
| 17 | Find：打開、輸入後第一筆被選取、Enter 跳下一筆、符合的列高亮、Esc 關閉 | M6 | ✅ |
| 18 | 側欄：清單與目前的 repo、收合／展開、切到另一個 repo 與切回、群組（建立、移入、改名、收合計數、刪除）、Remove（改顯示另一個）後加回、拖資料夾到視窗（`tauri://drag-drop`）、Open in New Window 開出再關掉；拖拉排序與多選只有手動 | M5 | ✅ |
| 19 | 主題：AccentColor 解析成顏色、強調色上的文字是白色、`set_appearance` 切到另一種外觀後 `<html>` 的 class 與 token 跟著變、之後開的 diff 視窗 Monaco 主題一致（vs／vs-dark）、強制增強對比的 class 與顏色不同、切回 system | M7 | ✅ |
| 20 | 遠端 repo（假 ssh）：加入、側欄顯示主機、graph 與詳細資料經 helper、建立與刪除分支、拒絕 archive、遠端 git 的帳密提示（第 8 項的一輪）、斷線後請求失敗、再顯示即重連、移除；背後變動的刷新只有手動 | M5／M7 | ✅ |
