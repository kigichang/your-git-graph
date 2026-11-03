/* The git CLI handlers (app/ui/host/gitops.js) against real git, in throwaway repositories.
 * Run: node --test app/tests/
 * The user's own git config is never touched: GIT_CONFIG_GLOBAL points at a temp file. */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitHandlers as h, readOperationState, readRepoConfig, syncGlobalAuthor, lossOf, PUSH_TAG_COMMIT_NOT_ON_REMOTE, TagType, READ_COMMANDS } from '../ui/host/gitops.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-gitops-'));
const globalConfig = path.join(tmpRoot, 'global.gitconfig');
fs.writeFileSync(globalConfig, '[user]\n\tname = Global User\n\temail = global@example.com\n[init]\n\tdefaultBranch = main\n');
const BASE_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000'
};

/** git in `cwd`, shaped like the Rust git_exec result. */
function gitIn(cwd, args, opts = {}) {
	const t0 = Date.now();
	const r = spawnSync('git', args, { cwd, env: { ...BASE_ENV, ...(opts.env || {}) }, encoding: 'utf8' });
	return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false, cancelled: false, durationMs: Date.now() - t0 };
}
const sh = (cwd, ...args) => {
	const r = gitIn(cwd, args);
	if (r.exitCode !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
	return r.stdout.trim();
};

/** The operation marker as the Rust side (src-tauri/src/repo.rs) reports it. */
function marker(repo) {
	const dir = path.join(repo, '.git');
	const num = (f) => parseInt(fs.readFileSync(path.join(dir, f), 'utf8'), 10);
	if (fs.existsSync(path.join(dir, 'rebase-merge'))) return { type: 'rebase', progress: { step: num('rebase-merge/msgnum'), total: num('rebase-merge/end') } };
	for (const [f, type] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
		if (fs.existsSync(path.join(dir, f))) return { type, progress: null };
	}
	return { type: null, progress: null };
}

function makeCtx(repo) {
	const calls = { terminal: [] };
	return {
		repo, calls,
		git: async (args, opts) => gitIn(repo, args, opts),
		engine: async (method) => { if (method === 'authors') return [{ name: 'Engine Author', email: 'a@example.com' }]; throw new Error('no engine in tests'); },
		terminal: async (args) => { calls.terminal.push(args); },
		saveDialog: async (name) => path.join(tmpRoot, name),
		operationMarker: async () => marker(repo)
	};
}

let counter = 0;
/** A repository with main: c1 → c2 → c3 (files a, b, c), pushed to a bare `origin`. */
function fixture() {
	const dir = path.join(tmpRoot, 'r' + (++counter));
	const remote = dir + '-origin.git';
	fs.mkdirSync(dir);
	sh(tmpRoot, 'init', '-q', '--bare', remote);
	sh(dir, 'init', '-q');
	for (const name of ['a', 'b', 'c']) {
		fs.writeFileSync(path.join(dir, name), name + '\n');
		sh(dir, 'add', name);
		sh(dir, 'commit', '-qm', 'add ' + name);
	}
	sh(dir, 'remote', 'add', 'origin', remote);
	sh(dir, 'push', '-q', '-u', 'origin', 'main');
	return { dir, remote, ctx: makeCtx(dir), git: (...a) => sh(dir, ...a) };
}
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const subjects = (git, range = 'HEAD') => git('log', '--format=%s', range).split('\n');

before(() => assert.equal(spawnSync('git', ['--version']).status, 0, 'these tests need git'));

describe('branches', () => {
	test('create (and check out), rename, delete', async () => {
		const { ctx, git } = fixture();
		const c2 = git('rev-parse', 'HEAD~1');
		assert.deepEqual(await h.createBranch(ctx, { branchName: 'feat', commitHash: c2, checkout: true, force: false }), { command: 'createBranch', errors: [null, null] });
		assert.equal(git('branch', '--show-current'), 'feat');
		assert.equal(git('rev-parse', 'HEAD'), c2);
		assert.equal((await h.renameBranch(ctx, { oldName: 'feat', newName: 'feat2' })).error, null);
		await h.checkoutBranch(ctx, { branchName: 'main', remoteBranch: null, pullAfterwards: null });
		const r = await h.deleteBranch(ctx, { repo: ctx.repo, branchName: 'feat2', forceDelete: false, deleteOnRemotes: [] });
		assert.deepEqual(r.errors, [null]);
		assert.equal(git('branch', '--list', 'feat2'), '');
	});

	test('an unmerged branch needs force; the remote copy goes too', async () => {
		const { ctx, git, dir } = fixture();
		git('checkout', '-qb', 'wip');
		write(dir, 'w', 'w\n'); git('add', 'w'); git('commit', '-qm', 'wip');
		git('push', '-q', 'origin', 'wip');
		git('checkout', '-q', 'main');
		const refused = await h.deleteBranch(ctx, { repo: ctx.repo, branchName: 'wip', forceDelete: false, deleteOnRemotes: ['origin'] });
		assert.match(refused.errors[0], /not fully merged/);
		assert.equal(refused.errors.length, 1, 'no remote deletion after a failed local one');
		const forced = await h.deleteBranch(ctx, { repo: ctx.repo, branchName: 'wip', forceDelete: true, deleteOnRemotes: ['origin'] });
		assert.deepEqual(forced.errors, [null, null]);
		assert.equal(git('ls-remote', '--heads', 'origin', 'wip'), '');
	});

	test('deleting a remote branch that is already gone removes the stale tracking branch', async () => {
		const { ctx, git, remote } = fixture();
		git('push', '-q', 'origin', 'main:gone');
		git('fetch', '-q', 'origin');
		sh(remote, 'branch', '-D', 'gone');
		assert.equal((await h.deleteRemoteBranch(ctx, { remote: 'origin', branchName: 'gone' })).error, null);
		assert.equal(git('branch', '-r', '--list', 'origin/gone'), '');
	});

	test('check out a remote branch as a tracking branch, and a commit detached', async () => {
		const { ctx, git } = fixture();
		git('push', '-q', 'origin', 'main~1:refs/heads/older');
		git('fetch', '-q', 'origin');
		const r = await h.checkoutBranch(ctx, { branchName: 'older', remoteBranch: 'origin/older', pullAfterwards: null });
		assert.deepEqual(r, { command: 'checkoutBranch', errors: [null], pullAfterwards: null });
		assert.equal(git('rev-parse', '--abbrev-ref', 'older@{upstream}'), 'origin/older');
		const c1 = git('rev-parse', 'main~2');
		assert.equal((await h.checkoutCommit(ctx, { commitHash: c1 })).error, null);
		assert.equal(git('branch', '--show-current'), '');
		assert.equal(git('rev-parse', 'HEAD'), c1);
	});

	test('arguments that look like options are refused before git runs', async () => {
		const { ctx } = fixture();
		const r = await h.createBranch(ctx, { branchName: '--upload-pack=evil', commitHash: 'HEAD', checkout: false, force: false });
		assert.match(r.errors[0], /must not start with "-"/);
		assert.match((await h.fetch(ctx, { name: '-oProxyCommand=x', prune: false, pruneTags: false })).error, /must not start/);
	});
});

describe('tags', () => {
	test('annotated and lightweight tags; deleting on the remote', async () => {
		const { ctx, git } = fixture();
		const head = git('rev-parse', 'HEAD');
		const a = await h.addTag(ctx, { repo: ctx.repo, commitHash: head, tagName: 'v1', type: TagType.Annotated, message: 'release 1', pushToRemote: 'origin', pushSkipRemoteCheck: false, force: false });
		assert.deepEqual(a.errors, [null, null]);
		assert.equal(git('cat-file', '-t', 'v1'), 'tag');
		assert.equal(git('tag', '-l', '--format=%(contents:subject)', 'v1'), 'release 1');
		assert.notEqual(git('ls-remote', '--tags', 'origin', 'v1'), '');
		const l = await h.addTag(ctx, { repo: ctx.repo, commitHash: head, tagName: 'light', type: TagType.Lightweight, message: '', pushToRemote: null, pushSkipRemoteCheck: false, force: false });
		assert.deepEqual(l.errors, [null]);
		assert.equal(git('cat-file', '-t', 'light'), 'commit');
		assert.equal((await h.deleteTag(ctx, { tagName: 'v1', deleteOnRemote: 'origin' })).error, null);
		assert.equal(git('tag', '-l', 'v1'), '');
		assert.equal(git('ls-remote', '--tags', 'origin', 'v1'), '');
	});

	test('pushing a tag whose commit is not on the remote asks first', async () => {
		const { ctx, git, dir } = fixture();
		write(dir, 'd', 'd\n'); git('add', 'd'); git('commit', '-qm', 'local only');
		const head = git('rev-parse', 'HEAD');
		const a = await h.addTag(ctx, { repo: ctx.repo, commitHash: head, tagName: 't', type: TagType.Lightweight, message: '', pushToRemote: 'origin', pushSkipRemoteCheck: false, force: false });
		assert.deepEqual(a.errors, [null, PUSH_TAG_COMMIT_NOT_ON_REMOTE + '["origin"]']);
		const p = await h.pushTag(ctx, { repo: ctx.repo, tagName: 't', remotes: ['origin'], commitHash: head, skipRemoteCheck: false });
		assert.deepEqual(p.errors, [PUSH_TAG_COMMIT_NOT_ON_REMOTE + '["origin"]']);
		const forced = await h.pushTag(ctx, { repo: ctx.repo, tagName: 't', remotes: ['origin'], commitHash: head, skipRemoteCheck: true });
		assert.deepEqual(forced.errors, [null]);
	});
});

describe('remotes', () => {
	test('push with upstream, fetch with prune, pull with squash', async () => {
		const { ctx, git, dir, remote } = fixture();
		git('checkout', '-qb', 'topic');
		const pushed = await h.pushBranch(ctx, { branchName: 'topic', remotes: ['origin'], setUpstream: true, mode: '', willUpdateBranchConfig: false });
		assert.deepEqual(pushed.errors, [null]);
		assert.equal(git('rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'origin/topic');

		sh(remote, 'branch', '-D', 'topic');
		assert.equal((await h.fetch(ctx, { name: null, prune: true, pruneTags: false })).error, null);
		assert.equal(git('branch', '-r', '--list', 'origin/topic'), '');

		// Someone else adds two commits to origin/main; pull them squashed into one.
		const other = path.join(tmpRoot, 'other' + counter);
		sh(tmpRoot, 'clone', '-q', remote, other);
		for (const n of ['x', 'y']) { write(other, n, n + '\n'); sh(other, 'add', n); sh(other, 'commit', '-qm', 'remote ' + n); }
		sh(other, 'push', '-q', 'origin', 'main');
		git('checkout', '-q', 'main');
		const before = git('rev-parse', 'HEAD');
		assert.equal((await h.pullBranch(ctx, { branchName: 'main', remote: 'origin', createNewCommit: false, squash: true })).error, null);
		assert.equal(git('rev-parse', 'HEAD~1'), before, 'exactly one new commit');
		assert.ok(fs.existsSync(path.join(dir, 'x')) && fs.existsSync(path.join(dir, 'y')));
	});

	test('add, edit, prune and delete a remote', async () => {
		const { ctx, git, remote } = fixture();
		assert.equal((await h.addRemote(ctx, { name: 'up', url: remote, pushUrl: '/push/url', fetch: true })).error, null);
		assert.equal(git('config', 'remote.up.pushurl'), '/push/url');
		assert.notEqual(git('branch', '-r', '--list', 'up/main'), '', 'fetched');
		const edit = await h.editRemote(ctx, { nameOld: 'up', nameNew: 'up2', urlOld: remote, urlNew: '/new/url', pushUrlOld: '/push/url', pushUrlNew: null });
		assert.equal(edit.error, null);
		assert.equal(git('config', 'remote.up2.url'), '/new/url');
		assert.equal(gitIn(ctx.repo, ['config', 'remote.up2.pushurl']).exitCode, 1, 'push URL removed');
		assert.equal((await h.pruneRemote(ctx, { name: 'origin' })).error, null);
		assert.equal((await h.deleteRemote(ctx, { name: 'up2' })).error, null);
		assert.equal(git('remote'), 'origin');
	});
});

describe('merge, rebase, cherry-pick, revert', () => {
	/** main gets m1, side (from c3) gets s1 + s2 touching other files. */
	function diverged() {
		const f = fixture();
		f.git('checkout', '-qb', 'side');
		for (const n of ['s1', 's2']) { write(f.dir, n, n + '\n'); f.git('add', n); f.git('commit', '-qm', n); }
		f.git('checkout', '-q', 'main');
		write(f.dir, 'm1', 'm1\n'); f.git('add', 'm1'); f.git('commit', '-qm', 'm1');
		return f;
	}

	test('merge: a merge commit, or one squashed commit', async () => {
		const f = diverged();
		const r = await h.merge(f.ctx, { obj: 'side', actionOn: 'Branch', createNewCommit: true, squash: false, noCommit: false });
		assert.deepEqual(r, { command: 'merge', error: null, actionOn: 'Branch' });
		assert.equal(f.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);

		const g = diverged();
		const before = g.git('rev-parse', 'HEAD');
		assert.equal((await h.merge(g.ctx, { obj: 'side', actionOn: 'Branch', createNewCommit: false, squash: true, noCommit: false })).error, null);
		assert.equal(g.git('rev-parse', 'HEAD~1'), before);
		assert.equal(g.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 2, 'not a merge commit');
	});

	test('a conflicting merge reports its state; abort restores the branch', async () => {
		const { ctx, git, dir } = fixture();
		git('checkout', '-qb', 'other');
		write(dir, 'a', 'other\n'); git('commit', '-qam', 'other a');
		git('checkout', '-q', 'main');
		write(dir, 'a', 'main\n'); git('commit', '-qam', 'main a');
		const head = git('rev-parse', 'HEAD');
		assert.match((await h.merge(ctx, { obj: 'other', actionOn: 'Branch', createNewCommit: false, squash: false, noCommit: false })).error, /CONFLICT/);
		assert.deepEqual(await readOperationState(ctx), { type: 'merge', conflictedFiles: ['a'], progress: null });

		const p = await h.predictConflicts(ctx, { ours: 'main', theirs: 'other' });
		assert.deepEqual(p.prediction, { conflicted: true, files: ['a'] });

		assert.equal((await h.abortOperation(ctx, { type: 'merge' })).error, null);
		assert.equal(git('rev-parse', 'HEAD'), head);
		assert.deepEqual(await readOperationState(ctx), { type: null, conflictedFiles: [], progress: null });
	});

	test('continue a conflicted rebase after resolving it', async () => {
		const { ctx, git, dir } = fixture();
		git('checkout', '-qb', 'other');
		write(dir, 'a', 'other\n'); git('commit', '-qam', 'other a');
		git('checkout', '-q', 'main');
		write(dir, 'a', 'main\n'); git('commit', '-qam', 'main a');
		assert.notEqual((await h.rebase(ctx, { obj: 'other', actionOn: 'Branch', ignoreDate: false, interactive: false, autosquash: false })).error, null);
		const state = await readOperationState(ctx);
		assert.equal(state.type, 'rebase');
		assert.deepEqual(state.conflictedFiles, ['a']);
		write(dir, 'a', 'resolved\n'); git('add', 'a');
		assert.equal((await h.continueOperation(ctx, { type: 'rebase' })).error, null);
		assert.deepEqual(subjects(git).slice(0, 2), ['main a', 'other a']);
	});

	test('rebase: plain, autosquash, and interactive (handed to Terminal)', async () => {
		const f = diverged();
		f.git('checkout', '-q', 'side');
		const r = await h.rebase(f.ctx, { obj: 'main', actionOn: 'Branch', ignoreDate: false, interactive: false, autosquash: false });
		assert.deepEqual(r, { command: 'rebase', actionOn: 'Branch', interactive: false, error: null });
		assert.deepEqual(subjects(f.git).slice(0, 3), ['s2', 's1', 'm1']);

		const s1 = f.git('rev-parse', 'HEAD~1');
		write(f.dir, 's1', 's1 fixed\n'); f.git('add', 's1');
		assert.equal((await h.commitFixup(f.ctx, { commitHash: s1 })).error, null);
		assert.equal(subjects(f.git)[0], 'fixup! s1');
		assert.equal((await h.rebase(f.ctx, { obj: 'main', actionOn: 'Branch', ignoreDate: false, interactive: false, autosquash: true })).error, null);
		assert.deepEqual(subjects(f.git).slice(0, 3), ['s2', 's1', 'm1']);
		assert.equal(f.git('show', 'HEAD~1:s1'), 's1 fixed');

		const i = await h.rebase(f.ctx, { obj: 'main', actionOn: 'Commit', ignoreDate: true, interactive: true, autosquash: false });
		assert.equal(i.error, null);
		assert.deepEqual(f.ctx.calls.terminal, [['rebase', '-i', '--ignore-date', 'main']]);
	});

	test('cherry-pick with origin recorded; revert', async () => {
		const f = diverged();
		const s1 = f.git('rev-parse', 'side~1');
		assert.deepEqual((await h.cherrypickCommit(f.ctx, { commitHash: s1, parentIndex: 0, recordOrigin: true, noCommit: false })).errors, [null]);
		assert.match(f.git('log', '-1', '--format=%B'), new RegExp('cherry picked from commit ' + s1));
		assert.equal((await h.revertCommit(f.ctx, { commitHash: 'HEAD', parentIndex: 0 })).error, null);
		assert.match(subjects(f.git)[0], /^Revert "s1"/);
		assert.ok(!fs.existsSync(path.join(f.dir, 's1')));
	});

	test('squash commit for staged changes', async () => {
		const { ctx, git, dir } = fixture();
		const c2 = git('rev-parse', 'HEAD~1');
		write(dir, 'b', 'b2\n'); git('add', 'b');
		assert.equal((await h.commitSquash(ctx, { commitHash: c2 })).error, null);
		assert.equal(subjects(git)[0], 'squash! add b');
	});
});

describe('rewriting commits', () => {
	test('edit the message of HEAD, with a new author', async () => {
		const { ctx, git } = fixture();
		const r = await h.editCommitMessage(ctx, { commitHash: git('rev-parse', 'HEAD'), message: 'new\n\nbody', authorName: 'New Name', authorEmail: 'new@example.com' });
		assert.equal(r.error, null);
		assert.equal(git('log', '-1', '--format=%B'), 'new\n\nbody');
		assert.equal(git('log', '-1', '--format=%an <%ae>'), 'New Name <new@example.com>');
	});

	test('edit the message of an older commit, keeping the later ones and the tree', async () => {
		const { ctx, git, dir } = fixture();
		write(dir, 'dirty', 'uncommitted\n'); git('add', 'dirty'); // autostashed and restored
		const tree = git('rev-parse', 'HEAD^{tree}');
		const r = await h.editCommitMessage(ctx, { commitHash: git('rev-parse', 'HEAD~1'), message: 'b, reworded "quoted" $HOME' });
		assert.equal(r.error, null);
		assert.deepEqual(subjects(git), ['add c', 'b, reworded "quoted" $HOME', 'add a']);
		assert.equal(git('rev-parse', 'HEAD^{tree}'), tree);
		assert.equal(git('status', '--porcelain'), 'A  dirty');
	});

	test('edit the root commit', async () => {
		const { ctx, git } = fixture();
		assert.equal((await h.editCommitMessage(ctx, { commitHash: git('rev-list', '--max-parents=0', 'HEAD'), message: 'root' })).error, null);
		assert.deepEqual(subjects(git), ['add c', 'add b', 'root']);
	});

	test('drop a commit from the middle, and the root', async () => {
		const f = fixture();
		assert.equal((await h.dropCommit(f.ctx, { commitHash: f.git('rev-parse', 'HEAD~1') })).error, null);
		assert.deepEqual(subjects(f.git), ['add c', 'add a']);
		assert.ok(!fs.existsSync(path.join(f.dir, 'b')));
		assert.equal((await h.dropCommit(f.ctx, { commitHash: f.git('rev-list', '--max-parents=0', 'HEAD') })).error, null);
		assert.deepEqual(subjects(f.git), ['add c']);
	});

	test('rewriting refuses merges in the range and commits off the branch', async () => {
		const { ctx, git, dir } = fixture();
		const c1 = git('rev-parse', 'HEAD~2');
		git('checkout', '-qb', 'x', 'HEAD~1'); write(dir, 'x', 'x\n'); git('add', 'x'); git('commit', '-qm', 'x');
		const x = git('rev-parse', 'HEAD');
		git('checkout', '-q', 'main'); git('merge', '-q', '--no-ff', '-m', 'merge x', 'x');
		assert.match((await h.dropCommit(ctx, { commitHash: c1 })).error, /merge commits/);
		git('reset', '-q', '--hard', 'HEAD~1');
		assert.match((await h.editCommitMessage(ctx, { commitHash: x, message: 'm' })).error, /not on the checked-out branch/);
	});

	test('reset modes and undo last commit', async () => {
		const { ctx, git } = fixture();
		const c2 = git('rev-parse', 'HEAD~1');
		assert.equal((await h.undoLastCommit(ctx, {})).error, null);
		assert.equal(git('rev-parse', 'HEAD'), c2);
		assert.equal(git('status', '--porcelain'), 'A  c', 'the undone commit stays staged');
		assert.equal((await h.resetToCommit(ctx, { commit: 'HEAD~1', resetMode: 'hard' })).error, null);
		assert.equal(git('status', '--porcelain'), '');
		assert.match((await h.resetToCommit(ctx, { commit: 'HEAD', resetMode: 'bogus' })).error, /Unknown reset mode/);
	});
});

describe('stashes and the working tree', () => {
	test('push, apply, pop, branch from and drop stashes', async () => {
		const { ctx, git, dir } = fixture();
		write(dir, 'a', 'changed\n'); write(dir, 'new', 'untracked\n');
		assert.equal((await h.pushStash(ctx, { message: 'first', includeUntracked: true })).error, null);
		assert.equal(git('status', '--porcelain'), '');
		assert.match(git('stash', 'list'), /first/);
		assert.equal((await h.applyStash(ctx, { selector: 'stash@{0}', reinstateIndex: false })).error, null);
		assert.ok(fs.existsSync(path.join(dir, 'new')));
		git('reset', '-q', '--hard'); git('clean', '-qfd');
		assert.equal((await h.branchFromStash(ctx, { branchName: 'from-stash', selector: 'stash@{0}' })).error, null);
		assert.equal(git('branch', '--show-current'), 'from-stash');
		assert.equal(git('stash', 'list'), '', 'stash branch drops the stash');
		write(dir, 'b', 'again\n');
		await h.pushStash(ctx, { message: '', includeUntracked: false });
		assert.equal((await h.popStash(ctx, { selector: 'stash@{0}', reinstateIndex: false })).error, null);
		await h.pushStash(ctx, { message: 'drop me', includeUntracked: false });
		assert.equal((await h.dropStash(ctx, { selector: 'stash@{0}' })).error, null);
		assert.equal(git('stash', 'list'), '');
	});

	test('clean untracked files, reset one file, create an archive', async () => {
		const { ctx, git, dir } = fixture();
		fs.mkdirSync(path.join(dir, 'tmpdir')); write(dir, 'tmpdir/x', 'x'); write(dir, 'loose', 'l');
		assert.equal((await h.cleanUntrackedFiles(ctx, { directories: true })).error, null);
		assert.equal(git('status', '--porcelain'), '');
		write(dir, 'a', 'edited\n');
		assert.equal((await h.resetFileToRevision(ctx, { commitHash: 'HEAD', filePath: 'a' })).error, null);
		assert.equal(fs.readFileSync(path.join(dir, 'a'), 'utf8'), 'a\n');
		assert.equal((await h.createArchive(ctx, { ref: 'main' })).error, null);
		const zip = path.join(tmpRoot, path.basename(dir) + '-main.zip');
		assert.equal(fs.readFileSync(zip).subarray(0, 2).toString(), 'PK');
	});

	test('worktrees: add with a new branch, list, remove, prune', async () => {
		const { ctx, git } = fixture();
		const wt = path.join(tmpRoot, 'wt' + counter);
		assert.equal((await h.worktreeAdd(ctx, { path: wt, branch: 'main', newBranch: 'wt-branch' })).error, null);
		const list = await h.worktreeList(ctx, { repo: ctx.repo });
		assert.equal(list.worktrees.length, 2);
		assert.deepEqual({ ...list.worktrees[1], path: fs.realpathSync(list.worktrees[1].path) },
			{ path: fs.realpathSync(wt), hash: git('rev-parse', 'main'), branch: 'wt-branch', detached: false, locked: false, prunable: false, isMain: false });
		assert.equal(list.worktrees[0].isMain, true);
		assert.equal((await h.worktreeRemove(ctx, { path: wt, force: false })).error, null);
		assert.equal((await h.worktreePrune(ctx, {})).error, null);
		assert.equal((await h.worktreeList(ctx, { repo: ctx.repo })).worktrees.length, 1);
	});
});

describe('reads', () => {
	test('reflog with dangling entries', async () => {
		const { ctx, git } = fixture();
		const c3 = git('rev-parse', 'HEAD');
		git('reset', '-q', '--hard', 'HEAD~1'); // c3 is now reachable from origin/main only
		git('commit', '-q', '--allow-empty', '-m', 'lost'); const lost = git('rev-parse', 'HEAD');
		git('reset', '-q', '--hard', 'HEAD~1'); // `lost` is reachable from nothing
		const r = await h.reflog(ctx, { repo: ctx.repo, ref: 'HEAD', limit: 2 });
		assert.equal(r.error, null);
		assert.equal(r.moreAvailable, true);
		assert.deepEqual(r.entries.map((e) => [e.selector, e.dangling]), [['HEAD@{0}', false], ['HEAD@{1}', true]]);
		assert.equal(r.entries[1].hash, lost);
		assert.match(r.entries[0].message, /^reset: moving to HEAD~1/);
		assert.ok(r.entries[0].date > 1600000000);
		const all = await h.reflog(ctx, { repo: ctx.repo, ref: 'HEAD', limit: 50 });
		assert.equal(all.moreAvailable, false);
		assert.equal(all.entries.find((e) => e.hash === c3).dangling, false);
	});

	test('predict a clean merge', async () => {
		const { ctx, git } = fixture();
		git('branch', 'other', 'HEAD~1');
		assert.deepEqual((await h.predictConflicts(ctx, { ours: 'main', theirs: 'other' })).prediction, { conflicted: false, files: [] });
	});

	test('repository config: remotes, branches, user (local and global), authors', async () => {
		const { ctx, git, remote } = fixture();
		git('config', 'user.name', 'Local User');
		git('config', 'remote.pushDefault', 'origin');
		const config = await readRepoConfig(ctx);
		assert.deepEqual(config.remotes, [{ name: 'origin', url: remote, pushUrl: null }]);
		assert.deepEqual(config.branches, { main: { remote: 'origin', pushRemote: null } });
		assert.deepEqual(config.user, { name: { local: 'Local User', global: 'Global User' }, email: { local: null, global: 'global@example.com' } });
		assert.equal(config.pushDefault, 'origin');
		assert.deepEqual(config.authors, [{ name: 'Engine Author', email: 'a@example.com' }]);
		const r = await h.loadConfig(ctx, { repo: ctx.repo, refreshId: 7, remotes: [] });
		assert.equal(r.refreshId, 7); assert.equal(r.error, null);
	});

	test('edit and delete user details (global goes to the temp global config)', async () => {
		const { ctx, git } = fixture();
		git('config', 'user.name', 'Old Local');
		const e = await h.editUserDetails(ctx, { name: 'G', email: 'g@example.com', location: 'global', deleteLocalName: true, deleteLocalEmail: true });
		assert.deepEqual(e.errors, [null, null, null, null], 'unsetting an absent key is not an error');
		assert.equal(sh(tmpRoot, 'config', '--global', 'user.name'), 'G');
		assert.equal(gitIn(ctx.repo, ['config', '--local', 'user.name']).exitCode, 1);
		const d = await h.deleteUserDetails(ctx, { name: true, email: false, location: 'global' });
		assert.deepEqual(d.errors, [null]);
		assert.equal(gitIn(tmpRoot, ['config', '--global', 'user.name']).exitCode, 1);
		fs.writeFileSync(globalConfig, '[user]\n\tname = Global User\n\temail = global@example.com\n[init]\n\tdefaultBranch = main\n');
	});
});

describe('data-loss warnings', () => {
	const commit = (git, dir, name) => { write(dir, name, name + '\n'); git('add', name); git('commit', '-qm', 'add ' + name); return git('rev-parse', 'HEAD'); };
	const warned = (r) => r.command === 'lossWarning';

	test('a hard reset over uncommitted changes and unpushed commits warns; confirmed, it runs', async () => {
		const { dir, ctx, git } = fixture();
		const c3 = git('rev-parse', 'HEAD');
		commit(git, dir, 'd'); // not on origin
		write(dir, 'a', 'changed\n');
		const m = { command: 'resetToCommit', repo: dir, commit: c3, resetMode: 'hard' };
		const r = await h.resetToCommit(ctx, m);
		assert.ok(warned(r));
		assert.match(r.message, /1 commit on <b>main<\/b> will be on no branch or tag/);
		assert.match(r.message, /1 uncommitted change to tracked files will be discarded/);
		assert.deepEqual(r.retry, { ...m, confirmed: true });
		assert.notEqual(git('rev-parse', 'HEAD'), c3, 'nothing ran');
		assert.deepEqual(await h.resetToCommit(ctx, r.retry), { command: 'resetToCommit', error: null });
		assert.equal(git('rev-parse', 'HEAD'), c3);
	});

	test('resets that lose nothing just run: commits still on the remote, soft and mixed keep changes', async () => {
		const { dir, ctx, git } = fixture();
		const c1 = git('rev-list', '--max-parents=0', 'HEAD');
		write(dir, 'a', 'changed\n');
		const soft = await h.resetToCommit(ctx, { command: 'resetToCommit', repo: dir, commit: c1, resetMode: 'mixed' });
		assert.deepEqual(soft, { command: 'resetToCommit', error: null }, 'origin/main still holds c2 and c3');
	});

	test('leaving a detached HEAD with commits of its own warns, from every way out', async () => {
		const { dir, ctx, git } = fixture();
		const c1 = git('rev-list', '--max-parents=0', 'HEAD');
		assert.deepEqual(await lossOf(ctx, { command: 'checkoutCommit', commitHash: c1 }), [], 'on a branch: nothing to lose');
		git('checkout', '-q', '--detach');
		assert.deepEqual(await lossOf(ctx, { command: 'checkoutCommit', commitHash: c1 }), [], 'detached on main\'s commit');
		commit(git, dir, 'lonely');
		for (const m of [
			{ command: 'checkoutCommit', commitHash: c1 },
			{ command: 'checkoutBranch', branchName: 'main', remoteBranch: null, pullAfterwards: null },
			{ command: 'createBranch', branchName: 'elsewhere', commitHash: c1, checkout: true, force: false }
		]) {
			const r = await h[m.command](ctx, { repo: dir, ...m });
			assert.ok(warned(r), m.command);
			assert.match(r.message, /HEAD is detached on 1 commit that no branch or tag contains/);
		}
		assert.ok(!warned(await h.createBranch(ctx, { command: 'createBranch', repo: dir, branchName: 'keep', commitHash: c1, checkout: false, force: false })), 'no checkout: HEAD stays');
		const out = await h.checkoutBranch(ctx, { command: 'checkoutBranch', repo: dir, branchName: 'main', remoteBranch: null, pullAfterwards: null, confirmed: true });
		assert.deepEqual(out.errors, [null]);
		assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
	});

	test('force-moving a branch warns about the commits only it holds; names are escaped', async () => {
		const { dir, ctx, git } = fixture();
		const c1 = git('rev-list', '--max-parents=0', 'HEAD');
		git('checkout', '-q', '-b', 'x&y');
		commit(git, dir, 'side');
		git('checkout', '-q', 'main');
		const m = { command: 'createBranch', repo: dir, branchName: 'x&y', commitHash: c1, checkout: false, force: true };
		const r = await h.createBranch(ctx, m);
		assert.ok(warned(r));
		assert.match(r.message, /1 commit of <b>x&amp;y<\/b> will be on no other branch or tag/);
		git('branch', 'copy', 'x&y');
		assert.ok(!warned(await h.createBranch(ctx, m)), 'another branch holds it now');
	});

	test('a force push that drops commits from the remote branch warns; a normal push does not', async () => {
		const { dir, ctx, git } = fixture();
		git('reset', '-q', '--hard', 'HEAD~1');
		const m = { command: 'pushBranch', repo: dir, branchName: 'main', remotes: ['origin'], setUpstream: false, mode: 'force-with-lease', willUpdateBranchConfig: false };
		const r = await h.pushBranch(ctx, m);
		assert.ok(warned(r));
		assert.match(r.message, /1 commit on <b>origin\/main<\/b> are not in <b>main<\/b>/);
		assert.deepEqual(await lossOf(ctx, { ...m, mode: '' }), []);
		assert.deepEqual((await h.pushBranch(ctx, r.retry)).errors, [null]);
		assert.equal(git('rev-parse', 'origin/main'), git('rev-parse', 'main'));
	});

	test('the warning follows the interface language; unsafe values fail as before without a check', async () => {
		const { dir, git } = fixture();
		write(dir, 'a', 'changed\n');
		const zh = { ...makeCtx(dir), config: () => ({ interfaceLanguage: 'zh-cn' }) };
		const r = await h.resetToCommit(zh, { command: 'resetToCommit', repo: dir, commit: 'HEAD', resetMode: 'hard' });
		assert.match(r.message, /已追蹤檔案的 1 處未提交變更將被捨棄/);
		const bad = await h.checkoutCommit(makeCtx(dir), { command: 'checkoutCommit', repo: dir, commitHash: '--upload-pack=x' });
		assert.equal(bad.command, 'checkoutCommit');
		assert.match(bad.error, /must not start with "-"/);
		assert.equal(git('status', '--porcelain'), 'M a');
	});
});

describe('the global author follows the author identities', () => {
	const RESET = '[user]\n\tname = Global User\n\temail = global@example.com\n[init]\n\tdefaultBranch = main\n';
	const global = () => {
		const get = (k) => { const r = gitIn(tmpRoot, ['config', '--global', '--get', k]); return r.exitCode === 0 ? r.stdout.trim() : null; };
		return { name: get('user.name'), email: get('user.email') };
	};
	const ctx = { repo: tmpRoot, git: async (args, opts) => gitIn(tmpRoot, args, opts) };
	const A = { name: 'Ann', email: 'ann@example.com' }, B = { name: 'Bo', email: 'bo@example.com' };
	const G = { name: 'Global User', email: 'global@example.com' };

	test('a global author of the user\'s own is never replaced', async () => {
		fs.writeFileSync(globalConfig, RESET);
		assert.deepEqual(await syncGlobalAuthor(ctx, [], [A, B]), { touched: false, error: null });
		assert.deepEqual(global(), G);
	});

	test('with no global author the first identity becomes it; edits and deletes carry over', async () => {
		fs.writeFileSync(globalConfig, '[init]\n\tdefaultBranch = main\n');
		assert.deepEqual(await syncGlobalAuthor(ctx, [], [A, B]), { touched: true, error: null });
		assert.deepEqual(global(), A);
		assert.deepEqual(await syncGlobalAuthor(ctx, [A, B], [B, A]), { touched: false, error: null }, 'still one of them');
		const A2 = { name: 'Ann Lee', email: 'ann@example.com' };
		assert.equal((await syncGlobalAuthor(ctx, [A, B], [A2, B])).touched, true);
		assert.deepEqual(global(), A2, 'an edit is followed');
		assert.equal((await syncGlobalAuthor(ctx, [A2, B], [B])).touched, true);
		assert.deepEqual(global(), B, 'deleted: the first remaining takes over');
		assert.deepEqual(await syncGlobalAuthor(ctx, [B], []), { touched: true, error: null });
		assert.deepEqual(global(), { name: null, email: null }, 'none left: unset');
		assert.deepEqual(await syncGlobalAuthor(ctx, [], []), { touched: false, error: null });
		fs.writeFileSync(globalConfig, RESET);
	});
});

describe('host conventions', () => {
	test('every git run is non-interactive and takes no optional locks', async () => {
		const seen = [];
		const ctx = { repo: '/r', git: async (args, opts) => { seen.push(opts.env); return { exitCode: 0, stdout: '', stderr: '' }; } };
		await h.pruneRemote(ctx, { name: 'origin' });
		assert.deepEqual(seen, [{ GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0' }]);
	});

	test('the read-only handlers are the ones listed as such', () => {
		for (const command of READ_COMMANDS) assert.ok(command in h, command);
		assert.ok(!READ_COMMANDS.has('fetch') && !READ_COMMANDS.has('merge'));
	});
});
