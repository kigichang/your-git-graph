# Diff 視窗

沿用 Stage 1 的程式（`app/diff/main.js`，Monaco）。由 graph 視窗經 `open_diff_window` 打開，要顯示什麼以 `initialization_script` 注入成 `window.__GG_DIFF_SPEC`（`web/src/lib/diffspec.ts` 產生）：

```
{ mode: 'diff',    repo, title, left, right, binary }   一個檔案的變更
{ mode: 'file',    repo, title, side }                  一個檔案在某個版本的內容
{ mode: 'compare', repo, title, from, to }              兩個版本之間所有變更的檔案（左側清單）
```

side 是 `{ rev, path }`：`rev` 是引擎能解析的 revision（hash、`<hash>^`、`HEAD`）或 `*`（工作目錄）；`null` 代表空檔案（新增／刪除的一邊）。`from === to` 代表「那一個 commit」（父 ↔ 它）；`*` 代表 HEAD ↔ 工作目錄。

## 行為

- 文字：左右對照或 inline、上一個／下一個變更、忽略空白、依副檔名上色；偏好存在 diff 視窗的 `localStorage`（`gg.diffPrefs`）。
- 圖片：並排、各自的尺寸與大小；其他二進位檔比大小。
- 檔案檢視 `.md`／`.markdown`（2 MB 以內）：右側預覽（表格、task list、KaTeX、程式碼上色、repo 內的相對路徑圖片、Mermaid、PlantUML 經本機 jar）；`<script>` 與 HTML 只會是文字；兩邊捲動互相跟隨；連結在瀏覽器打開。
- 主題跟隨外觀（含增強對比）。
- Esc 關閉（Monaco 自己處理過的 Esc 例外，例如關搜尋框；輸入法組字中不關）。
- 工作目錄檔案經 `worktree_file` 讀（拒絕 `..`、絕對路徑、指向 repo 外的 symlink；超過 50 MB 不載入）；版本內容經引擎 `loadCommitFile`／`fileBytes`。
