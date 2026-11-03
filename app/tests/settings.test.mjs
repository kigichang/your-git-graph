/* The global settings (app/ui/host/settings.js): every setting the Settings Widget changes must
 * give the configuration upstream's own configuration code gives for it (out/config.js, run
 * against a vscode stub as scripts/prepare-ui.mjs does). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Module } from 'node:module';
import { SETTINGS, UNAVAILABLE, configFrom, validateSetting } from '../ui/host/settings.js';

const upstream = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/vscode-git-graph-rs');
const compiled = path.join(upstream, 'out/config.js');

/* Upstream's configuration with one set of settings and an editor language. */
let overrides = {}, language = 'en';
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	get env() { return { language }; },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2 },
	window: { showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
	workspace: { getConfiguration: () => ({ get: (s, d) => (s in overrides ? overrides[s] : d), has: (s) => s in overrides, inspect: () => undefined, update: () => Promise.resolve() }) }
};
async function upstreamConfig() {
	const originalLoad = Module._load;
	Module._load = function (request) { return request === 'vscode' ? vscodeStub : originalLoad.apply(this, arguments); };
	const { getConfig } = await import(pathToFileURL(compiled));
	Module._load = originalLoad;
	return (settings, lang = 'en') => {
		overrides = settings; language = lang;
		const instance = getConfig(), out = {};
		for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(instance))) {
			if (key !== 'constructor' && typeof instance[key] !== 'function') out[key] = JSON.parse(JSON.stringify(instance[key]));
		}
		// The two fields the view reads under another name than the getter (as prepare-ui.mjs).
		return { ...out, commitOrdering: out.commitOrder, mute: out.muteCommits };
	};
}

const CASES = [
	['interfaceLanguage', 'zh-cn'], ['interfaceLanguage', 'en'],
	['graph.style', 'angular'], ['graph.style', 'rounded'],
	['graph.rowHeight', 30], ['graph.rowHeight', 31], ['graph.fontSize', 20],
	['date.type', 'Commit Date'], ['date.type', 'Author Date'],
	...['Date & Time', 'Date Only', 'ISO Date & Time', 'ISO Date Only', 'Relative'].map((f) => ['date.format', f]),
	['repository.commits.initialLoad', 50], ['repository.commits.loadMore', 7],
	['repository.commits.order', 'topo'], ['repository.commits.order', 'author-date'],
	['commitAuthors', [{ name: 'A B', email: 'a@x' }, { name: 'C', email: 'c@x' }]], ['commitAuthors', []],
	...['File Tree', 'File List'].map((v) => ['commitDetailsView.fileView.type', v]),
	...['Inline', 'Docked to Bottom'].map((v) => ['commitDetailsView.location', v]),
	...['Annotated', 'Lightweight'].map((v) => ['dialog.addTag.type', v]),
	...['None', 'Hyphen', 'Underscore'].map((v) => ['dialog.general.referenceInputSpaceSubstitution', v]),
	...['Soft', 'Mixed', 'Hard'].map((v) => ['dialog.resetCurrentBranchToCommit.mode', v]),
	...['Mixed', 'Hard'].map((v) => ['dialog.resetUncommittedChanges.mode', v]),
	// Every switch both ways (those the app does not offer only off: switching them on is refused).
	...Object.keys(SETTINGS).filter((k) => SETTINGS[k].valid(true)).flatMap((k) => (k in UNAVAILABLE ? [[k, false]] : [[k, true], [k, false]]))
];

test('every widget setting gives the configuration upstream gives', { skip: !fs.existsSync(compiled) && 'compile upstream first (npm run compile-src)' }, async () => {
	const configOf = await upstreamConfig();
	const defaults = configOf({});
	for (const [key, value] of CASES) {
		assert.deepEqual(configFrom(defaults, { [key]: value }).config, configOf({ [key]: value }), key + ' = ' + JSON.stringify(value));
	}
	// The app's Chinese is Traditional, "zh-tw": the view gets what upstream gives for 'zh-cn'
	// (the dictionary it names so is converted at build time).
	assert.deepEqual(configFrom(defaults, { interfaceLanguage: 'zh-tw' }).config, configOf({ interfaceLanguage: 'zh-cn' }));
	// Several at once, and "auto" following the system language.
	const many = { 'graph.style': 'angular', 'graph.rowHeight': 20, 'date.format': 'Relative', stickyHeader: false, 'repository.commits.order': 'topo' };
	assert.deepEqual(configFrom(defaults, many).config, configOf(many));
	for (const lang of ['en', 'zh-cn', 'zh-tw', 'fr']) {
		assert.deepEqual(configFrom(defaults, {}, { language: lang }).config, configOf({}, lang), 'auto with ' + lang);
	}
});

test('invalid, unknown and unavailable values are refused and ignored', () => {
	const defaults = { graph: { style: 0, rowHeight: 24, grid: { y: 24, offsetY: 12 }, fontSize: 13 }, stickyHeader: true, fetchAvatars: false, pullRequests: { enabled: false }, commitAuthors: [], interfaceLanguage: 'en', interfaceLanguageSetting: 'auto' };
	assert.equal(validateSetting('graph.style', 'angular'), null);
	assert.match(validateSetting('graph.style', 'bogus'), /must be "rounded", "angular"/);
	assert.match(validateSetting('graph.rowHeight', 100), /from 16 to 48/);
	assert.match(validateSetting('graph.rowHeight', 20.5), /whole number/);
	assert.match(validateSetting('stickyHeader', 'yes'), /true or false/);
	assert.match(validateSetting('commitAuthors', [{ name: ' ', email: 'a@x' }]), /neither empty/);
	assert.match(validateSetting('no.such', 1), /not a setting/);
	assert.match(validateSetting('interfaceLanguage', 'fr'), /"auto", "en", "zh-tw"/);
	assert.match(validateSetting('dialog.resetUncommittedChanges.mode', 'Soft'), /"Mixed", "Hard"/);
	assert.match(validateSetting('commitDetailsView.location', 'Docked'), /"Inline", "Docked to Bottom"/);
	for (const key of Object.keys(UNAVAILABLE)) {
		assert.equal(validateSetting(key, false), null);
		assert.equal(validateSetting(key, true), UNAVAILABLE[key]);
	}
	const { config, ignored } = configFrom(defaults, { 'graph.style': 'bogus', 'graph.rowHeight': 100, 'no.such': 1, 'pullRequests.enabled': true, stickyHeader: false });
	assert.deepEqual(ignored, ['graph.style', 'graph.rowHeight', 'no.such', 'pullRequests.enabled']);
	assert.equal(config.graph.style, 0);
	assert.equal(config.graph.rowHeight, 24);
	assert.equal(config.pullRequests.enabled, false);
	assert.equal(config.stickyHeader, false);
	assert.equal(defaults.stickyHeader, true, 'the defaults are not modified');
});
