# 驗收清單（self-test）

`GG_SELFTEST=1`（`scripts/selftest.sh <執行檔> <repo 或含多個 repo 的資料夾>`）時，`web/src/selftest.ts` 依序做下列檢查，最後在 stderr 輸出 `selftest: PASS` 或 `selftest: FAIL <原因>`。它會寫入目標 repo（臨時分支、`gg-selftest/` 裡的檔案、`gg-selftest-*` remote、`.your-git-graph.json`，都會刪掉），要對 scratch 的 clone 跑。腳本自己起 `tests/basic_auth_server.py` 當要帳密的 HTTP 位址，並檢查伺服器收到對話框輸入的帳密。

| # | 檢查 | 里程碑 | 狀態 |
|---|---|---|---|
| 1 | 打開三種 diff 視窗（一個檔案的變更、檔案內容、比較）：每個都畫出內容、Monaco worker 沒有警告、搜尋框開著時 Esc 只關搜尋框、Esc 關閉視窗；最後只剩主視窗 | M0 | ✅ |
| 1b | graph 載入：有列、layout 的列數與 commit 數一致、canvas 有畫、只有可視範圍的列在 DOM；暖機重載一次記時間；大 repo（還有更多時）全部載入並在 3 秒內捲到底，平均每幀 < 20ms | M1 | ✅ |
| 2 | 介面語言切成繁體中文再切回英文：工具列與側欄文字跟著變、`settings.json` 存的是 `zh-TW`；不重新載入 | M6 | ✅ |
| 3 | 載入 repo：graph 有列、點一列打開詳細資料（列被選取、訊息、檔案清單、行數）、分支篩選（選一個分支後列數不多於全部、Show All 回來）、Esc 關閉面板 | M2 | ✅ |
| 4 | 讀取：repo info、commits、details（commit／stash／未 commit／比較）、line counts、tag details（annotated 與否）、reflog 面板有項目、worktree 面板列出主 worktree | M2／M6 | ✅ |
| 5 | 寫入（`repo_op`）：建立並 checkout `gg-selftest-*` 分支、repo info 列出它、切回原分支、最後刪掉；不在側欄清單裡的 repo 路徑一律拒絕（「… is not in the sidebar」），讀取、操作、引擎請求、工作目錄的檔案、開檔、Finder、Terminal 各檢查一次；頁面不能呼叫 diff 視窗用不到的引擎方法（`submodules`） | M3／M8 | ✅ |
| 5b | 安全邊界：每個 diff 視窗呼叫 `open_terminal`、`open_repo_file`、`reveal_repo`、`repo_op`、`repo_read`、`settings_set`、`state_set`、`open_diff_window`、`scan_repos`、`clipboard_write` 都被拒絕（not allowed）；Content-Security-Policy 擋得住 `eval`，而且所有視窗跑完整個 self-test 沒有其他東西被它擋掉 | M8 | ✅ |
| 6 | data-loss：在臨時分支上 revert 一個 commit（只有它才有的 commit），強制移動該分支 → `needsConfirmation`（`branchMoveDropsCommits`，1 個）→ 帶 `confirmed` 重送 → 分支真的移動；經視窗執行時對話框列出原因的句子，按 Continue 才執行 | M3／M4 | ✅ |
| 7 | 進度與取消：加入指向自己的 remote 並 fetch，串流輸出含 `From `；fetch 一個不會回應的位址（10.255.255.1，需要網路）後取消，5 秒內回 `Cancelled.` | M3 | ✅ |
| 8 | askpass：對要帳密的位址 fetch，對話框先問名稱（明文）再問密碼（遮罩），伺服器拒絕後操作失敗；在對話框按 Cancel 操作失敗；問題開著時取消操作，對話框自己關掉；本機 git 一輪、遠端 helper 的 git 一輪（伺服器的 log 各看到一次帳密）。ssh-keygen 的 passphrase 只有手動 | M5／M7 | ✅ |
| 9 | 詳細資料裡的檔案：點一次開 diff、⌘-click 開檔案內容；⇧-click 兩列的比較（較舊的在前）與比較視窗 | M2 | ✅ |
| 9b | 選單與對話框：右鍵一列打開選單（列出 commit 的動作）→ Create Branch… → 對話框打開、輸入名稱、Enter → 分支出現在 graph、對話框關閉；右鍵分支標籤 → Delete… → Enter → 分支消失；建立已存在的分支 → 錯誤對話框顯示 git 的訊息、Close 關掉；Esc 關閉選單 | M4 | ✅ |
| 10 | Markdown 預覽：`selftest_write` 把 `gg-selftest/doc.md` 與 `pic.png` 放進工作目錄，未 commit 列的詳細資料列出它們；⌘-click 開檔案視窗：區塊帶行號、程式碼上色、KaTeX、repo 裡的圖片、網路上的圖片不載入（按了 Load 才載入）、Mermaid、PlantUML（假 java，jar 設到 `gg-selftest/plantuml.jar`）、`<script>` 是文字、捲動同步；最後 clean 清掉 | M7 | ✅ |
| 11 | 圖片 diff：點未 commit 列裡的 `pic.png`，視窗以圖片顯示並解出 1×1 | M7 | ✅ |
| 12 | 子 repo 掃描（含多個 repo 的資料夾全部加入）、最近清單、多 repo 視窗切換 | M5 | ✅ |
| 13 | 檔案監看：工作目錄建立與刪除檔案各刷新一次（`repo-changed` → 150ms 合併 → reload；操作中與結束後 1 秒忽略）；自動測試不能寫檔，手動驗證 | M5 | 手動 |
| 14 | 設定：讀到預設值、超出範圍的值被拒絕（訊息含範圍）、改列高後視窗的列跟著變、`null` 回預設；設定面板打開與關閉；對話框預設值經 `dialogs.*`（單元測試） | M2／M6 | ✅ |
| 15 | state 經 Rust 寫入 `state.json`（`state_set`；前端不用 `localStorage`，diff 視窗的偏好除外）；第一次啟動刪掉 Stage 1 的 key（Rust 測試） | M6 | ✅ |
| 16 | 匯出 repo 設定（`.your-git-graph.json`）；已有該檔時不覆寫；寫入一個較新的檔後再顯示 repo，設定被讀回（order=topo）；最後用 clean 清掉 | M6 | ✅ |
| 16b | 設定面板的 Export Repository Configuration：寫出 `.your-git-graph.json` 並顯示寫到哪裡；再按一次顯示檔案已存在、不覆寫 | M8 | ✅ |
| 17 | Find：打開、輸入後第一筆被選取、Enter 跳下一筆、符合的列高亮、在 graph 按 Esc 只關 Find（詳細資料留著）、在輸入框按 Esc 關閉 | M6 | ✅ |
| 18 | 側欄：清單與目前的 repo、收合／展開、切到另一個 repo 與切回、群組（建立、移入、改名、收合計數、刪除）、Remove（改顯示另一個）後加回、拖資料夾到視窗（`tauri://drag-drop`）、Open in New Window 開出再關掉；拖拉排序與多選只有手動 | M5 | ✅ |
| 19 | 主題：AccentColor 解析成顏色、強調色上的文字是白色、`set_appearance` 切到另一種外觀後 `<html>` 的 class 與 token 跟著變、之後開的 diff 視窗 Monaco 主題一致（vs／vs-dark）、強制增強對比的 class 與顏色不同、切回 system | M7 | ✅ |
| 14b | 日期：預設顯示作者日期（`timing.datesMs > 0`，git 讀）、改成 `commit` 後不讀、改回再讀；Rust 測試確認作者日期與 committer 日期不同的 commit 顯示對的那個 | M8 | ✅ |
| 14c | 只剩 reflog 記得的 commit：打開 `commits.includeReflog` 後 git 被問（`timing.reflogMs > 0`）、列只增不減，關掉後回到原本的列；Rust 測試確認 reset 掉的 commit 出現一次、在父之前、stash 自己的 commit 不出現、有分支篩選時不加 | M8 | ✅ |
| 14d | 表頭：預設固定在表格頂端；`graph.stickyHeader` 關掉後表頭跟著列一起捲、第一列緊接在它下方；改回預設又固定 | M8 | ✅ |
| 14e | 線條風格：`graph.style` 改成 `angular` 後 graph 重畫；改回預設 | M8 | ✅ |
| 14f | session log：打開 `log.enabled` 時寫一行記號再關掉；`scripts/selftest.sh` 檢查 `session.log` 有那一行、其他時候的 log 行（例如 graph 載入時的）沒有寫進去 | M8 | ✅ |
| 3b | 詳細資料 inline：緊接在選取列下方、下一列在面板下方、在 graph 欄右邊、graph 的線在旁邊繼續畫、沒有同時停靠底部；設定改成 `bottom` 時已開的不動；Esc 關閉；下一次打開停靠底部 | M8 | ✅ |
| 3d | 詳細資料的內容：hash、committer、完整日期都顯示，作者 email 是 `mailto:` 連結，檔案有 `( +n \| -m )`；點父 commit 的連結選取它那一列並顯示它的詳細資料（要先載入更多、graph 沒有列出的兩種情況沒有自動測試） | M8 | ✅ |
| 3e | 詳細資料右邊的 icon：清單檢視時收合與展開不能按；按樹狀後檔案數不變、`details.fileView` 存成 `tree`；收合所有資料夾後只剩不在資料夾裡的檔案，展開後全部回來；按清單回到清單 | M8 | ✅ |
| 3f | 載入途中的要求：載入中要求 reload，載完補跑一次且只有一次；載入中切到另一個 repo（資料夾模式；單一 repo 時是同一個），新的 repo 正常顯示、之後還能載入、也切得回來 | M8 | ✅ |
| 3c | Enter：Esc 關掉詳細資料後，在 graph 按 Enter 重新打開選取列的詳細資料（同一個 commit），再 Esc 關閉 | M8 | ✅ |
| 20 | 遠端 repo（假 ssh）：加入、側欄顯示主機、graph 與詳細資料經 helper、建立與刪除分支、拒絕 archive、遠端 git 的帳密提示（第 8 項的一輪）、斷線後請求失敗、再顯示即重連、移除；背後變動的刷新只有手動 | M5／M7 | ✅ |
