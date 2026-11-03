/* The global settings: what the webview's Settings Widget changes (setGlobalSetting,
 * setInterfaceLanguage) and what settings.json holds, keyed like upstream's extension settings
 * relative to their section ("graph.style"). Each one validates its value and applies it to the
 * view configuration the webview runs on (GitGraphViewConfig, upstream src/types/webview.ts).
 * Pure: no window, no Tauri. tests/settings.test.mjs checks the result against upstream's own
 * configuration code. */

const bool = { valid: (v) => typeof v === 'boolean', expected: 'true or false' };
const int = (min, max) => ({ valid: (v) => Number.isInteger(v) && v >= min && v <= max, expected: `a whole number from ${min} to ${max}` });
const oneOf = (...values) => ({ valid: (v) => values.includes(v), expected: values.map((x) => JSON.stringify(x)).join(', ') });

/** A setting that sets one field of the configuration (a dotted path) to the value itself. */
const field = (type, path) => ({ ...type, apply: (c, v) => setPath(c, path, v) });

/** A setting whose named values stand for values of the configuration (enum members). */
const named = (path, values) => ({ ...oneOf(...Object.keys(values)), apply: (c, v) => setPath(c, path, values[v]) });

const DATE_FORMATS = { 'Date & Time': [0, false], 'Date Only': [1, false], 'ISO Date & Time': [0, true], 'ISO Date Only': [1, true], 'Relative': [2, false] };

/** Settings the app does not offer: they may be switched off, not on. */
export const UNAVAILABLE = {
	'repository.commits.fetchAvatars': 'Avatars are not available in the macOS app yet.',
	'pullRequests.enabled': 'Pull requests are not available in the macOS app yet.',
	'repository.trackRemoteTags': 'Tracking remote tags (a refspec added to the repository configuration) is not available in the macOS app yet.'
};

