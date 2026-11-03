/* The exported repository configuration (app/ui/host/repoconfig.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportRepoConfig, importRepoConfig } from '../ui/host/repoconfig.js';

const STATE = {
	pinnedBranches: ['mine'], pinnedCommits: [], cdvDivider: 0.5, cdvHeight: 250, columnWidths: [10, 20],
	commitOrdering: 'topo', fileViewType: 1, gerritFetchRefs: false, gerritFetchLimit: null, gerritStatusFilter: 0,
	hideRemotes: ['upstream'], includeCommitsMentionedByReflogs: 0, issueLinkingConfig: null, lastImportAt: 0,
	name: 'Shared', onlyFollowFirstParent: 1, onRepoLoadShowCheckedOutBranch: 2, onRepoLoadShowSpecificBranches: null,
	pullRequestConfig: null, showRemoteBranches: true, showRemoteBranchesV2: 2, showStashes: 0, showTags: 1, workspaceFolderIndex: null
};

test('only the shared parts of the state are exported, with the global issue linking as a fallback', () => {
	const issue = { issue: '#(\\d+)', url: 'https://example.com/$1' };
	const file = JSON.parse(exportRepoConfig(STATE, issue, 1234));
	assert.deepEqual(Object.keys(file).sort(), ['commitOrdering', 'exportedAt', 'fileViewType', 'hideRemotes', 'includeCommitsMentionedByReflogs',
		'issueLinkingConfig', 'name', 'onRepoLoadShowCheckedOutBranch', 'onRepoLoadShowSpecificBranches', 'onlyFollowFirstParent',
		'pullRequestConfig', 'showRemoteBranchesV2', 'showStashes', 'showTags']);
	assert.equal(file.exportedAt, 1234);
	assert.deepEqual(file.issueLinkingConfig, issue);
	const own = { issue: 'X-(\\d+)', url: 'https://x/$1' };
	assert.deepEqual(JSON.parse(exportRepoConfig({ ...STATE, issueLinkingConfig: own }, issue)).issueLinkingConfig, own, "the repository's own wins");
});

test('a newer export is merged in once; older, invalid and personal fields are not', () => {
	const exported = exportRepoConfig(STATE, null, 5000);
	const fresh = { ...STATE, commitOrdering: 'default', name: null, hideRemotes: [], pinnedBranches: [], lastImportAt: 0 };
	const merged = importRepoConfig(fresh, exported);
	assert.equal(merged.lastImportAt, 5000);
	assert.equal(merged.commitOrdering, 'topo');
	assert.equal(merged.name, 'Shared');
	assert.deepEqual(merged.hideRemotes, ['upstream']);
	assert.deepEqual(merged.pinnedBranches, [], 'personal state is untouched');
	assert.equal(importRepoConfig(merged, exported), null, 'already imported');

	const tampered = JSON.stringify({ exportedAt: 6000, commitOrdering: 'sideways', hideRemotes: 'all', pinnedBranches: ['x'], showTags: 2 });
	const partly = importRepoConfig(merged, tampered);
	assert.equal(partly.commitOrdering, 'topo');
	assert.deepEqual(partly.hideRemotes, ['upstream']);
	assert.deepEqual(partly.pinnedBranches, []);
	assert.equal(partly.showTags, 2);
	for (const bad of [undefined, '', '{', 'null', '[]', '{"commitOrdering":"topo"}']) assert.equal(importRepoConfig(fresh, bad), null, String(bad));
});
