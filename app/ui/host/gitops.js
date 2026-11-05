/* The webview requests served by the git CLI: every write, plus the reads the engine does not
 * offer (reflog, worktrees, conflict prediction, the repository config).
 *
 * Each handler is `(ctx, msg) => response`, where the message and response shapes are the
 * protocol of upstream src/types/messages.ts. The git arguments are this project's own.
 *
 * Pure module - no window, no Tauri - so app/tests/ runs it in Node against real git:
 *   ctx.repo                       the repository root
 *   ctx.git(args, opts)            → { exitCode, stdout, stderr, timedOut, cancelled, durationMs }
 *   ctx.engine(method, params)     the Rust engine (loadConfig only)
 *   ctx.terminal(gitArgs)          run `git <gitArgs>` in Terminal (interactive rebase)
 *   ctx.saveDialog(defaultName)    → chosen path | null (archive)
 *   ctx.operationMarker()          → { type, progress } from the git directory (Rust: repo.rs)
 */

export const UNCOMMITTED = '*';
export const TagType = Object.freeze({ Annotated: 0, Lightweight: 1 });
export const PUSH_TAG_COMMIT_NOT_ON_REMOTE = 'VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:';

/* ---------- Running git ---------- */

/** The error text of a finished run, or null when it succeeded. */
export function errorOf(result) {
	if (result.exitCode === 0) return null;
	if (result.timedOut) return 'Git timed out.';
	if (result.cancelled) return 'Git was cancelled.';
	return result.stderr.trim() || result.stdout.trim() || 'Git exited with code ' + result.exitCode + '.';
}

/** Every run accepts its editor non-interactively: there is no terminal to edit in. Commands
 * that would open one (rebase --continue, commit --squash, merge --no-ff) take the default text.
 * GIT_OPTIONAL_LOCKS=0: no opportunistic index refresh (`git diff` would rewrite the index,
 * which the file watcher would report, which would refresh the view, which runs `git diff`...). */
