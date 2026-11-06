/* The webview requests served by the Rust engine (git-graph-core, in-process).
 * Same handler shape as gitops.js: `(ctx, msg) => response`; ctx.engine(method, params) throws
 * the engine's in-band error. Engine methods: upstream native/core/src/dispatch.rs. */
import { readOperationState } from './gitops.js';
import { UNCOMMITTED } from './diffspec.js';

const message = (e) => String((e && e.message) || e);

export const readHandlers = {
	async loadRepoInfo(ctx, m) {
		const operationState = await readOperationState(ctx);
		try {
			const info = await ctx.engine('loadRepoInfo', { showRemoteBranches: m.showRemoteBranches, showRemoteHeads: ctx.config().showRemoteHeads, showStashes: m.showStashes, hideRemotes: m.hideRemotes });
			return { command: 'loadRepoInfo', refreshId: m.refreshId, branches: info.branches, head: info.head, remotes: info.remotes, stashes: info.stashes, isRepo: true, error: info.error, operationState };
		} catch (e) {
			return { command: 'loadRepoInfo', refreshId: m.refreshId, branches: [], head: null, remotes: [], stashes: [], isRepo: true, error: message(e), operationState };
		}
	},

	async loadCommits(ctx, m) {
		const base = { command: 'loadCommits', refreshId: m.refreshId, onlyFollowFirstParent: m.onlyFollowFirstParent, gerritStates: null };
		const config = ctx.config();
		try {
			const data = await ctx.engine('loadCommits', {
				branches: m.branches, authors: m.authors, maxCommits: m.maxCommits, showTags: m.showTags,
				showRemoteBranches: m.showRemoteBranches, showRemoteHeads: config.showRemoteHeads,
				includeCommitsMentionedByReflogs: false, // the engine declines reflog commits (git CLI only)
				onlyFollowFirstParent: m.onlyFollowFirstParent, commitOrdering: m.commitOrdering,
				remotes: m.remotes, hideRemotes: m.hideRemotes,
				filterPaths: m.filterPath ? m.filterPath.split(',').map((p) => p.trim()).filter((p) => p !== '') : [],
				showUncommittedChanges: config.showUncommittedChanges, showUntrackedFiles: config.showUntrackedFiles
			});
			const row = data.commits.length > 0 && data.commits[0].hash === UNCOMMITTED ? data.commits[0] : null;
			const count = row !== null ? parseInt((/\((\d+)\)\s*$/.exec(row.message) || [])[1] || '0', 10) : 0;
			return { ...base, ...data, uncommittedPending: false, uncommittedCount: count };
		} catch (e) {
			return { ...base, commits: [], head: null, tags: [], moreCommitsAvailable: false, error: message(e) };
		}
	},

	async commitDetails(ctx, m) {
		let commitDetails = null, error = null;
		try {
			commitDetails = m.commitHash === UNCOMMITTED
				? await ctx.engine('loadUncommittedDetails')
				: m.stash === null
					? await ctx.engine('loadCommitDetails', { hash: m.commitHash })
					: await ctx.engine('loadStashDetails', { hash: m.commitHash, stash: m.stash });
		} catch (e) {
			error = message(e);
		}
		const codeReview = m.commitHash === UNCOMMITTED ? null : ctx.codeReviews.get(m.commitHash);
		return { command: 'commitDetails', commitDetails, error, avatar: null, codeReview, refresh: m.refresh };
	},

	async commitFileCounts(ctx, m) {
		try {
			return { command: 'commitFileCounts', commitHash: m.commitHash, compareWithHash: m.compareWithHash, counts: await ctx.engine('loadLineCounts', { from: m.from, to: m.to, paths: m.paths }), error: null };
		} catch (e) {
			return { command: 'commitFileCounts', commitHash: m.commitHash, compareWithHash: m.compareWithHash, counts: {}, error: message(e) };
		}
	},

	async commitBodies(ctx, m) {
		let bodies = {};
		try {
			bodies = await ctx.engine('loadCommitBodies', { hashes: m.commitHashes });
		} catch (_) { /* the view keeps the subjects it has */ }
		return { command: 'commitBodies', bodies, requestId: m.requestId };
	},

	async compareCommits(ctx, m) {
		const base = { command: 'compareCommits', commitHash: m.commitHash, compareWithHash: m.compareWithHash, refresh: m.refresh };
		const codeReview = m.toHash === UNCOMMITTED ? null : ctx.codeReviews.get(m.fromHash + '-' + m.toHash);
		try {
			const fileChanges = await ctx.engine('compareCommits', { from: m.fromHash, to: m.toHash === UNCOMMITTED ? '' : m.toHash });
			return { ...base, fileChanges, codeReview, error: null };
		} catch (e) {
			return { ...base, fileChanges: [], codeReview, error: message(e) };
		}
	},

	async countCommitsBefore(ctx, m) {
		let count = null;
		try {
			count = await ctx.engine('countCommitsBefore', { branches: m.branches, hash: m.hash, showRemoteBranches: m.showRemoteBranches, includeReflogs: m.includeCommitsMentionedByReflogs });
		} catch (_) { /* null: the view does without the count (e.g. reflog commits, which the engine declines) */ }
		return { command: 'countCommitsBefore', hash: m.hash, count };
	},

	async tagDetails(ctx, m) {
		try {
			return { command: 'tagDetails', tagName: m.tagName, commitHash: m.commitHash, details: await ctx.engine('loadTagDetails', { tagName: m.tagName }), error: null };
		} catch (e) {
			return { command: 'tagDetails', tagName: m.tagName, commitHash: m.commitHash, details: null, error: message(e) };
		}
	},

	async repoStatistics(ctx, m) {
		let authors = [], activity = [];
		try {
			[authors, activity] = await Promise.all([ctx.engine('authorStats'), ctx.engine('activityHeatmap')]);
		} catch (_) { /* an empty repository has no statistics */ }
		return { command: 'repoStatistics', repo: m.repo, authors, activity };
	}
};
