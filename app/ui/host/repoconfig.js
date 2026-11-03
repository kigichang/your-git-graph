/* The exported repository configuration (Settings Widget > Export Repository Configuration):
 * the parts of a repository's state that make sense for everyone working in it, written to
 * .vscode/vscode-git-graph.json so it can be committed. A newer export than the one last
 * imported is merged into the repository's state when a window opens it.
 * Personal state (pinned commits, column widths, the panel layout) is never exported.
 * Pure: no window, no Tauri. Repository state fields: upstream src/types/repoState.ts. */

const isBoolOverride = (v) => v === 0 || v === 1 || v === 2; // BooleanOverride: default / enabled / disabled
const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isObjectOrNull = (v) => v === null || (typeof v === 'object' && !Array.isArray(v));

/** The shared fields and what a valid value of each looks like. */
const FIELDS = {
	commitOrdering: (v) => ['default', 'date', 'author-date', 'topo'].includes(v),
	fileViewType: (v) => v === 0 || v === 1 || v === 2,
	hideRemotes: isStringList,
	includeCommitsMentionedByReflogs: isBoolOverride,
	issueLinkingConfig: (v) => v === null || (isObjectOrNull(v) && typeof v.issue === 'string' && typeof v.url === 'string'),
	name: (v) => v === null || typeof v === 'string',
	onlyFollowFirstParent: isBoolOverride,
	onRepoLoadShowCheckedOutBranch: isBoolOverride,
	onRepoLoadShowSpecificBranches: (v) => v === null || isStringList(v),
	pullRequestConfig: isObjectOrNull,
	showRemoteBranchesV2: isBoolOverride,
	showStashes: isBoolOverride,
	showTags: isBoolOverride
};

/** The file's contents for `repoState`. `globalIssueLinking`: the global issue linking
 * configuration, exported when the repository has none of its own (it applies there too). */
export function exportRepoConfig(repoState, globalIssueLinking, now = Date.now()) {
	const out = {};
	for (const key of Object.keys(FIELDS)) {
		if (key in repoState) out[key] = repoState[key];
	}
	if (out.issueLinkingConfig === null && globalIssueLinking) out.issueLinkingConfig = globalIssueLinking;
	out.exportedAt = now;
	return JSON.stringify(out, null, 4) + '\n';
}

/** `repoState` with the exported configuration `text` merged in, or null when there is nothing
 * new to import (no file, not newer than the last import, not a configuration). Fields with
 * invalid values are left as they are. */
export function importRepoConfig(repoState, text) {
	if (typeof text !== 'string') return null;
	let file;
	try { file = JSON.parse(text); } catch (_) { return null; }
	if (!isObjectOrNull(file) || file === null || !Number.isFinite(file.exportedAt)) return null;
	if (file.exportedAt <= (repoState.lastImportAt || 0)) return null;
	const next = { ...repoState, lastImportAt: file.exportedAt };
	for (const [key, valid] of Object.entries(FIELDS)) {
		if (key in file && valid(file[key])) next[key] = file[key];
	}
	return next;
}
