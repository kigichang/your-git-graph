/* What each diff request shows (app/ui/host/diffspec.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisions, fileSides, diffSpec, workingFileSpec, fileSpec, compareSpec, WORKTREE } from '../ui/host/diffspec.js';

const C = 'c'.repeat(40), P = 'a'.repeat(40);

test('one commit is its parent against it; uncommitted is HEAD against the working tree', () => {
	assert.deepEqual(revisions(C, C), { left: C + '^', right: C });
	assert.deepEqual(revisions('*', '*'), { left: 'HEAD', right: WORKTREE });
	assert.deepEqual(revisions(P, C), { left: P, right: C });
	assert.deepEqual(revisions(P, '*'), { left: P, right: WORKTREE });
});

test('added, untracked and deleted files have one empty side; renames keep both paths', () => {
	assert.deepEqual(fileSides(C, C, 'f', 'f', 'A'), { left: null, right: { rev: C, path: 'f' } });
	assert.deepEqual(fileSides('*', '*', 'u', 'u', 'U'), { left: null, right: { rev: WORKTREE, path: 'u' } });
	assert.deepEqual(fileSides(C, C, 'f', 'f', 'D'), { left: { rev: C + '^', path: 'f' }, right: null });
	assert.deepEqual(fileSides(P, C, 'old/a.js', 'new/a.js', 'R'), { left: { rev: P, path: 'old/a.js' }, right: { rev: C, path: 'new/a.js' } });
});

test('specs and their titles', () => {
	const d = diffSpec('/r', { fromHash: C, toHash: C, oldFilePath: 'src/x.ts', newFilePath: 'src/x.ts', type: 'M' });
	assert.equal(d.mode, 'diff');
	assert.equal(d.title, 'x.ts (cccccccc^ ↔ cccccccc)');
	assert.equal(diffSpec('/r', { fromHash: C, toHash: C, oldFilePath: 'n', newFilePath: 'n', type: 'A' }).title, 'n (added ↔ cccccccc)');
	assert.equal(diffSpec('/r', { fromHash: P, toHash: C, oldFilePath: 'a/o.js', newFilePath: 'b/n.js', type: 'R' }).title, 'o.js → n.js (aaaaaaaa ↔ cccccccc)');
	assert.equal(diffSpec('/r', { fromHash: '*', toHash: '*', oldFilePath: 'm', newFilePath: 'm', type: 'M' }, true).binary, true);
	assert.equal(workingFileSpec('/r', { hash: C, filePath: 'w' }).title, 'w (cccccccc ↔ Working Tree)');
	assert.deepEqual(fileSpec('/r', { hash: C, filePath: 'd/f.md' }), { mode: 'file', repo: '/r', title: 'f.md (cccccccc)', side: { rev: C, path: 'd/f.md' } });
});

test('a comparison tab of one commit or of two', () => {
	assert.deepEqual(compareSpec('/r', { fromHash: C, toHash: C, singleCommit: true }), { mode: 'compare', repo: '/r', title: 'Compare cccccccc^ ↔ cccccccc', from: C, to: C });
	assert.deepEqual(compareSpec('/r', { fromHash: P, toHash: '*', singleCommit: false }), { mode: 'compare', repo: '/r', title: 'Compare aaaaaaaa ↔ Working Tree', from: P, to: '*' });
});
