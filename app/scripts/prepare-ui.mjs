/* Assemble the webview assets the Tauri app serves, from the upstream submodule.
 *
 * Prerequisites: `npm ci && npm run compile-src && npm run compile-web` in vendor/vscode-git-graph-rs,
 * and `npm ci` in app/.
 * Output: app/ui/media/ (the compiled webview bundle), app/ui/diff-dist/ (the diff window) and
 * app/ui/generated/bootstrap.js
 * (the default view config and repo state, read from upstream's own config code - the same
 * approach as upstream's tests/browserRepro/generate.mjs). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Module } from 'node:module';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.resolve(appDir, '..', 'vendor', 'vscode-git-graph-rs');
const uiDir = path.join(appDir, 'ui');

for (const f of ['media/out.min.js', 'media/out.min.css', 'out/config.js']) {
	if (!fs.existsSync(path.join(upstream, f))) {
		console.error(`missing ${f} - run "npm ci && npm run compile-src && npm run compile-web" in ${upstream}`);
		process.exit(1);
	}
}

/* 1. Copy the compiled webview bundle. */
const mediaOut = path.join(uiDir, 'media');
fs.rmSync(mediaOut, { recursive: true, force: true });
fs.mkdirSync(path.join(mediaOut, 'vendor'), { recursive: true });
for (const f of ['out.min.js', 'out.min.css', 'vendor/markdown-it.min.js']) {
	fs.copyFileSync(path.join(upstream, 'media', f), path.join(mediaOut, f));
}

/* 1b. The interface in Chinese is Traditional Chinese (Taiwan): upstream's zh-cn dictionary is
 * converted in the copied bundle (vendor/ stays as it is). esbuild writes non-ASCII text as \uXXXX
 * escapes, so each double-quoted literal holding CJK escapes is decoded (only escapes of U+0080
 * and up: quotes and backslashes stay escaped), converted (zh-tw.mjs), and re-escaped. The
 * webview still calls the language 'zh-cn' (its code knows no other); host/settings.js maps the
 * app's "zh-tw" setting onto it. */
{
	const { toTaiwanese } = await import('./zh-tw.mjs');
	const bundlePath = path.join(mediaOut, 'out.min.js');
	let bundle = fs.readFileSync(bundlePath, 'utf8');
	const cjkEscape = /\\u(?:3[4-9A-Fa-f]|[4-9][0-9A-Fa-f])[0-9A-Fa-f]{2}/;
	let converted = 0;
	// Runs of text between quotes, backslash escapes other than \\uXXXX, and line breaks: a
	// Chinese string is converted within its own literal (any quote style - esbuild single-quotes
	// strings that hold double quotes), and code, which is ASCII, passes through untouched.
	bundle = bundle.replace(/(?:\\u[0-9A-Fa-f]{4}|[^"'`\\\n])+/g, (run) => {
		if (!cjkEscape.test(run)) return run;
		converted++;
		const text = run.replace(/\\u([0-9A-Fa-f]{4})/g, (m, hex) => (parseInt(hex, 16) >= 0x80 ? String.fromCharCode(parseInt(hex, 16)) : m));
		return toTaiwanese(text).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
	});
	const englishAuto = '"Auto (follows Visual Studio Code)"';
	if (!bundle.includes(englishAuto)) throw new Error('prepare-ui: the English "Auto" language label was not found in the bundle (upstream changed?)');
	bundle = bundle.split(englishAuto).join('"Auto (follows the system)"');
	const esc = (t) => t.replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
	for (const [what, text] of [['the Traditional Chinese language label', '中文（繁體）'], ['the Chinese "auto" label', '自動（跟隨系統）']]) {
		if (!bundle.includes(esc(text))) throw new Error('prepare-ui: ' + what + ' is missing after the conversion (upstream changed?)');
	}
	// Words only Simplified Chinese writes this way must be gone.
	for (const word of ['简体', '远程', '确定', '仓库', '无法', '显示']) {
		if (bundle.includes(esc(word))) throw new Error('prepare-ui: Simplified Chinese (' + word + ') left in the bundle after the conversion');
	}
	fs.writeFileSync(bundlePath, bundle);
	console.log('converted ' + converted + ' pieces of Chinese text to Traditional Chinese (Taiwan)');
}

/* 2. The default view config, evaluated by upstream's config code against a vscode stub. */
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2 },
	window: { showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
	workspace: { getConfiguration: () => ({ get: (_s, d) => d, has: () => false, inspect: () => undefined, update: () => Promise.resolve() }) }
};
const originalLoad = Module._load;
Module._load = function (request) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};
const { getConfig } = await import(pathToFileURL(path.join(upstream, 'out/config.js')));
const { DEFAULT_REPO_STATE } = await import(pathToFileURL(path.join(upstream, 'out/extensionState.js')));

const configInstance = getConfig();
const settings = {};
for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(configInstance))) {
	if (key === 'constructor') continue;
	const value = configInstance[key];
	if (typeof value !== 'function') settings[key] = JSON.parse(JSON.stringify(value));
}
const config = { ...settings, commitOrdering: settings.commitOrder, mute: settings.muteCommits };
config.fetchAvatars = false;          // PoC: no avatar fetching
config.pullRequests.enabled = false;  // PoC: no PR provider integration

fs.mkdirSync(path.join(uiDir, 'generated'), { recursive: true });
fs.writeFileSync(path.join(uiDir, 'generated', 'bootstrap.js'),
	'// Generated by app/scripts/prepare-ui.mjs - do not edit.\n' +
	`window.__GG_DEFAULT_CONFIG = ${JSON.stringify(config)};\n` +
	`window.__GG_DEFAULT_REPO_STATE = ${JSON.stringify(DEFAULT_REPO_STATE)};\n`);
/* 3. The diff window (Monaco), from app/node_modules (npm ci in app/). */
const { buildDiff } = await import('./build-diff.mjs');
await buildDiff();

console.log('ui assets prepared in ' + uiDir);
