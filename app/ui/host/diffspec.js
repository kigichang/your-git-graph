/* What a diff window shows, from the webview's requests (pure; tested in app/tests/).
 *
 * A side is { rev, path }: rev is a revision the engine resolves (a hash, `<hash>^`, `HEAD`) or
 * WORKTREE for the file on disk; a missing side (null) is an empty file - added/deleted files.
 * The window (app/diff/main.js) receives one of:
 *   { mode: 'diff',    repo, title, left, right, binary }
 *   { mode: 'file',    repo, title, side }
 *   { mode: 'compare', repo, title, from, to }   (a file list; each entry becomes a 'diff')
 *
 * The webview's convention (upstream web/commitDetailsView.ts): fromHash === toHash means
 * "that one commit", i.e. its parent against it; '*' is the uncommitted state (HEAD against
 * the working tree). */

export const UNCOMMITTED = '*';
export const WORKTREE = '*';

const short = (rev) => (rev === WORKTREE ? 'Working Tree' : /^[0-9a-f]{40}$/i.test(rev) ? rev.slice(0, 8) : rev.replace(/^([0-9a-f]{40})\^$/i, (_, h) => h.slice(0, 8) + '^'));
const basename = (path) => path.split('/').pop();

/** The two revisions a change between `fromHash` and `toHash` is shown with. */
export function revisions(fromHash, toHash) {
	if (fromHash === toHash) {
		return toHash === UNCOMMITTED ? { left: 'HEAD', right: WORKTREE } : { left: toHash + '^', right: toHash };
	}
	return { left: fromHash, right: toHash };
}

/** The two sides of one file's change; `type` is its GitFileStatus (A, M, D, R, U). */
export function fileSides(fromHash, toHash, oldFilePath, newFilePath, type) {
	const { left, right } = revisions(fromHash, toHash);
	return {
		left: type === 'A' || type === 'U' ? null : { rev: left, path: oldFilePath },
		right: type === 'D' ? null : { rev: right, path: newFilePath }
	};
}

function diffTitle(left, right) {
	const side = left ?? right;
	const name = left !== null && right !== null && left.path !== right.path ? basename(left.path) + ' → ' + basename(right.path) : basename(side.path);
	return name + ' (' + (left ? short(left.rev) : 'added') + ' ↔ ' + (right ? short(right.rev) : 'deleted') + ')';
}

/** viewDiff / viewDiffBinary. */
export function diffSpec(repo, m, binary = false) {
	const { left, right } = fileSides(m.fromHash, m.toHash, m.oldFilePath, m.newFilePath, m.type);
	return { mode: 'diff', repo, title: diffTitle(left, right), left, right, binary };
}

/** viewDiffWithWorkingFile: the file at `hash` against the working tree. */
export function workingFileSpec(repo, m) {
	const left = { rev: m.hash, path: m.filePath }, right = { rev: WORKTREE, path: m.filePath };
	return { mode: 'diff', repo, title: diffTitle(left, right), left, right, binary: false };
}

/** viewFileAtRevision. */
export function fileSpec(repo, m) {
	return { mode: 'file', repo, title: basename(m.filePath) + ' (' + short(m.hash) + ')', side: { rev: m.hash, path: m.filePath } };
}

/** openCompareTab: every changed file between two revisions (or of one commit). */
export function compareSpec(repo, m) {
	const single = m.singleCommit || m.fromHash === m.toHash;
	const from = single ? m.toHash : m.fromHash;
	const { left, right } = revisions(from, m.toHash);
	return { mode: 'compare', repo, title: 'Compare ' + short(left) + ' ↔ ' + short(right), from, to: m.toHash };
}
