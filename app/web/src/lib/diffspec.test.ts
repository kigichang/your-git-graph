/* What each diff window shows (diffspec.ts). */
import { test, expect } from 'vitest';
import { revisions, fileSides, diffSpec, workingFileSpec, fileSpec, compareSpec, WORKTREE } from './diffspec';

const C = 'c'.repeat(40), P = 'a'.repeat(40);

test('one commit is its parent against it; uncommitted is HEAD against the working tree', () => {
	expect(revisions(C, C)).toEqual({ left: C + '^', right: C });
	expect(revisions('*', '*')).toEqual({ left: 'HEAD', right: WORKTREE });
	expect(revisions(P, C)).toEqual({ left: P, right: C });
	expect(revisions(P, '*')).toEqual({ left: P, right: WORKTREE });
});

test('added, untracked and deleted files have one empty side; renames keep both paths', () => {
	expect(fileSides(C, C, 'f', 'f', 'A')).toEqual({ left: null, right: { rev: C, path: 'f' } });
	expect(fileSides('*', '*', 'u', 'u', 'U')).toEqual({ left: null, right: { rev: WORKTREE, path: 'u' } });
	expect(fileSides(C, C, 'f', 'f', 'D')).toEqual({ left: { rev: C + '^', path: 'f' }, right: null });
	expect(fileSides(P, C, 'old/a.js', 'new/a.js', 'R')).toEqual({ left: { rev: P, path: 'old/a.js' }, right: { rev: C, path: 'new/a.js' } });
});

test('specs and their titles', () => {
	const d = diffSpec('/r', C, C, 'src/x.ts', 'src/x.ts', 'M');
	expect(d.mode).toBe('diff');
	expect(d.title).toBe('x.ts (cccccccc^ ↔ cccccccc)');
	expect(diffSpec('/r', C, C, 'n', 'n', 'A').title).toBe('n (added ↔ cccccccc)');
	expect(diffSpec('/r', P, C, 'a/o.js', 'b/n.js', 'R').title).toBe('o.js → n.js (aaaaaaaa ↔ cccccccc)');
	const binary = diffSpec('/r', '*', '*', 'm', 'm', 'M', true);
	expect(binary.mode === 'diff' && binary.binary).toBe(true);
	expect(workingFileSpec('/r', C, 'w').title).toBe('w (cccccccc ↔ Working Tree)');
	expect(fileSpec('/r', C, 'd/f.md')).toEqual({ mode: 'file', repo: '/r', title: 'f.md (cccccccc)', side: { rev: C, path: 'd/f.md' } });
	expect(fileSpec('/r', WORKTREE, 'u')).toEqual({ mode: 'file', repo: '/r', title: 'u (Working Tree)', side: { rev: WORKTREE, path: 'u' } });
});

test('a comparison of one commit or of two', () => {
	expect(compareSpec('/r', C, C)).toEqual({ mode: 'compare', repo: '/r', title: 'Compare cccccccc^ ↔ cccccccc', from: C, to: C });
	expect(compareSpec('/r', P, '*')).toEqual({ mode: 'compare', repo: '/r', title: 'Compare aaaaaaaa ↔ Working Tree', from: P, to: '*' });
});