export const SETTINGS = {
	/* The app's Chinese is Traditional Chinese (Taiwan): "zh-tw". The view knows its Chinese as
	 * 'zh-cn' (scripts/prepare-ui.mjs converted that dictionary), so the configuration it gets
	 * says 'zh-cn'; a "zh-cn" left in settings.json means the same. "auto": Chinese for any
	 * Chinese system language. */
	'interfaceLanguage': {
		valid: (v) => ['auto', 'en', 'zh-tw', 'zh-cn'].includes(v),
		expected: '"auto", "en", "zh-tw"',
		apply: (c, v, env) => {
			const view = (lang) => (lang === 'en' ? 'en' : 'zh-cn');
			c.interfaceLanguageSetting = v === 'auto' ? 'auto' : view(v);
			c.interfaceLanguage = v === 'auto' ? (/^zh/i.test(env.language || '') ? 'zh-cn' : 'en') : view(v);
		}
	},
	'graph.style': { ...oneOf('rounded', 'angular'), apply: (c, v) => { c.graph.style = v === 'angular' ? 1 : 0; } },
	'graph.rowHeight': { ...int(16, 48), apply: (c, v) => {
		// The graph's grid follows the row height: rows v apart, vertices centred in them.
		c.graph.rowHeight = v;
		c.graph.grid.y = v;
		c.graph.grid.offsetY = v / 2;
	} },
	'graph.fontSize': field(int(8, 24), 'graph.fontSize'),
	'date.type': { ...oneOf('Author Date', 'Commit Date'), apply: (c, v) => { c.dateType = v === 'Commit Date' ? 1 : 0; } },
	'date.format': { ...oneOf(...Object.keys(DATE_FORMATS)), apply: (c, v) => { c.dateFormat = { type: DATE_FORMATS[v][0], iso: DATE_FORMATS[v][1] }; } },
	'referenceLabels.combineLocalAndRemoteBranchLabels': field(bool, 'referenceLabels.combineLocalAndRemoteBranchLabels'),
	'stickyHeader': field(bool, 'stickyHeader'),
	'markdown': field(bool, 'markdown'),
	'mobileAdaptation': field(bool, 'mobileAdaptation'),
	'enableLog': field(bool, 'enableLog'),
	'repository.commits.initialLoad': field(int(1, 100000), 'initialLoadCommits'),
	'repository.commits.loadMore': field(int(1, 100000), 'loadMoreCommits'),
	'repository.commits.order': { ...oneOf('date', 'author-date', 'topo'), apply: (c, v) => { c.commitOrdering = v; c.commitOrder = v; } },
	'repository.commits.loadMoreAutomatically': field(bool, 'loadMoreCommitsAutomatically'),
	'repository.commits.fetchAvatars': field(bool, 'fetchAvatars'),
	'repository.showUncommittedChanges': field(bool, 'showUncommittedChanges'),
	'repository.showUntrackedFiles': field(bool, 'showUntrackedFiles'),
	'repository.fetchAndPrune': field(bool, 'fetchAndPrune'),
	'repository.fetchAndPruneTags': field(bool, 'fetchAndPruneTags'),
	'repository.trackRemoteTags': field(bool, 'trackRemoteTags'),
	'repository.showRemoteBranches': field(bool, 'showRemoteBranches'),
	'repository.showRemoteHeads': field(bool, 'showRemoteHeads'),
	'pullRequests.enabled': field(bool, 'pullRequests.enabled'),
	/* The Commit Details View (CommitDetailsViewConfig; FileViewType and CommitDetailsViewLocation
	 * are numeric enums in upstream src/types/webview.ts). */
	'commitDetailsView.autoCenter': field(bool, 'commitDetailsView.autoCenter'),
	'commitDetailsView.fileView.fileTree.compactFolders': field(bool, 'commitDetailsView.fileTreeCompactFolders'),
	'commitDetailsView.fileView.type': named('commitDetailsView.fileViewType', { 'File Tree': 1, 'File List': 2 }),
	'commitDetailsView.location': named('commitDetailsView.location', { 'Inline': 0, 'Docked to Bottom': 1 }),
	/* What the dialogs start with (DialogDefaults). Left out: dialog.merge.squashMessageFormat and
	 * dialog.pullBranch.squashMessageFormat - the host's, not the view's, and the app always commits
	 * a squash with git's own message (.git/SQUASH_MSG; gitops.js commitSquashed). */
	'dialog.addTag.pushToRemote': field(bool, 'dialogDefaults.addTag.pushToRemote'),
	'dialog.addTag.type': named('dialogDefaults.addTag.type', { 'Annotated': 0, 'Lightweight': 1 }),
	'dialog.applyStash.reinstateIndex': field(bool, 'dialogDefaults.applyStash.reinstateIndex'),
	'dialog.cherryPick.noCommit': field(bool, 'dialogDefaults.cherryPick.noCommit'),
	'dialog.cherryPick.recordOrigin': field(bool, 'dialogDefaults.cherryPick.recordOrigin'),
	'dialog.createBranch.checkOut': field(bool, 'dialogDefaults.createBranch.checkout'),
	'dialog.deleteBranch.forceDelete': field(bool, 'dialogDefaults.deleteBranch.forceDelete'),
	'dialog.fetchIntoLocalBranch.forceFetch': field(bool, 'dialogDefaults.fetchIntoLocalBranch.forceFetch'),
	'dialog.fetchRemote.prune': field(bool, 'dialogDefaults.fetchRemote.prune'),
	'dialog.fetchRemote.pruneTags': field(bool, 'dialogDefaults.fetchRemote.pruneTags'),
	'dialog.general.referenceInputSpaceSubstitution': named('dialogDefaults.general.referenceInputSpaceSubstitution', { 'None': null, 'Hyphen': '-', 'Underscore': '_' }),
	'dialog.merge.noCommit': field(bool, 'dialogDefaults.merge.noCommit'),
	'dialog.merge.noFastForward': field(bool, 'dialogDefaults.merge.noFastForward'),
	'dialog.merge.squashCommits': field(bool, 'dialogDefaults.merge.squash'),
	'dialog.popStash.reinstateIndex': field(bool, 'dialogDefaults.popStash.reinstateIndex'),
	'dialog.pullBranch.noFastForward': field(bool, 'dialogDefaults.pullBranch.noFastForward'),
	'dialog.pullBranch.squashCommits': field(bool, 'dialogDefaults.pullBranch.squash'),
	'dialog.rebase.ignoreDate': field(bool, 'dialogDefaults.rebase.ignoreDate'),
	'dialog.rebase.launchInteractiveRebase': field(bool, 'dialogDefaults.rebase.interactive'),
	'dialog.rebase.autosquash': field(bool, 'dialogDefaults.rebase.autosquash'),
	'dialog.resetCurrentBranchToCommit.mode': named('dialogDefaults.resetCommit.mode', { 'Soft': 'soft', 'Mixed': 'mixed', 'Hard': 'hard' }),
	'dialog.resetUncommittedChanges.mode': named('dialogDefaults.resetUncommitted.mode', { 'Mixed': 'mixed', 'Hard': 'hard' }),
	'dialog.stashUncommittedChanges.includeUntracked': field(bool, 'dialogDefaults.stashUncommittedChanges.includeUntracked'),
	'commitAuthors': {
		valid: (v) => Array.isArray(v) && v.every(isAuthor),
		expected: 'a list of { "name", "email" }, neither empty',
		apply: (c, v) => { c.commitAuthors = v.map((a) => ({ name: a.name.trim(), email: a.email.trim() })); }
	}
};

function isAuthor(a) {
	return a !== null && typeof a === 'object' && typeof a.name === 'string' && typeof a.email === 'string'
		&& a.name.trim() !== '' && a.email.trim() !== '';
}

function setPath(obj, path, value) {
	const keys = path.split('.');
	const last = keys.pop();
	for (const k of keys) obj = obj[k];
	obj[last] = value;
}

/** Why `value` cannot be saved as `key`, or null when it can. */
export function validateSetting(key, value) {
	const setting = SETTINGS[key];
	if (setting === undefined) return `"${key}" is not a setting the macOS app knows.`;
	if (!setting.valid(value)) return `"${key}" must be ${setting.expected}.`;
	if (value === true && key in UNAVAILABLE) return UNAVAILABLE[key];
	return null;
}

/** The view configuration: `defaults` with every valid entry of `settings` applied.
 * env: { language } (the system's, for "interfaceLanguage": "auto").
 * Returns { config, ignored: [keys that are unknown, invalid or unavailable] }. */
export function configFrom(defaults, settings, env = {}) {
	const config = structuredClone(defaults);
	const ignored = [];
	SETTINGS.interfaceLanguage.apply(config, 'auto', env); // "auto" is the default, resolved here
	for (const [key, value] of Object.entries(settings || {})) {
		if (validateSetting(key, value) !== null) { ignored.push(key); continue; }
		SETTINGS[key].apply(config, value, env);
	}
	return { config, ignored };
}
