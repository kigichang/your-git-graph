/* The diff window (ui/diff.html): a Monaco diff editor, a read-only file view, an image / binary
 * comparison, or a file list with a diff beside it. Bundled by scripts/build-diff.mjs into
 * ui/diff-dist/. What to show arrives as window.__GG_DIFF_SPEC (see ui/host/diffspec.js); the
 * contents are read here, from the engine (revisions) and the worktree_file command (disk). */
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/register.all'; // syntax colouring only, no language services
import { fileSides, WORKTREE } from '../ui/host/diffspec.js';

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
let editorTheme = null;
const applyTheme = () => window.__ggTheme.onChange((t) => { editorTheme = monacoTheme(t); monaco.editor.setTheme(editorTheme); });

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
	return { kind: 'file', language: model.getLanguageId(), lines: model.getLineCount() };
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
		const escape = await checkEscape();
		await window.__TAURI__.event.emit('diff-selftest', { mode: spec.mode, title: spec.title, result, workerProblems, theme: editorTheme, escape });
		// Closed the way a person would: Esc.
		setTimeout(() => document.body.dispatchEvent(escapeKey()), 200);
	}
}

main();
