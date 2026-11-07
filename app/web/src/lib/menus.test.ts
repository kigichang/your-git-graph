import { test, expect } from 'vitest';
import { menuFor, type MenuTarget } from './menus';
import type { Commit } from './api/client';

const commit: Commit = { hash: 'a'.repeat(40), parents: [], author: 'A', email: 'a@x', date: 0, message: 'm', heads: [], tags: [], remotes: [], stash: null };
const ctx = { hasSelection: false, remote: false, staged: false };
const ids = (target: MenuTarget, c = ctx) => menuFor(target, c).map((i) => ('separator' in i ? '-' : i.id + (i.disabled ? '!' : '')));

test('a commit offers the branch, merge and rewrite actions; HEAD can undo', () => {
	expect(ids({ kind: 'commit', commit, isHead: false })).toEqual([
		'createBranch', 'checkoutCommit', 'cherryPick', 'revert', '-', 'mergeInto', 'rebaseOnto', 'resetTo', '-', 'addTag', 'createArchive', '-',
		'dropCommit', 'editMessage', 'fixup!', 'squash!', '-', 'compare!', 'copyHash', 'copySubject'
	]);
	expect(ids({ kind: 'commit', commit, isHead: true }, { ...ctx, staged: true, hasSelection: true })).toContain('undoLastCommit');
	expect(ids({ kind: 'commit', commit, isHead: true }, { ...ctx, staged: true, hasSelection: true })).toContain('fixup');
	expect(ids({ kind: 'commit', commit, isHead: false }, { ...ctx, remote: true })).toContain('createArchive!');
});

test('branches, remote branches, tags and stashes', () => {
	expect(ids({ kind: 'branch', name: 'main', commit, current: true })).toEqual(['checkoutBranch!', 'renameBranch', 'deleteBranch!', '-', 'mergeInto!', 'rebaseOnto!', 'push', '-', 'copyName']);
	expect(ids({ kind: 'branch', name: 'x', commit, current: false })).toContain('checkoutBranch');
	expect(ids({ kind: 'remoteBranch', name: 'origin/x', remote: 'origin', commit })).toEqual(['checkoutRemoteBranch', 'fetchIntoLocal', 'pull', '-', 'mergeInto', 'rebaseOnto', 'deleteRemoteBranch', '-', 'copyName']);
	expect(ids({ kind: 'remoteBranch', name: 'gone/x', remote: null, commit })).toContain('pull!');
	expect(ids({ kind: 'tag', name: 'v1', annotated: true, commit })).toEqual(['viewTag', 'pushTag', 'deleteTag', 'createArchive', '-', 'copyName']);
	expect(ids({ kind: 'stash', selector: 'stash@{0}', commit })).toEqual(['applyStash', 'popStash', 'dropStash', 'branchFromStash', '-', 'copyName']);
});

test('the uncommitted row, a file and the background', () => {
	expect(ids({ kind: 'uncommitted', commit })).toEqual(['stash', 'cleanUntracked', 'resetUncommitted', '-', 'openTerminal', 'compare!']);
	const file = (status: 'M' | 'D' | 'U') => ({ kind: 'file' as const, change: { oldPath: 'f', newPath: 'f', status, additions: null, deletions: null } });
	expect(ids(file('M'))).toEqual(['viewFile', 'openFile', 'diffWithWorking', '-', 'resetFile', '-', 'copyPath']);
	expect(ids(file('D'))).toEqual(['viewFile!', 'openFile!', 'diffWithWorking!', '-', 'resetFile', '-', 'copyPath']);
	expect(ids(file('U'))).toContain('resetFile!');
	expect(ids(file('M'), { ...ctx, remote: true })).toContain('openFile!');
	expect(ids({ kind: 'background' })).toEqual(['refresh', 'fetch', '-', 'openTerminal', 'revealFinder']);
	expect(ids({ kind: 'background' }, { ...ctx, remote: true })).toContain('revealFinder!');
});
