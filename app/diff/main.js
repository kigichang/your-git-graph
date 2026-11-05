/* The diff window (ui/diff.html): a Monaco diff editor, a read-only file view (a Markdown file
 * with its rendered page beside it), an image / binary comparison, or a file list with a diff
 * beside it. Bundled by scripts/build-diff.mjs into ui/diff-dist/. What to show arrives as window.__GG_DIFF_SPEC (see ui/host/diffspec.js); the
 * contents are read here, from the engine (revisions) and the worktree_file command (disk). */
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/register.all'; // syntax colouring only, no language services
import { fileSides, WORKTREE } from '../ui/host/diffspec.js';
import { isMarkdown, resolveRelative, monotonic, lineToOffset, offsetToLine } from './mdview.js';

const { invoke } = window.__TAURI__.core;
const spec = window.__GG_DIFF_SPEC;
const workerProblems = [];

self.MonacoEnvironment = { getWorker: () => new Worker('diff-dist/editor.worker.js') };
const warn = console.warn.bind(console);
console.warn = (...args) => { if (String(args[0]).includes('worker')) workerProblems.push(String(args[0])); warn(...args); };

const log = (line) => invoke('host_log', { line: 'diff: ' + line }).catch(() => {});
window.addEventListener('error', (e) => log('error: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => log('rejection: ' + ((e.reason && e.reason.stack) || e.reason)));

const $ = (id) => document.getElementById(id);
const basename = (path) => path.split('/').pop();

/* ---------- Reading the two sides ---------- */

async function engine(method, params) {
	const answer = JSON.parse(await invoke('engine_request', { repo: spec.repo, request: JSON.stringify({ method, params }) }));
	if (answer !== null && typeof answer === 'object' && !Array.isArray(answer) && Object.keys(answer).length === 1 && typeof answer.error === 'string') {
		throw new Error(answer.error);
	}
	return answer;
}

const base64Size = (b64) => Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/** { exists, binary, text, base64, size, note } of one side; null is an empty (absent) file. */
async function readSide(side, wantBytes) {
	if (side === null) return { exists: false, binary: false, text: '', base64: null, size: 0, note: null };
	if (side.rev === WORKTREE) {
		const f = await invoke('worktree_file', { repo: spec.repo, path: side.path });
		return { exists: f.exists, binary: f.binary, text: f.text ?? '', base64: f.base64, size: f.size, note: f.skipped ?? (f.exists ? null : 'Not in the working tree') };
	}
	try {
		const f = await engine('loadCommitFile', { commitHash: side.rev, file: side.path });
		if (!f.binary && !wantBytes) return { exists: true, binary: false, text: f.contents ?? '', base64: null, size: (f.contents ?? '').length, note: null };
		const b = await engine('fileBytes', { revision: side.rev, path: side.path });
		return { exists: b.bytes !== null, binary: f.binary, text: f.contents ?? '', base64: b.bytes, size: b.bytes ? base64Size(b.bytes) : 0, note: null };
	} catch (e) {
		return { exists: false, binary: false, text: '', base64: null, size: 0, note: String((e && e.message) || e) };
	}
}

/* ---------- Editors ---------- */

function languageFor(path) {
	const name = basename(path).toLowerCase(), ext = name.includes('.') ? '.' + name.split('.').pop() : null;
	for (const l of monaco.languages.getLanguages()) {
		if ((l.filenames || []).some((f) => f.toLowerCase() === name)) return l.id;
		if (ext && (l.extensions || []).some((e) => e.toLowerCase() === ext)) return l.id;
	}
	return 'plaintext';
}

/* The editor's theme follows the appearance (ui/theme.js), Increase Contrast included. */
const monacoTheme = (t) => (t.contrast ? (t.dark ? 'hc-black' : 'hc-light') : t.dark ? 'vs-dark' : 'vs');
let editorTheme = null, onAppearance = null;
const applyTheme = () => window.__ggTheme.onChange((t) => {
	editorTheme = monacoTheme(t);
	monaco.editor.setTheme(editorTheme);
	if (onAppearance !== null) onAppearance(t);
});

const EDITOR_OPTIONS = {
	readOnly: true, automaticLayout: true, scrollBeyondLastLine: false, minimap: { enabled: false },
	fontFamily: 'SF Mono, Menlo, Monaco, monospace', fontSize: 12, renderWhitespace: 'selection'
};
const prefs = (() => { try { return JSON.parse(localStorage.getItem('gg.diffPrefs') || '{}'); } catch (_) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('gg.diffPrefs', JSON.stringify(prefs)); } catch (_) { /* storage unavailable */ } };

let diffEditor = null, singleEditor = null, models = [];
function disposeModels() { models.forEach((m) => m.dispose()); models = []; }

function show(panel) {
	for (const id of ['editor', 'binary', 'message']) $(id).hidden = id !== panel;
}
function message(text) { $('message').textContent = text; show('message'); }

/** Resolves with the line changes once the diff is computed. */
function showTextDiff(left, right, leftFile, rightFile) {
	show('editor');
	if (diffEditor === null) {
		diffEditor = monaco.editor.createDiffEditor($('editor'), {
			...EDITOR_OPTIONS, originalEditable: false, renderSideBySide: prefs.inline !== true,
			ignoreTrimWhitespace: prefs.ignoreWhitespace === true, renderOverviewRuler: true
		});
	}
	const language = languageFor((right ?? left).path);
	const original = monaco.editor.createModel(leftFile.text, language);
	const modified = monaco.editor.createModel(rightFile.text, language);
	const done = new Promise((resolve) => { const d = diffEditor.onDidUpdateDiff(() => { d.dispose(); resolve(diffEditor.getLineChanges() || []); }); });
	diffEditor.setModel({ original, modified });
	disposeModels();
	models = [original, modified];
	return done.then((changes) => {
		let added = 0, removed = 0;
		for (const c of changes) {
			if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
			if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
		}
		$('stats').textContent = changes.length === 0 ? 'No changes' : '+' + added + ' −' + removed;
		const notes = [leftFile.note && 'Left: ' + leftFile.note, rightFile.note && 'Right: ' + rightFile.note].filter(Boolean);
		$('note').textContent = notes.join(' · ');
		return { kind: 'text', language, changes: changes.length, leftLines: original.getLineCount(), rightLines: modified.getLineCount() };
	});
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' };

function showBinary(left, right, leftFile, rightFile) {
	const mime = IMAGE_TYPES[((right ?? left).path.split('.').pop() || '').toLowerCase()];
	const panel = $('binary');
	panel.replaceChildren();
	const decoded = [];
	const describe = (label, file) => {
		const col = document.createElement('figure');
		const caption = document.createElement('figcaption');
		caption.textContent = label + ': ' + (file.exists ? file.size.toLocaleString() + ' bytes' : file.note || 'absent');
		col.appendChild(caption);
		if (mime && file.base64) {
			const img = document.createElement('img');
			img.src = 'data:' + mime + ';base64,' + file.base64;
			col.appendChild(img);
			decoded.push(img.decode().then(() => {
				caption.textContent += ' · ' + img.naturalWidth + '×' + img.naturalHeight;
				return img.naturalWidth + 'x' + img.naturalHeight;
			}, () => 'undecodable'));
		}
		return col;
	};
	panel.append(describe('Before', leftFile), describe('After', rightFile));
	const identical = leftFile.base64 !== null && leftFile.base64 === rightFile.base64;
	$('stats').textContent = !leftFile.exists ? 'Added' : !rightFile.exists ? 'Deleted' : identical ? 'Identical' : 'Binary files differ';
	show('binary');
	return Promise.all(decoded).then((dimensions) => ({ kind: mime ? 'image' : 'binary', identical, dimensions }));
}

/** Show the change of one file: text in the diff editor, anything else side by side. */
async function showChange(left, right, binary) {
	$('stats').textContent = 'Loading…';
	$('note').textContent = '';
	const [leftFile, rightFile] = await Promise.all([readSide(left, binary), readSide(right, binary)]);
	if (leftFile.binary || rightFile.binary || binary) return showBinary(left, right, leftFile, rightFile);
	return showTextDiff(left, right, leftFile, rightFile);
}

async function showFile(side) {
	const file = await readSide(side, false);
	$('diffControls').hidden = true;
	if (file.binary) return showBinary(null, side, { exists: false, base64: null, size: 0, note: 'not shown' }, file);
	if (!file.exists) { message(file.note || 'The file does not exist at this revision.'); return { kind: 'missing' }; }
	show('editor');
	const model = monaco.editor.createModel(file.text, languageFor(side.path));
	models.push(model);
	singleEditor = monaco.editor.create($('editor'), { ...EDITOR_OPTIONS, model });
	$('stats').textContent = model.getLineCount().toLocaleString() + ' lines';
	const result = { kind: 'file', language: model.getLanguageId(), lines: model.getLineCount() };
	if (isMarkdown(side.path) && file.text.length <= PREVIEW_MAX) result.preview = await setupPreview(side, file.text);
	return result;
}

/* ---------- The preview of a Markdown file ---------- */

/* The file view of a .md / .markdown file shows the rendered page to the right of the source
 * (the toolbar's Preview box hides it; kept in gg.diffPrefs). The renderer (markdown.js: raw
 * HTML escaped) and Mermaid are bundles of their own, loaded when a file needs them. Code is
 * coloured by Monaco, images of the repository are read at the revision shown, links open in
 * the browser, PlantUML is rendered by the plantuml.jar of the settings (Rust: plantuml.rs).
 * The two panes scroll together. */
const PREVIEW_MAX = 2 * 1024 * 1024;
const loaded = new Map();
/** One of the bundles in diff-dist/ (with its stylesheet), once. */
function loadBundle(name, withStyles) {
	if (!loaded.has(name)) {
		loaded.set(name, new Promise((resolve, reject) => {
			if (withStyles) {
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.href = 'diff-dist/' + name + '.css';
				document.head.appendChild(link);
			}
			const script = document.createElement('script');
			script.src = 'diff-dist/' + name + '.js';
			script.onload = resolve;
			script.onerror = () => reject(new Error('diff-dist/' + name + '.js did not load'));
			document.head.appendChild(script);
		}));
	}
	return loaded.get(name);
}

/** Monaco's language for the name after ``` (an id or one of its aliases), or null. */
function languageNamed(name) {
	const wanted = name.toLowerCase();
	for (const l of monaco.languages.getLanguages()) {
		if (l.id === wanted || (l.aliases || []).some((a) => a.toLowerCase() === wanted) || (l.extensions || []).includes('.' + wanted)) return l.id;
	}
	return null;
}

async function colourCode(page) {
	await Promise.all(Array.from(page.querySelectorAll('pre > code[class*="language-"]')).map(async (code) => {
		const name = Array.from(code.classList).find((c) => c.startsWith('language-')).slice('language-'.length);
		const language = languageNamed(name);
		if (language === null) return;
		try {
			code.innerHTML = await monaco.editor.colorize(code.textContent.replace(/\n$/, ''), language, { tabSize: 4 });
		} catch (_) { /* stays as plain text */ }
	}));
}

/** Images: one of the repository is read where the file itself comes from; http(s) and data:
 * images load as they are; anything else is not loaded. Called before the page is attached. */
function repositoryImages(page, side) {
	return Promise.all(Array.from(page.querySelectorAll('img')).map(async (img) => {
		const src = img.getAttribute('src') || '';
		if (/^(https?:|data:image\/)/i.test(src)) return;
		img.removeAttribute('src');
		const path = resolveRelative(side.path, src);
		const mime = path === null ? undefined : IMAGE_TYPES[(path.split('.').pop() || '').toLowerCase()];
		if (mime === undefined) return;
		const file = await readSide({ rev: side.rev, path }, true);
		if (!file.exists) return;
		if (file.base64) img.src = 'data:' + mime + ';base64,' + file.base64;
		else if (file.text !== '') img.src = 'data:' + mime + ',' + encodeURIComponent(file.text); // an SVG of the working tree
	}));
}

let mermaidTheme = null;
async function drawMermaid(page, appearance) {
	const nodes = Array.from(page.querySelectorAll('pre.mermaid'));
	if (nodes.length === 0) return;
	try {
		await loadBundle('mermaid', false);
		const theme = appearance.dark ? 'dark' : 'default';
		if (theme !== mermaidTheme) {
			window.__ggMermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict' });
			mermaidTheme = theme;
		}
		for (const node of nodes) {
			// Drawn before (the appearance changed): from its source again.
			if (node.dataset.source === undefined) node.dataset.source = node.textContent;
			else { node.textContent = node.dataset.source; node.removeAttribute('data-processed'); }
		}
		await window.__ggMermaid.run({ nodes, suppressErrors: true });
	} catch (e) {
		log('mermaid: ' + ((e && e.message) || e)); // the diagrams stay as their source
	}
}

const openSettings = () => invoke('settings_path').then((path) => invoke('open_path', { path, text: true })).catch((e) => log('settings: ' + e));

/** PlantUML blocks not drawn yet, through the jar of the settings; one that cannot be drawn
 * keeps its source, with the reason and a way to the settings below it. */
function drawPlantuml(page) {
	return Promise.all(Array.from(page.querySelectorAll('pre.plantuml:not(.rendered)')).map(async (node) => {
		if (node.dataset.source === undefined) node.dataset.source = node.textContent;
		try {
			const svg = await invoke('render_plantuml', { code: node.dataset.source });
			const img = document.createElement('img'); // an image, never inline SVG: nothing of it runs
			img.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
			img.alt = 'PlantUML diagram';
			node.replaceChildren(img);
			node.classList.add('rendered');
		} catch (e) {
			const note = document.createElement('div');
			note.className = 'diagramNote';
			const reason = document.createElement('span');
			reason.textContent = String(e);
			const button = document.createElement('button');
			button.textContent = 'Open Settings';
			button.addEventListener('click', openSettings);
			note.append(reason, button);
			node.replaceChildren(document.createTextNode(node.dataset.source), note);
		}
	}));
}

let preview = null; // { pane, page, sync } once a Markdown file is shown with its preview
async function setupPreview(side, text) {
	const pane = $('preview'), toggle = $('previewToggle');
	$('previewControl').hidden = false;
	toggle.checked = prefs.preview !== false;
	let rendered = null;
	// Rendered once, when first shown; a failure is told in the pane.
	const render = () => (rendered ??= renderPreview(pane, side, text).catch((e) => {
		pane.textContent = 'The preview cannot be shown: ' + ((e && e.message) || e);
		return { shown: true, error: String((e && e.message) || e) };
	}));
	toggle.addEventListener('change', () => {
		prefs.preview = toggle.checked; savePrefs();
		pane.hidden = !toggle.checked;
		if (toggle.checked) render().then(() => { if (preview !== null) preview.sync('editor'); });
	});
	if (!toggle.checked) return { shown: false };
	pane.hidden = false;
	return render();
}

async function renderPreview(pane, side, text) {
	await loadBundle('preview', true);
	const template = document.createElement('template'); // inert: its images do not load yet
	template.innerHTML = window.__ggPreview.renderMarkdown(text);
	const page = document.createElement('div');
	page.className = 'md';
	page.appendChild(template.content);
	const images = repositoryImages(page, side);
	pane.replaceChildren(page);
	// Links never navigate this window: web and mail links open in their apps.
	page.addEventListener('click', (e) => {
		const anchor = e.target instanceof Element ? e.target.closest('a') : null;
		if (anchor === null) return;
		e.preventDefault();
		const href = anchor.getAttribute('href') || '';
		if (/^(https?:\/\/|mailto:)/i.test(href)) invoke('open_url', { url: href }).catch((err) => log('link: ' + err));
	});
	preview = { pane, page, sync: syncScrolling(pane, page) };
	onAppearance = (t) => drawMermaid(page, t);
	// A jar set in the settings meanwhile draws what could not be drawn before.
	window.addEventListener('focus', () => drawPlantuml(page));
	await Promise.all([images, colourCode(page), drawMermaid(page, window.__ggTheme.current()), drawPlantuml(page)]);
	return {
		shown: true,
		blocks: page.querySelectorAll('[data-line]').length,
		coloured: page.querySelectorAll('pre > code span[class*="mtk"]').length,
		images: page.querySelectorAll('img[src^="data:image/"]:not(pre img)').length,
		katex: page.querySelectorAll('.katex').length,
		mermaid: page.querySelectorAll('pre.mermaid svg').length,
		plantuml: page.querySelectorAll('pre.plantuml.rendered img').length,
		notes: Array.from(page.querySelectorAll('.diagramNote span')).map((n) => n.textContent),
		scripts: page.querySelectorAll('script').length
	};
}

/** Keeps the editor and the page at the same place of the document. Only the pane being used
 * (pointer over it, keys in it) moves the other, so the two do not answer each other. Returns
 * sync(from), to bring the other pane to where `from` ('editor' | 'preview') is. */
function syncScrolling(pane, page) {
	const editor = singleEditor;
	let active = 'editor', marks = null;
	for (const type of ['pointerenter', 'wheel', 'keydown', 'pointerdown']) {
		pane.addEventListener(type, () => { active = 'preview'; }, { passive: true });
		$('editor').addEventListener(type, () => { active = 'editor'; }, { passive: true, capture: true });
	}
	// Where each block of the page is; measured again once the page's size changed (images,
	// diagrams, the window's width).
	new ResizeObserver(() => { marks = null; }).observe(page);
	const measured = () => {
		if (marks === null) {
			const top = page.getBoundingClientRect().top;
			const blocks = Array.from(page.querySelectorAll('[data-line]')).map((el) => ({ line: Number(el.dataset.line), top: el.getBoundingClientRect().top - top }));
			marks = monotonic([{ line: 1, top: 0 }, ...blocks, { line: editor.getModel().getLineCount() + 1, top: page.scrollHeight }]);
		}
		return marks;
	};
	const editorMax = () => Math.max(0, editor.getScrollHeight() - editor.getLayoutInfo().height);
	const paneMax = () => Math.max(0, pane.scrollHeight - pane.clientHeight);
	const lineHeight = () => editor.getOption(monaco.editor.EditorOption.lineHeight);
	const fromEditor = () => {
		const top = editor.getScrollTop();
		if (top >= editorMax() - 1 && editorMax() > 0) { pane.scrollTop = paneMax(); return; }
		const first = (editor.getVisibleRanges()[0] || { startLineNumber: 1 }).startLineNumber;
		const line = first + (top - editor.getTopForLineNumber(first)) / lineHeight();
		pane.scrollTop = lineToOffset(measured(), line);
	};
	const fromPreview = () => {
		if (pane.scrollTop >= paneMax() - 1 && paneMax() > 0) { editor.setScrollTop(editorMax()); return; }
		const line = offsetToLine(measured(), pane.scrollTop), whole = Math.max(1, Math.floor(line));
		editor.setScrollTop(editor.getTopForLineNumber(whole) + (line - whole) * lineHeight());
	};
	editor.onDidScrollChange((e) => { if (active === 'editor' && e.scrollTopChanged && !pane.hidden) fromEditor(); });
	pane.addEventListener('scroll', () => { if (active === 'preview') fromPreview(); }, { passive: true });
	return (from) => { active = from; if (from === 'editor') fromEditor(); else fromPreview(); };
}

async function showCompare() {
	const { from, to } = spec;
	const single = from === to;
	const fileChanges = single
		? (to === '*' ? await engine('loadUncommittedDetails') : await engine('loadCommitDetails', { hash: to })).fileChanges
		: await engine('compareCommits', { from, to: to === '*' ? '' : to });
	const list = $('files');
	list.hidden = false;
	if (fileChanges.length === 0) { message('No files changed.'); return { kind: 'compare', files: 0 }; }
	let first = null;
	for (const change of fileChanges) {
		const item = document.createElement('button');
		item.className = 'file';
		const status = document.createElement('span');
		status.className = 'status s' + change.type;
		status.textContent = change.type;
		const name = document.createElement('span');
		name.textContent = change.newFilePath;
		name.title = change.oldFilePath !== change.newFilePath ? change.oldFilePath + ' → ' + change.newFilePath : change.newFilePath;
		item.append(status, name);
		const open = () => {
			list.querySelectorAll('.file.selected').forEach((e) => e.classList.remove('selected'));
			item.classList.add('selected');
			const { left, right } = fileSides(from, to, change.oldFilePath, change.newFilePath, change.type);
			return showChange(left, right, false);
		};
		item.addEventListener('click', open);
		list.appendChild(item);
		first = first ?? open;
	}
	const result = await first();
	return { ...result, kind: 'compare', files: fileChanges.length };
}

/* ---------- Toolbar ---------- */

function setupToolbar() {
	$('title').textContent = spec.title;
	$('prev').addEventListener('click', () => diffEditor && diffEditor.goToDiff('previous'));
	$('next').addEventListener('click', () => diffEditor && diffEditor.goToDiff('next'));
	const layout = $('layout');
	const renderLayout = () => { layout.textContent = prefs.inline ? 'Side by Side' : 'Inline'; };
	renderLayout();
	layout.addEventListener('click', () => {
		prefs.inline = !prefs.inline; savePrefs(); renderLayout();
		if (diffEditor) diffEditor.updateOptions({ renderSideBySide: !prefs.inline });
	});
	const ws = $('whitespace');
	ws.checked = prefs.ignoreWhitespace === true;
	ws.addEventListener('change', () => {
		prefs.ignoreWhitespace = ws.checked; savePrefs();
		if (diffEditor) diffEditor.updateOptions({ ignoreTrimWhitespace: ws.checked });
	});
}

/* Esc closes the window, unless Monaco used the key itself (closing its find widget, dropping
 * extra cursors): it marks the events it handles with preventDefault. Not while an input
 * method is composing. The self-test records instead of closing (escapeLog). */
let escapeLog = null;
window.addEventListener('keydown', (e) => {
	if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
	e.preventDefault();
	if (escapeLog !== null) escapeLog.push('close');
	else window.__TAURI__.window.getCurrentWindow().close();
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeKey = () => new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });

/** Self-test: Esc with Monaco's find widget open closes only the widget; the next Esc closes
 * the window. findFirst is null where there is no editor (images, other binaries). */
async function checkEscape() {
	escapeLog = [];
	const editor = diffEditor !== null ? diffEditor.getModifiedEditor() : singleEditor;
	let findFirst = null;
	if (editor !== null) {
		editor.focus();
		await editor.getAction('actions.find').run();
		await pause(300);
		const widgetOpen = () => document.querySelector('.find-widget.visible') !== null;
		const opened = widgetOpen();
		(document.activeElement || document.body).dispatchEvent(escapeKey());
		await pause(300);
		findFirst = opened && !widgetOpen() && escapeLog.length === 0;
	}
	document.body.dispatchEvent(escapeKey());
	const closes = escapeLog.length === 1;
	escapeLog = null;
	return { findFirst, closes };
}

/** Self-test: the page follows the editor to the end and back to the start, and the editor
 * follows the page. null when the document is too short to scroll. */
async function checkSync() {
	const { pane, sync } = preview, editor = singleEditor;
	const editorMax = editor.getScrollHeight() - editor.getLayoutInfo().height, paneMax = pane.scrollHeight - pane.clientHeight;
	if (editorMax <= 0 || paneMax <= 0) return null;
	sync('editor');
	editor.setScrollTop(editorMax);
	await pause(100);
	const end = pane.scrollTop >= paneMax - 1;
	editor.setScrollTop(0);
	await pause(100);
	const start = pane.scrollTop === 0;
	sync('preview');
	pane.scrollTop = paneMax;
	await pause(100);
	const back = editor.getScrollTop() >= editorMax - 1;
	sync('editor');
	editor.setScrollTop(0);
	await pause(100);
	return end && start && back;
}

async function main() {
	applyTheme();
	setupToolbar();
	let result;
	try {
		result = spec.mode === 'file' ? await showFile(spec.side)
			: spec.mode === 'compare' ? await showCompare()
				: await showChange(spec.left, spec.right, spec.binary === true);
	} catch (e) {
		message(String((e && e.message) || e));
		result = { kind: 'error', error: String((e && e.message) || e) };
	}
	log(spec.mode + ' ' + JSON.stringify(result));
	if (await invoke('self_test') !== null) {
		if (result.preview && result.preview.shown && !result.preview.error) result.preview.synced = await checkSync();
		const escape = await checkEscape();
		await window.__TAURI__.event.emit('diff-selftest', { mode: spec.mode, title: spec.title, result, workerProblems, theme: editorTheme, escape });
		// Closed the way a person would: Esc.
		setTimeout(() => document.body.dispatchEvent(escapeKey()), 200);
	}
}

main();
