/* Simplified Chinese → Traditional Chinese (Taiwan), for upstream's Chinese interface strings
 * (scripts/prepare-ui.mjs turns the webview's zh-cn dictionary into Taiwanese Chinese).
 * OpenCC's s2twp (characters and common Taiwanese phrasing), then the words Git tools use in
 * Taiwan (Git's own zh_TW translation: 儲存庫, 簽出, 重定基底, 參照, ...) and a few UI terms
 * OpenCC leaves in their Mainland form. Build time only (opencc-js is a dev dependency). */
import * as OpenCC from 'opencc-js';

const s2twp = OpenCC.Converter({ from: 'cn', to: 'twp' });

/** After s2twp, in order (longer phrases before the words they contain). */
export const TAIWAN_TERMS = [
	['倉庫', '儲存庫'],
	['檢出', '簽出'],
	['變基', '重定基底'],
	['引用', '參照'],
	['當前', '目前'],
	['查詢', '尋找'],
	['過濾', '篩選'],
	['匹配項', '符合項目'],
	['匹配', '符合'],
	['跳轉到', '跳至'],
	['跳轉', '跳至'],
	['詳情', '詳細資料'],
	['滾動', '捲動'],
	['跟蹤', '追蹤'],
	['丟失', '遺失'],
	['回收站', '垃圾桶'],
	['本地', '本機'],
	['更改', '變更'],
	['恢復', '復原'],
	['獲取', '取得'],
	['加載', '載入'],
	['保存', '儲存'],
	['鏈接', '連結'],
	['粘貼', '貼上'],
	['終端', '終端機'],
	['終端機機', '終端機'],
	['屏幕', '螢幕'],
	['鼠標', '滑鼠'],
	['視圖', '檢視'],
	['默認', '預設'],
	['佈局', '版面'],
	['配置', '設定'],
	['全域性', '全域'],
	['單個', '單一'],
	['評審', '審查'],
	['可選', '選用'],
	['歸檔', '封存'],
	['字號', '字型大小'],
	['常規', '一般'],
	['上下文選單', '右鍵選單'],
	['拉取請求', '提取要求'],
	['貯藏', '儲藏'],
	['應用', '套用'],
	['自定義', '自訂'],
	['身份', '身分'],
	['列表', '清單'],
	['日誌', '記錄'],
	// The language names in the Settings Widget: the app's Chinese is Traditional, and "auto"
	// follows the system (there is no VS Code).
	['（簡體）', '（繁體）'],
	['（跟隨 VS Code）', '（跟隨系統）'],
	['“', '「'],
	['”', '」'],
	['‘', '『'],
	['’', '』']
];

export function toTaiwanese(text) {
	let out = s2twp(text);
	for (const [from, to] of TAIWAN_TERMS) out = out.split(from).join(to);
	return out;
}
