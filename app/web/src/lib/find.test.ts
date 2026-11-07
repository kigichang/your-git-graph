import { test, expect } from 'vitest';
import { findRows, matcherFor, stepMatch } from './find';
import type { Commit } from './api/client';

const c = (message: string, extra: Partial<Commit> = {}): Commit => ({ hash: 'a'.repeat(40), parents: [], author: 'Ann', email: 'ann@x', date: 0, message, heads: [], tags: [], remotes: [], stash: null, ...extra });
const commits = [c('Fix the build'), c('fix typo', { author: 'Bo', hash: 'b'.repeat(40) }), c('Release', { tags: [{ name: 'v1.0', annotated: true }], heads: ['main'] })];

test('text matches case-insensitively unless asked; labels and hashes count', () => {
	expect(findRows(commits, 'fix', { caseSensitive: false, regex: false })).toEqual([0, 1]);
	expect(findRows(commits, 'Fix', { caseSensitive: true, regex: false })).toEqual([0]);
	expect(findRows(commits, 'bo', { caseSensitive: false, regex: false })).toEqual([1]);
	expect(findRows(commits, 'v1.0', { caseSensitive: false, regex: false })).toEqual([2]);
	expect(findRows(commits, 'bbbbbbbb', { caseSensitive: false, regex: false })).toEqual([1]);
	expect(findRows(commits, '', { caseSensitive: false, regex: false })).toEqual([]);
});

test('regular expressions, and an invalid one matches nothing', () => {
	expect(findRows(commits, '^fix', { caseSensitive: false, regex: true })).toEqual([0, 1]);
	expect(findRows(commits, 'v1\\.0|main', { caseSensitive: false, regex: true })).toEqual([2]);
	expect(matcherFor('(', { caseSensitive: false, regex: true })).toBe(null);
	expect(findRows(commits, '(', { caseSensitive: false, regex: false })).toEqual([]);
});

test('stepping through the matches from the selected row wraps around', () => {
	const rows = [2, 5, 9];
	expect(stepMatch(rows, -1, true)).toBe(0);
	expect(stepMatch(rows, 2, true)).toBe(1);
	expect(stepMatch(rows, 9, true)).toBe(0);
	expect(stepMatch(rows, 5, false)).toBe(0);
	expect(stepMatch(rows, 2, false)).toBe(2);
	expect(stepMatch([], 0, true)).toBe(-1);
});
