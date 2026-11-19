import { test, expect } from 'vitest';
import { DEFAULT_REPO_STATE, exportRepoConfig, importRepoConfig, repoStateFrom } from './repoconfig';

test('export writes the shared fields with a timestamp', () => {
	const text = exportRepoConfig({ ...DEFAULT_REPO_STATE, hiddenRemotes: ['up'], order: 'topo', branches: ['main'] }, 1700);
	expect(JSON.parse(text)).toEqual({ version: 1, hiddenRemotes: ['up'], showRemoteBranches: true, firstParentOnly: false, order: 'topo', exportedAt: 1700 });
	expect(text.endsWith('\n')).toBe(true);
});

test('import takes a newer file, field by field, and ignores what is not for it', () => {
	const state = { ...DEFAULT_REPO_STATE, lastImportAt: 100, branches: ['x'] };
	const next = importRepoConfig(state, JSON.stringify({ version: 1, exportedAt: 200, hiddenRemotes: ['up', 3], order: 'author-date', firstParentOnly: true, showRemoteBranches: 'yes', other: 1 }), 1000);
	expect(next).toEqual({ ...state, lastImportAt: 200, hiddenRemotes: ['up'], order: 'author-date', firstParentOnly: true });
	expect(importRepoConfig(state, JSON.stringify({ version: 1, exportedAt: 100 }), 1000)).toBe(null);
	expect(importRepoConfig(state, JSON.stringify({ version: 2, exportedAt: 300 }), 1000)).toBe(null);
	expect(importRepoConfig(state, 'not json', 1000)).toBe(null);
	expect(importRepoConfig(state, '[1]', 1000)).toBe(null);
});

test('a file dated in the future or holding too much is not taken as it is', () => {
	const state = { ...DEFAULT_REPO_STATE, lastImportAt: 100 };
	// Taken, it would be "the last import" for good: no later file would ever be newer.
	expect(importRepoConfig(state, JSON.stringify({ version: 1, exportedAt: 9e15 }), 1000)).toBe(null);
	expect(importRepoConfig(state, '{"version":1,"exportedAt":1e999}', 1000)).toBe(null);
	expect(importRepoConfig(state, JSON.stringify({ version: 1, exportedAt: 1000 + 3600 }), 1000)?.lastImportAt).toBe(4600); // another machine's clock
	const many = importRepoConfig(state, JSON.stringify({ version: 1, exportedAt: 200, hiddenRemotes: [...Array.from({ length: 500 }, (_, i) => 'r' + i), 'x'.repeat(5000), ''] }), 1000);
	expect(many?.hiddenRemotes.length).toBe(100);
	expect(many?.hiddenRemotes.every((r) => r.length <= 200 && r !== '')).toBe(true);
});

test('a saved repository state is made whole', () => {
	expect(repoStateFrom(undefined)).toEqual(DEFAULT_REPO_STATE);
	expect(repoStateFrom({ order: 'topo', branches: ['a', 1], showRemoteBranches: false, lastImportAt: 'x' })).toEqual({ ...DEFAULT_REPO_STATE, order: 'topo', branches: ['a'], showRemoteBranches: false });
});
