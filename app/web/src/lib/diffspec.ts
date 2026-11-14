/* What a diff window shows (pure; tested in diffspec.test.ts).
 *
 * A side is { rev, path }: rev is a revision the engine resolves (a hash, `<hash>^`, `HEAD`) or
 * WORKTREE for the file on disk; a missing side (null) is an empty file - added/deleted files.
 * The window (app/diff/main.js, handed the spec as window.__GG_DIFF_SPEC) receives one of:
 *   { mode: 'diff',    repo, title, left, right, binary }
 *   { mode: 'file',    repo, title, side }
 *   { mode: 'compare', repo, title, from, to }   (a file list; each entry becomes a 'diff')
 *
 * A change is named by two revisions: `from === to` means "that one commit" (its parent against
 * it); UNCOMMITTED names the uncommitted state (HEAD against the working tree). */

import { baseName, shortHash } from './names';

export const UNCOMMITTED = '*';
export const WORKTREE = '*';

export type Side = { rev: string; path: string };
/** The engine's status of a file change: added, modified, deleted, renamed, untracked. */
export type ChangeType = 'A' | 'M' | 'D' | 'R' | 'U';
export type DiffSpec =
	| { mode: 'diff'; repo: string; title: string; left: Side | null; right: Side | null; binary: boolean }
	| { mode: 'file'; repo: string; title: string; side: Side }
	| { mode: 'compare'; repo: string; title: string; from: string; to: string };

const short = (rev: string): string =>
	rev === WORKTREE ? 'Working Tree' : /^[0-9a-f]{40}$/i.test(rev) ? shortHash(rev) : rev.replace(/^([0-9a-f]{40})\^$/i, (_, h: string) => shortHash(h) + '^');

/** The two revisions a change between `from` and `to` is shown with. */
export function revisions(from: string, to: string): { left: string; right: string } {
	if (from === to) {
		return to === UNCOMMITTED ? { left: 'HEAD', right: WORKTREE } : { left: to + '^', right: to };
	}
	return { left: from, right: to };
}

/** The two sides of one file's change. */
export function fileSides(from: string, to: string, oldPath: string, newPath: string, type: ChangeType): { left: Side | null; right: Side | null } {
	const { left, right } = revisions(from, to);
	return {
		left: type === 'A' || type === 'U' ? null : { rev: left, path: oldPath },
		right: type === 'D' ? null : { rev: right, path: newPath }
	};
}

function diffTitle(left: Side | null, right: Side | null): string {
	const side = (left ?? right) as Side;
	const name = left !== null && right !== null && left.path !== right.path ? baseName(left.path) + ' → ' + baseName(right.path) : baseName(side.path);
	return name + ' (' + (left ? short(left.rev) : 'added') + ' ↔ ' + (right ? short(right.rev) : 'deleted') + ')';
}

/** One file's change between two revisions (or within one commit). */
export function diffSpec(repo: string, from: string, to: string, oldPath: string, newPath: string, type: ChangeType, binary = false): DiffSpec {
	const { left, right } = fileSides(from, to, oldPath, newPath, type);
	return { mode: 'diff', repo, title: diffTitle(left, right), left, right, binary };
}

/** The file at `rev` against the working tree. */
export function workingFileSpec(repo: string, rev: string, path: string): DiffSpec {
	const left = { rev, path }, right = { rev: WORKTREE, path };
	return { mode: 'diff', repo, title: diffTitle(left, right), left, right, binary: false };
}

/** The file as it is at `rev` (WORKTREE: on disk). */
export function fileSpec(repo: string, rev: string, path: string): DiffSpec {
	return { mode: 'file', repo, title: baseName(path) + ' (' + short(rev) + ')', side: { rev, path } };
}

/** Every changed file between two revisions, or of one commit (`from === to`). */
export function compareSpec(repo: string, from: string, to: string): DiffSpec {
	const { left, right } = revisions(from, to);
	return { mode: 'compare', repo, title: 'Compare ' + short(left) + ' ↔ ' + short(right), from, to };
}