function exec(ctx, args, opts = {}) {
	return ctx.git(args, { ...opts, env: { GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0', ...(opts.env || {}) } });
}

/** The handlers below that only read: they do not change the repository. */
export const READ_COMMANDS = new Set(['loadConfig', 'reflog', 'worktreeList', 'predictConflicts']);

async function run(ctx, args, opts) {
	return errorOf(await exec(ctx, args, opts));
}

/** Run each command in turn, stopping at the first failure. */
async function runAll(ctx, argLists) {
	for (const args of argLists) {
		const error = await run(ctx, args);
		if (error !== null) return error;
	}
	return null;
}

/** Values from the webview land in git's argv: one starting with "-" would be read as an option
 * (`--upload-pack=…`, `-oProxyCommand=…`). Refuse them instead of passing them on. */
function unsafe(...values) {
	const bad = values.find((v) => typeof v === 'string' && v.startsWith('-'));
	return bad === undefined ? null : 'Invalid argument "' + bad + '": it must not start with "-".';
}

const flag = (on, ...args) => (on ? args : []);

/** `git config --unset-all` exits 5 when the key is absent - already the wanted state. */
async function unsetConfig(ctx, location, key) {
	const result = await exec(ctx, ['config', '--' + location, '--unset-all', key]);
	return result.exitCode === 5 ? null : errorOf(result);
}

/** The global author ({ name, email }), or null when either is unset. */
async function globalAuthor(ctx) {
	const [name, email] = await Promise.all(['user.name', 'user.email'].map((key) => exec(ctx, ['config', '--global', '--get', key])));
	return name.exitCode === 0 && email.exitCode === 0 && name.stdout.trim() !== '' && email.stdout.trim() !== ''
		? { name: name.stdout.trim(), email: email.stdout.trim() } : null;
}

/** Saving the author identities (the commitAuthors setting, from `previous` to `next`) keeps
 * the global author one of them, as the Settings Widget presents it (by default the first):
 * - no global author yet: the first identity becomes it;
 * - the global author was one of `previous` and was edited (same position, same count): it
 *   follows the edit; deleted: the first identity takes over, or with none left it is unset;
 * - a global author that never was one of the identities is the user's own: left alone.
 * Returns { touched: whether the global configuration was written, error }. */
export async function syncGlobalAuthor(ctx, previous, next) {
	const same = (a, b) => a.name === b.name && a.email === b.email;
	const current = await globalAuthor(ctx);
	let target; // an identity to set, null to unset, undefined to leave as is
	if (current === null) {
		target = next.length > 0 ? next[0] : undefined;
	} else if (next.some((a) => same(a, current))) {
		target = undefined;
	} else {
		const was = previous.findIndex((a) => same(a, current));
		if (was < 0) target = undefined;
		else if (next.length === 0) target = null;
		else target = next.length === previous.length ? next[was] : next[0];
	}
	if (target === undefined) return { touched: false, error: null };
	const error = target === null
		? (await unsetConfig(ctx, 'global', 'user.name')) || (await unsetConfig(ctx, 'global', 'user.email'))
		: await runAll(ctx, [['config', '--global', 'user.name', target.name], ['config', '--global', 'user.email', target.email]]);
	return { touched: true, error };
}

/** After `--squash` (merge or pull) git stages the result without committing: commit it with
 * the message git prepared, unless nothing was staged (already up to date). */
async function commitSquashed(ctx) {
	const staged = await exec(ctx, ['diff', '--cached', '--quiet']);
	if (staged.exitCode === 0) return null;
	return run(ctx, ['commit', '--no-edit']);
}

function pullArgs(remote, branchName, createNewCommit, squash) {
	return ['pull', ...flag(squash, '--squash'), ...flag(!squash && createNewCommit, '--no-ff'), remote, branchName];
}

async function pull(ctx, remote, branchName, createNewCommit, squash) {
	const error = unsafe(remote, branchName) ?? await run(ctx, pullArgs(remote, branchName, createNewCommit, squash));
	return error === null && squash ? commitSquashed(ctx) : error;
}

/** The given remotes that have no remote-tracking branch containing `commitHash`. */
async function remotesWithoutCommit(ctx, commitHash, remotes) {
	const result = await exec(ctx, ['branch', '--remotes', '--contains', commitHash, '--format=%(refname)']);
	const refs = result.exitCode === 0 ? result.stdout.split('\n').filter((l) => l !== '') : [];
	return remotes.filter((remote) => !refs.some((ref) => ref.startsWith('refs/remotes/' + remote + '/')));
}

/** `git remote set-url` matches the old URL as a regular expression. */
const regexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function setUrlArgs(name, oldUrl, newUrl, push) {
	const p = flag(push, '--push');
	if (newUrl === null) return ['remote', 'set-url', ...p, '--delete', name, regexEscape(oldUrl)];
	if (oldUrl === null) return ['remote', 'set-url', ...p, '--add', name, newUrl];
	return ['remote', 'set-url', ...p, name, newUrl, regexEscape(oldUrl)];
}

/* ---------- History rewriting ---------- */

/** Rewrite the current branch from `commitHash` onwards with a rebase whose todo list is
 * written by `makeTodo(commits)` (oldest first; commits[0] is `commitHash`). The todo is passed
 * to git through the environment (GG_TODO) and written by the sequence editor. Merge commits
 * in the range are refused: replaying them would flatten the history. */
async function rewriteFrom(ctx, commitHash, makeTodo, env = {}) {
	if (unsafe(commitHash) !== null) return unsafe(commitHash);
	if ((await exec(ctx, ['merge-base', '--is-ancestor', commitHash, 'HEAD'])).exitCode !== 0) {
		return 'The commit is not on the checked-out branch.';
	}
	const merges = await exec(ctx, ['rev-list', '--merges', commitHash + '..HEAD']);
	if (merges.stdout.trim() !== '') return 'The branch has merge commits after this commit; rewriting it would flatten them.';
	const parents = await exec(ctx, ['rev-list', '--parents', '-n', '1', commitHash]);
	const isRoot = parents.stdout.trim().split(' ').length === 1;
	const range = await exec(ctx, ['rev-list', '--reverse', isRoot ? 'HEAD' : commitHash + '^..HEAD']);
	if (range.exitCode !== 0) return errorOf(range);
	const commits = range.stdout.split('\n').filter((l) => l !== '');
	const todo = makeTodo(commits);
	return run(ctx, ['rebase', '-i', '--autostash', ...(isRoot ? ['--root'] : [commitHash + '^'])], {
		env: {
			...env,
			GG_TODO: todo.length > 0 ? todo.join('\n') : 'noop',
			GIT_SEQUENCE_EDITOR: 'sh -c \'printf "%s\\n" "$GG_TODO" > "$1"\' gg'
		}
	});
}

async function headHash(ctx) {
	const result = await exec(ctx, ['rev-parse', 'HEAD']);
	return result.exitCode === 0 ? result.stdout.trim() : null;
}

/* ---------- Reads ---------- */

/** GitOperationState for loadRepoInfo: what is in progress, and which files conflict. */
export async function readOperationState(ctx) {
	const marker = await ctx.operationMarker();
	if (marker.type === null) return { type: null, conflictedFiles: [], progress: null };
	const result = await exec(ctx, ['diff', '--name-only', '--diff-filter=U', '-z']);
	const conflictedFiles = result.exitCode === 0 ? [...new Set(result.stdout.split('\0').filter((f) => f !== ''))] : [];
	return { type: marker.type, conflictedFiles, progress: marker.progress };
}

/** `git config --list -z` → [key, value] pairs in file order (an absent file → none). */
async function configEntries(ctx, location) {
	const result = await exec(ctx, ['config', '--' + location, '--list', '-z']);
	if (result.exitCode !== 0) return [];
	return result.stdout.split('\0').filter((e) => e !== '').map((entry) => {
		const nl = entry.indexOf('\n');
		return nl < 0 ? [entry, ''] : [entry.slice(0, nl), entry.slice(nl + 1)];
	});
}

/** GitRepoConfig: the local and global config files, plus the authors of the history. */
export async function readRepoConfig(ctx) {
	const [local, global] = await Promise.all([configEntries(ctx, 'local'), configEntries(ctx, 'global')]);
	const lastOf = (entries, key) => {
		let value = null;
		for (const [k, v] of entries) if (k.toLowerCase() === key) value = v;
		return value;
	};
	const effective = (key) => lastOf(local, key) ?? lastOf(global, key);

	const remotes = new Map(), branches = {};
	for (const [key, value] of local) {
		let m = /^remote\.(.+)\.(url|pushurl)$/i.exec(key);
		if (m) {
			if (!remotes.has(m[1])) remotes.set(m[1], { name: m[1], url: null, pushUrl: null });
			remotes.get(m[1])[m[2].toLowerCase() === 'url' ? 'url' : 'pushUrl'] = value;
			continue;
		}
		m = /^branch\.(.+)\.(remote|pushremote)$/i.exec(key);
		if (m) {
			if (!branches[m[1]]) branches[m[1]] = { remote: null, pushRemote: null };
			branches[m[1]][m[2].toLowerCase() === 'remote' ? 'remote' : 'pushRemote'] = value;
		}
	}
	let authors = [];
	try {
		authors = await ctx.engine('authors');
	} catch (_) { /* an empty repository has no authors */ }
	return {
		branches,
		authors,
		diffTool: effective('diff.tool'),
		guiDiffTool: effective('diff.guitool'),
		pushDefault: effective('remote.pushdefault'),
		remotes: [...remotes.values()],
		user: {
			name: { local: lastOf(local, 'user.name'), global: lastOf(global, 'user.name') },
			email: { local: lastOf(local, 'user.email'), global: lastOf(global, 'user.email') }
		}
	};
}

/* ---------- Data-loss warnings ---------- */

/* Six actions can leave work where it is hard to find again. Unless the request is `confirmed`
 * (the user saw the warning and insisted), the handler checks first and answers
 * { command: 'lossWarning', message, retry } instead of running: the view shows its warning
 * dialog and re-sends `retry` (the request with confirmed set). What counts, from git's side:
 * - commits that end up on no branch, tag or remote-tracking branch (leaving a detached HEAD,
 *   resetting a branch back, force-moving a branch) - recoverable only through the reflog;
 * - uncommitted changes to tracked files (a hard reset);
 * - commits a force push removes from a remote branch.
 * The message is HTML in the view (web/dialog.ts showDataLossWarning): names are escaped. */

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const commits = (n, lang) => (lang === 'zh-cn' ? n + ' 個提交' : n + ' commit' + (n === 1 ? '' : 's'));
const LOSS = {
	en: {
		detached: (n) => `HEAD is detached on ${commits(n, 'en')} that no branch or tag contains. After this they can only be found through the reflog.`,
		resetCommits: (n, branch) => `${commits(n, 'en')} on <b>${branch}</b> will be on no branch or tag after the reset.`,
		uncommitted: (n) => `${n} uncommitted change${n === 1 ? '' : 's'} to tracked files will be discarded.`,
		moveBranch: (n, branch) => `${commits(n, 'en')} of <b>${branch}</b> will be on no other branch or tag once it is moved.`,
		forcePush: (n, remoteBranch, branch) => `${commits(n, 'en')} on <b>${remoteBranch}</b> are not in <b>${branch}</b> and will be removed from the remote.`
	},
	// The view's Chinese ('zh-cn' is its language code): Traditional Chinese (Taiwan) in this app.
	'zh-cn': {
		detached: (n) => `HEAD 處於分離狀態，停在${commits(n, 'zh-cn')}上，它們不屬於任何分支或標籤。此操作之後只能透過 reflog 找回。`,
		resetCommits: (n, branch) => `重置後，<b>${branch}</b> 上的${commits(n, 'zh-cn')}將不屬於任何分支或標籤。`,
		uncommitted: (n) => `已追蹤檔案的 ${n} 處未提交變更將被捨棄。`,
		moveBranch: (n, branch) => `移動 <b>${branch}</b> 後，它的${commits(n, 'zh-cn')}將不屬於其他任何分支或標籤。`,
		forcePush: (n, remoteBranch, branch) => `<b>${remoteBranch}</b> 上有${commits(n, 'zh-cn')}不在 <b>${branch}</b> 中，將從遠端刪除。`
	}
};
const lossText = (ctx) => LOSS[(ctx.config && ctx.config().interfaceLanguage) === 'zh-cn' ? 'zh-cn' : 'en'];

/** How many commits `rev-list <args>` lists (0 when git cannot tell, e.g. an unknown ref). */
async function countCommits(ctx, args) {
	const result = await exec(ctx, ['rev-list', '--count', ...args]);
	return result.exitCode === 0 ? parseInt(result.stdout.trim(), 10) || 0 : 0;
}

/** The checked-out branch, or null when HEAD is detached. */
async function currentBranch(ctx) {
	const result = await exec(ctx, ['symbolic-ref', '-q', '--short', 'HEAD']);
	return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Leaving a detached HEAD for `target`: the commits only HEAD holds (none if HEAD is not detached). */
async function detachedLoss(ctx, target) {
	if (await currentBranch(ctx) !== null) return [];
	const n = await countCommits(ctx, ['HEAD', '--not', target, '--branches', '--tags', '--remotes']);
	return n > 0 ? [lossText(ctx).detached(n)] : [];
}

/** Moving branch `branch` to `target`: its commits no other ref (nor `target`) holds. */
async function movedBranchLoss(ctx, branch, target, text) {
	const n = await countCommits(ctx, ['refs/heads/' + branch, '--not', target, '--exclude=' + branch, '--branches', '--tags', '--remotes']);
	return n > 0 ? [text(n, escapeHtml(branch))] : [];
}

/** The reasons `m` would lose work (empty: none). Each check reads only. */
export async function lossOf(ctx, m) {
	const text = lossText(ctx);
	switch (m.command) {
		case 'checkoutCommit':
			return detachedLoss(ctx, m.commitHash);
		case 'checkoutBranch':
			return detachedLoss(ctx, m.remoteBranch ?? m.branchName);
		case 'branchFromStash':
			return detachedLoss(ctx, m.selector + '^');
		case 'createBranch': {
			const exists = (await exec(ctx, ['rev-parse', '--verify', '-q', 'refs/heads/' + m.branchName])).exitCode === 0;
			return [
				...(m.force && exists ? await movedBranchLoss(ctx, m.branchName, m.commitHash, text.moveBranch) : []),
				...(m.checkout ? await detachedLoss(ctx, m.commitHash) : [])
			];
		}
		case 'resetToCommit': {
			const branch = await currentBranch(ctx);
			const reasons = branch === null ? await detachedLoss(ctx, m.commit) : await movedBranchLoss(ctx, branch, m.commit, text.resetCommits);
			if (m.resetMode === 'hard') {
				const status = await exec(ctx, ['status', '--porcelain', '--untracked-files=no']);
				const n = status.exitCode === 0 ? status.stdout.split('\n').filter((l) => l !== '').length : 0;
				if (n > 0) reasons.push(text.uncommitted(n));
			}
			return reasons;
		}
		case 'pushBranch': {
			if (m.mode !== 'force' && m.mode !== 'force-with-lease') return [];
			const reasons = [];
			for (const remote of m.remotes) {
				const n = await countCommits(ctx, ['refs/remotes/' + remote + '/' + m.branchName, '--not', 'refs/heads/' + m.branchName]);
				if (n > 0) reasons.push(text.forcePush(n, escapeHtml(remote + '/' + m.branchName), escapeHtml(m.branchName)));
			}
			return reasons;
		}
		default:
			return [];
	}
}

/** `handler` behind the data-loss check: a warning instead of running, unless confirmed. Values
 * are vetted first (they reach rev-list's argv), so an unsafe one fails as the handler would. */
function guarded(handler, values) {
	return async (ctx, m) => {
		if (m.confirmed !== true && unsafe(...values(m)) === null) {
			const reasons = await lossOf(ctx, m);
			if (reasons.length > 0) return { command: 'lossWarning', message: reasons.join('<br>'), retry: { ...m, confirmed: true } };
		}
		return handler(ctx, m);
	};
}

/* ---------- The handlers ---------- */

const UNIT = '\x1f';

export const gitHandlers = {
	/* --- Remotes --- */
	async addRemote(ctx, m) {
		let error = unsafe(m.name, m.url, m.pushUrl) ?? await run(ctx, ['remote', 'add', m.name, m.url]);
		if (error === null && m.pushUrl !== null) error = await run(ctx, ['remote', 'set-url', '--push', m.name, m.pushUrl]);
		if (error === null && m.fetch) error = await run(ctx, ['fetch', m.name]);
		return { command: 'addRemote', error };
	},
	async deleteRemote(ctx, m) {
		return { command: 'deleteRemote', error: unsafe(m.name) ?? await run(ctx, ['remote', 'remove', m.name]) };
	},
	async editRemote(ctx, m) {
		let error = unsafe(m.nameOld, m.nameNew, m.urlNew, m.pushUrlNew);
		if (error === null && m.nameOld !== m.nameNew) error = await run(ctx, ['remote', 'rename', m.nameOld, m.nameNew]);
		if (error === null && m.urlOld !== m.urlNew) error = await run(ctx, setUrlArgs(m.nameNew, m.urlOld, m.urlNew, false));
		if (error === null && m.pushUrlOld !== m.pushUrlNew) error = await run(ctx, setUrlArgs(m.nameNew, m.pushUrlOld, m.pushUrlNew, true));
		return { command: 'editRemote', error };
	},
	async pruneRemote(ctx, m) {
		return { command: 'pruneRemote', error: unsafe(m.name) ?? await run(ctx, ['remote', 'prune', m.name]) };
	},
	async fetch(ctx, m) {
		const args = ['fetch', ...flag(m.prune, '--prune'), ...flag(m.prune && m.pruneTags, '--prune-tags'), m.name === null ? '--all' : m.name];
		return { command: 'fetch', error: unsafe(m.name) ?? await run(ctx, args) };
	},
	async fetchIntoLocalBranch(ctx, m) {
		const error = unsafe(m.remote, m.remoteBranch, m.localBranch)
			?? await run(ctx, ['fetch', ...flag(m.force, '--force'), m.remote, m.remoteBranch + ':' + m.localBranch]);
		return { command: 'fetchIntoLocalBranch', error };
	},
	async pullBranch(ctx, m) {
		return { command: 'pullBranch', error: await pull(ctx, m.remote, m.branchName, m.createNewCommit, m.squash) };
	},
	async pushBranch(ctx, m) {
		const mode = m.mode === 'force' ? ['--force'] : m.mode === 'force-with-lease' ? ['--force-with-lease'] : [];
		const errors = [];
		for (const remote of m.remotes) {
			errors.push(unsafe(remote, m.branchName) ?? await run(ctx, ['push', ...flag(m.setUpstream, '--set-upstream'), ...mode, remote, m.branchName]));
		}
		return { command: 'pushBranch', errors, willUpdateBranchConfig: m.willUpdateBranchConfig };
	},

	/* --- Tags --- */
	async addTag(ctx, m) {
		const base = { command: 'addTag', repo: m.repo, tagName: m.tagName, pushToRemote: m.pushToRemote, commitHash: m.commitHash };
		const create = m.type === TagType.Annotated
			? ['tag', ...flag(m.force, '-f'), '-a', m.tagName, '-m', m.message, m.commitHash]
			: ['tag', ...flag(m.force, '-f'), m.tagName, m.commitHash];
		const created = unsafe(m.tagName, m.commitHash) ?? await run(ctx, create);
		if (created !== null || m.pushToRemote === null) return { ...base, errors: [created] };
		if (!m.pushSkipRemoteCheck) {
			const missing = await remotesWithoutCommit(ctx, m.commitHash, [m.pushToRemote]);
			if (missing.length > 0) return { ...base, errors: [null, PUSH_TAG_COMMIT_NOT_ON_REMOTE + JSON.stringify(missing)] };
		}
		const pushed = unsafe(m.pushToRemote) ?? await run(ctx, ['push', m.pushToRemote, 'refs/tags/' + m.tagName]);
		return { ...base, errors: [null, pushed] };
	},
	async deleteTag(ctx, m) {
		let error = unsafe(m.tagName, m.deleteOnRemote);
		if (error === null && m.deleteOnRemote !== null) error = await run(ctx, ['push', m.deleteOnRemote, '--delete', 'refs/tags/' + m.tagName]);
		if (error === null) error = await run(ctx, ['tag', '-d', m.tagName]);
		return { command: 'deleteTag', error };
	},
	async pushTag(ctx, m) {
		const base = { command: 'pushTag', repo: m.repo, tagName: m.tagName, remotes: m.remotes, commitHash: m.commitHash };
		if (!m.skipRemoteCheck) {
			const missing = await remotesWithoutCommit(ctx, m.commitHash, m.remotes);
			if (missing.length > 0) return { ...base, errors: [PUSH_TAG_COMMIT_NOT_ON_REMOTE + JSON.stringify(missing)] };
		}
		const errors = [];
		for (const remote of m.remotes) {
			errors.push(unsafe(remote, m.tagName) ?? await run(ctx, ['push', remote, 'refs/tags/' + m.tagName]));
		}
		return { ...base, errors };
	},

	/* --- Branches --- */
	async createBranch(ctx, m) {
		const created = unsafe(m.branchName, m.commitHash) ?? await run(ctx, ['branch', ...flag(m.force, '-f'), m.branchName, m.commitHash]);
		const errors = [created];
		if (created === null && m.checkout) errors.push(await run(ctx, ['checkout', m.branchName]));
		return { command: 'createBranch', errors };
	},
	async checkoutBranch(ctx, m) {
		const checkout = m.remoteBranch === null ? ['checkout', m.branchName] : ['checkout', '-b', m.branchName, m.remoteBranch];
		const checkedOut = unsafe(m.branchName, m.remoteBranch) ?? await run(ctx, checkout);
		const errors = [checkedOut];
		const after = m.pullAfterwards;
		if (checkedOut === null && after !== null) errors.push(await pull(ctx, after.remote, after.branchName, after.createNewCommit, after.squash));
		return { command: 'checkoutBranch', errors, pullAfterwards: after === null ? null : { branchName: after.branchName, remote: after.remote } };
	},
	async checkoutCommit(ctx, m) {
		return { command: 'checkoutCommit', error: unsafe(m.commitHash) ?? await run(ctx, ['checkout', '--detach', m.commitHash]) };
	},
	async deleteBranch(ctx, m) {
		const deleted = unsafe(m.branchName, ...m.deleteOnRemotes) ?? await run(ctx, ['branch', m.forceDelete ? '-D' : '-d', m.branchName]);
		const errors = [deleted];
		if (deleted === null) {
			for (const remote of m.deleteOnRemotes) errors.push(await deleteOnRemote(ctx, remote, m.branchName));
		}
		return { command: 'deleteBranch', repo: m.repo, branchName: m.branchName, deleteOnRemotes: m.deleteOnRemotes, errors };
	},
	async deleteRemoteBranch(ctx, m) {
		return { command: 'deleteRemoteBranch', error: unsafe(m.remote, m.branchName) ?? await deleteOnRemote(ctx, m.remote, m.branchName) };
	},
	async renameBranch(ctx, m) {
		return { command: 'renameBranch', error: unsafe(m.oldName, m.newName) ?? await run(ctx, ['branch', '-m', m.oldName, m.newName]) };
	},

	/* --- Merge, rebase, cherry-pick, revert --- */
	async merge(ctx, m) {
		const args = ['merge', ...flag(m.squash, '--squash'), ...flag(!m.squash && m.createNewCommit, '--no-ff'), ...flag(m.noCommit && !m.squash, '--no-commit'), m.obj];
		let error = unsafe(m.obj) ?? await run(ctx, args);
		if (error === null && m.squash && !m.noCommit) error = await commitSquashed(ctx);
		return { command: 'merge', error, actionOn: m.actionOn };
	},
	async rebase(ctx, m) {
		const base = { command: 'rebase', actionOn: m.actionOn, interactive: m.interactive };
		if (unsafe(m.obj) !== null) return { ...base, error: unsafe(m.obj) };
		const options = [...flag(m.ignoreDate, '--ignore-date'), ...flag(m.autosquash, '--autosquash')];
		if (m.interactive) {
			// The todo editor needs a person at a terminal.
			try {
				await ctx.terminal(['rebase', '-i', ...options, m.obj]);
				return { ...base, error: null };
			} catch (e) {
				return { ...base, error: String(e) };
			}
		}
		// --autosquash only applies to an interactive rebase; with GIT_EDITOR=true it runs unattended.
		return { ...base, error: await run(ctx, ['rebase', ...flag(m.autosquash, '-i'), ...options, m.obj]) };
	},
	async cherrypickCommit(ctx, m) {
		const args = ['cherry-pick', ...flag(m.parentIndex > 0, '-m', String(m.parentIndex)), ...flag(m.recordOrigin, '-x'), ...flag(m.noCommit, '--no-commit'), m.commitHash];
		return { command: 'cherrypickCommit', errors: [unsafe(m.commitHash) ?? await run(ctx, args)] };
	},
	async revertCommit(ctx, m) {
		const args = ['revert', '--no-edit', ...flag(m.parentIndex > 0, '-m', String(m.parentIndex)), m.commitHash];
		return { command: 'revertCommit', error: unsafe(m.commitHash) ?? await run(ctx, args) };
	},
	async continueOperation(ctx, m) {
		const verb = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[m.type];
		return { command: 'continueOperation', error: verb ? await run(ctx, [verb, '--continue']) : 'Unknown operation ' + m.type };
	},
	async abortOperation(ctx, m) {
		const verb = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[m.type];
		return { command: 'abortOperation', error: verb ? await run(ctx, [verb, '--abort']) : 'Unknown operation ' + m.type };
	},

	/* --- Commits --- */
	async resetToCommit(ctx, m) {
		const mode = ['soft', 'mixed', 'hard'].includes(m.resetMode) ? m.resetMode : null;
		const error = mode === null ? 'Unknown reset mode ' + m.resetMode : unsafe(m.commit) ?? await run(ctx, ['reset', '--' + mode, m.commit]);
		return { command: 'resetToCommit', error };
	},
	async undoLastCommit(ctx) {
		return { command: 'undoLastCommit', error: await run(ctx, ['reset', '--soft', 'HEAD~1']) };
	},
	async dropCommit(ctx, m) {
		return { command: 'dropCommit', error: await rewriteFrom(ctx, m.commitHash, (commits) => commits.slice(1).map((c) => 'pick ' + c)) };
	},
	async editCommitMessage(ctx, m) {
		const author = m.authorName && m.authorEmail ? m.authorName + ' <' + m.authorEmail + '>' : null;
		if (m.commitHash === await headHash(ctx)) {
			const args = ['commit', '--amend', '--only', '--allow-empty', '-m', m.message, ...flag(author !== null, '--author', author)];
			return { command: 'editCommitMessage', error: await run(ctx, args) };
		}
		// An older commit: replay the branch from it, amending it right after it is picked. The
		// message and author ride in the environment, which the rebase's exec lines inherit.
		const amend = 'exec git commit --amend --only --allow-empty -m "$GG_MESSAGE"' + (author !== null ? ' --author "$GG_AUTHOR"' : '');
		const error = await rewriteFrom(ctx, m.commitHash,
			(commits) => commits.flatMap((c, i) => (i === 0 ? ['pick ' + c, amend] : ['pick ' + c])),
			{ GG_MESSAGE: m.message, ...(author !== null ? { GG_AUTHOR: author } : {}) });
		return { command: 'editCommitMessage', error };
	},
	async commitFixup(ctx, m) {
		return { command: 'commitFixup', error: unsafe(m.commitHash) ?? await run(ctx, ['commit', '--fixup=' + m.commitHash]) };
	},
	async commitSquash(ctx, m) {
		return { command: 'commitSquash', error: unsafe(m.commitHash) ?? await run(ctx, ['commit', '--squash=' + m.commitHash]) };
	},

	/* --- Stashes --- */
	async pushStash(ctx, m) {
		const args = ['stash', 'push', ...flag(m.includeUntracked, '--include-untracked'), ...flag(m.message !== '', '-m', m.message)];
		return { command: 'pushStash', error: await run(ctx, args) };
	},
	async applyStash(ctx, m) {
		return { command: 'applyStash', error: unsafe(m.selector) ?? await run(ctx, ['stash', 'apply', ...flag(m.reinstateIndex, '--index'), m.selector]) };
	},
	async popStash(ctx, m) {
		return { command: 'popStash', error: unsafe(m.selector) ?? await run(ctx, ['stash', 'pop', ...flag(m.reinstateIndex, '--index'), m.selector]) };
	},
	async dropStash(ctx, m) {
		return { command: 'dropStash', error: unsafe(m.selector) ?? await run(ctx, ['stash', 'drop', m.selector]) };
	},
	async branchFromStash(ctx, m) {
		return { command: 'branchFromStash', error: unsafe(m.branchName, m.selector) ?? await run(ctx, ['stash', 'branch', m.branchName, m.selector]) };
	},

	/* --- Working tree --- */
	async cleanUntrackedFiles(ctx, m) {
		return { command: 'cleanUntrackedFiles', error: await run(ctx, ['clean', '-f', ...flag(m.directories, '-d')]) };
	},
	async resetFileToRevision(ctx, m) {
		return { command: 'resetFileToRevision', error: unsafe(m.commitHash) ?? await run(ctx, ['checkout', m.commitHash, '--', m.filePath]) };
	},
	async createArchive(ctx, m) {
		if (unsafe(m.ref) !== null) return { command: 'createArchive', error: unsafe(m.ref) };
		// git would write the archive on the repository's machine, not where the dialog points.
		if (ctx.repo.startsWith('ssh://')) return { command: 'createArchive', error: 'Not available for a repository on another machine.' };
		const name = ctx.repo.split('/').pop() + '-' + m.ref.replace(/[^\w.-]+/g, '-') + '.zip';
		const path = await ctx.saveDialog(name);
		if (path === null) return { command: 'createArchive', error: null }; // cancelled
		return { command: 'createArchive', error: await run(ctx, ['archive', '-o', path, m.ref]) };
	},

	/* --- Worktrees --- */
	async worktreeList(ctx, m) {
		const result = await exec(ctx, ['worktree', 'list', '--porcelain']);
		const worktrees = [];
		for (const block of result.exitCode === 0 ? result.stdout.split('\n\n') : []) {
			const lines = block.split('\n').filter((l) => l !== '');
			if (lines.length === 0 || !lines[0].startsWith('worktree ')) continue;
			const value = (prefix) => { const l = lines.find((x) => x === prefix || x.startsWith(prefix + ' ')); return l === undefined ? null : l.slice(prefix.length).trim(); };
			const branch = value('branch');
			worktrees.push({
				path: value('worktree'),
				hash: value('HEAD') ?? '',
				branch: branch === null ? null : branch.replace(/^refs\/heads\//, ''),
				detached: value('detached') !== null,
				locked: value('locked') !== null,
				prunable: value('prunable') !== null,
				isMain: worktrees.length === 0
			});
		}
		return { command: 'worktreeList', repo: m.repo, worktrees };
	},
	async worktreeAdd(ctx, m) {
		const args = m.newBranch !== null
			? ['worktree', 'add', '-b', m.newBranch, m.path, ...flag(!!m.branch, m.branch)]
			: ['worktree', 'add', m.path, ...flag(!!m.branch, m.branch)];
		return { command: 'worktreeAdd', error: unsafe(m.path, m.branch, m.newBranch) ?? await run(ctx, args) };
	},
	async worktreeRemove(ctx, m) {
		return { command: 'worktreeRemove', error: unsafe(m.path) ?? await run(ctx, ['worktree', 'remove', ...flag(m.force, '--force'), m.path]) };
	},
	async worktreePrune(ctx) {
		return { command: 'worktreePrune', error: await run(ctx, ['worktree', 'prune']) };
	},

	/* --- Config --- */
	async loadConfig(ctx, m) {
		try {
			return { command: 'loadConfig', repo: m.repo, refreshId: m.refreshId, config: await readRepoConfig(ctx), error: null };
		} catch (e) {
			return { command: 'loadConfig', repo: m.repo, refreshId: m.refreshId, config: null, error: String(e.message || e) };
		}
	},
	async editUserDetails(ctx, m) {
		const loc = m.location === 'global' ? 'global' : 'local';
		const errors = [
			await run(ctx, ['config', '--' + loc, 'user.name', m.name]),
			await run(ctx, ['config', '--' + loc, 'user.email', m.email])
		];
		if (loc === 'global' && m.deleteLocalName) errors.push(await unsetConfig(ctx, 'local', 'user.name'));
		if (loc === 'global' && m.deleteLocalEmail) errors.push(await unsetConfig(ctx, 'local', 'user.email'));
		return { command: 'editUserDetails', errors };
	},
	async deleteUserDetails(ctx, m) {
		const loc = m.location === 'global' ? 'global' : 'local';
		const errors = [];
		if (m.name) errors.push(await unsetConfig(ctx, loc, 'user.name'));
		if (m.email) errors.push(await unsetConfig(ctx, loc, 'user.email'));
		return { command: 'deleteUserDetails', errors };
	},

	/* --- Reads --- */
	async reflog(ctx, m) {
		const base = { command: 'reflog', repo: m.repo, ref: m.ref };
		if (unsafe(m.ref) !== null) return { ...base, entries: [], moreAvailable: false, error: unsafe(m.ref) };
		const result = await exec(ctx, ['reflog', 'show', '--date=unix', '--format=%H' + UNIT + '%h' + UNIT + '%gD' + UNIT + '%gs', '-n', String(m.limit + 1), m.ref, '--']);
		if (result.exitCode !== 0) return { ...base, entries: [], moreAvailable: false, error: errorOf(result) };
		const rows = result.stdout.split('\n').filter((l) => l !== '').map((l) => l.split(UNIT));
		const shown = rows.slice(0, m.limit);
		// Dangling = reachable from no ref: what `<hashes> --not --all` still lists.
		const hashes = [...new Set(shown.map((r) => r[0]))];
		const unreachable = hashes.length === 0 ? new Set()
			: new Set((await exec(ctx, ['rev-list', ...hashes, '--not', '--all'])).stdout.split('\n').filter((l) => l !== ''));
		const entries = shown.map(([hash, abbrevHash, selector, message], i) => ({
			hash, abbrevHash,
			selector: m.ref + '@{' + i + '}',
			date: parseInt((/@\{(\d+)\}$/.exec(selector) || [])[1] || '0', 10),
			message,
			dangling: unreachable.has(hash)
		}));
		return { ...base, entries, moreAvailable: rows.length > m.limit, error: null };
	},
	async predictConflicts(ctx, m) {
		const base = { command: 'predictConflicts', ours: m.ours, theirs: m.theirs };
		if (unsafe(m.ours, m.theirs) !== null) return { ...base, prediction: null };
		// exit 0: clean; exit 1: conflicts (tree id, then one conflicted path per line); else: cannot tell.
		const result = await exec(ctx, ['merge-tree', '--write-tree', '--name-only', '--no-messages', m.ours, m.theirs]);
		if (result.exitCode !== 0 && result.exitCode !== 1) return { ...base, prediction: null };
		const files = result.exitCode === 1 ? result.stdout.split('\n').slice(1).filter((l) => l !== '') : [];
		return { ...base, prediction: { conflicted: result.exitCode === 1, files } };
	}
};

/* The actions that can lose work, behind the data-loss check (lossOf above); each with the
 * values from the view that reach git's argv. */
const GUARDED = {
	branchFromStash: (m) => [m.branchName, m.selector],
	checkoutBranch: (m) => [m.branchName, m.remoteBranch],
	checkoutCommit: (m) => [m.commitHash],
	createBranch: (m) => [m.branchName, m.commitHash],
	pushBranch: (m) => [m.branchName, ...m.remotes],
	resetToCommit: (m) => [m.commit]
};
for (const [command, values] of Object.entries(GUARDED)) gitHandlers[command] = guarded(gitHandlers[command], values);

/** Delete a branch on a remote. A branch already gone there only leaves the stale
 * remote-tracking branch behind: remove that instead of failing. */
async function deleteOnRemote(ctx, remote, branchName) {
	const error = await run(ctx, ['push', remote, '--delete', branchName]);
	if (error !== null && /remote ref does not exist/i.test(error)) {
		return run(ctx, ['branch', '--delete', '--remotes', remote + '/' + branchName]);
	}
	return error;
}
