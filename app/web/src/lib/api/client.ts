// The typed calls into Rust. The request and response types are generated from the Rust ones
// (generated/, written by `cargo test -p gg-backend`); this file only adds the invoke and one
// function per read.
import { invoke, Channel } from '@tauri-apps/api/core';
import type { LoadOptions } from './generated/LoadOptions';
import type { ReadRequest } from './generated/ReadRequest';
import type { ReadResponse } from './generated/ReadResponse';
import type { CommitStash } from './generated/CommitStash';
import type { OpRequest } from './generated/OpRequest';
import type { OpResult } from './generated/OpResult';
import type { OpProgress } from './generated/OpProgress';
import type { DiffSpec } from '../diffspec';

export type { OpRequest, OpResult, OpProgress };
export type { Reason } from './generated/Reason';
export type { OperationKind } from './generated/OperationKind';
export type { ReflogEntry } from './generated/ReflogEntry';
export type { Worktree } from './generated/Worktree';
export type { RepoConfig } from './generated/RepoConfig';
export type { ConflictPrediction } from './generated/ConflictPrediction';

export type { Commit } from './generated/Commit';
export type { CommitStash } from './generated/CommitStash';
export type { Layout } from './generated/Layout';
export type { Details } from './generated/Details';
export type { FileChange } from './generated/FileChange';
export type { FileStatus } from './generated/FileStatus';
export type { LineCounts } from './generated/LineCounts';
export type { Stash } from './generated/Stash';
export type { TagDetails } from './generated/TagDetails';
export type { Author } from './generated/Author';
export type { LoadOptions, ReadRequest, ReadResponse };

/** The hash of the row that stands for the uncommitted changes. */
export const UNCOMMITTED = '*';

/** The answer to one read of `repo` (a path, or ssh://… for a repository on another machine). */
export function repoRead(repo: string, request: ReadRequest): Promise<ReadResponse> {
	return invoke<ReadResponse>('repo_read', { repo, request });
}

type Of<K extends ReadResponse['kind']> = Extract<ReadResponse, { kind: K }>;

async function expect<K extends ReadResponse['kind']>(repo: string, request: ReadRequest, kind: K): Promise<Of<K>> {
	const answer = await repoRead(repo, request);
	if (answer.kind !== kind) throw new Error('unexpected answer ' + answer.kind);
	return answer as Of<K>;
}

export type CommitsResponse = Of<'commits'>;
export type RepoInfo = Of<'repoInfo'>;

export const loadCommits = (repo: string, options: LoadOptions) => expect(repo, { kind: 'commits', options }, 'commits');

export const loadRepoInfo = (repo: string, o: { showRemoteBranches: boolean; showRemoteHeads: boolean; hideRemotes: string[]; showStashes: boolean }) =>
	expect(repo, { kind: 'repoInfo', ...o }, 'repoInfo');

export const commitDetails = async (repo: string, hash: string) => (await expect(repo, { kind: 'commitDetails', hash }, 'details')).details;
export const stashDetails = async (repo: string, hash: string, stash: CommitStash) => (await expect(repo, { kind: 'stashDetails', hash, stash }, 'details')).details;
export const uncommittedDetails = async (repo: string) => (await expect(repo, { kind: 'uncommittedDetails' }, 'details')).details;
export const compare = async (repo: string, from: string, to: string) => (await expect(repo, { kind: 'compare', from, to }, 'compare')).files;
export const lineCounts = async (repo: string, from: string | null, to: string, paths: string[]) =>
	(await expect(repo, { kind: 'lineCounts', from, to, paths }, 'lineCounts')).counts;
export const tagDetails = async (repo: string, name: string) => (await expect(repo, { kind: 'tagDetails', name }, 'tagDetails')).details;
export const countCommitsBefore = async (repo: string, hash: string, branches: string[] | null, showRemoteBranches: boolean) =>
	(await expect(repo, { kind: 'countCommitsBefore', hash, branches, showRemoteBranches }, 'count')).count;
export const authors = async (repo: string) => (await expect(repo, { kind: 'authors' }, 'authors')).authors;
export const operationState = (repo: string) => expect(repo, { kind: 'operationState' }, 'operationState');
export const reflog = (repo: string, reference: string, limit: number) => expect(repo, { kind: 'reflog', reference, limit }, 'reflog');
export const worktrees = async (repo: string) => (await expect(repo, { kind: 'worktreeList' }, 'worktrees')).worktrees;
export const predictConflicts = async (repo: string, ours: string, theirs: string) => (await expect(repo, { kind: 'predictConflicts', ours, theirs }, 'conflictPrediction')).prediction;
export const repoConfig = async (repo: string) => (await expect(repo, { kind: 'repoConfig' }, 'repoConfig')).config;
export const aheadBehind = (repo: string) => expect(repo, { kind: 'aheadBehind' }, 'aheadBehind');

/* ---------- Operations ---------- */

let nextOp = 1;

/** Do `request` to `repo`. `onProgress` sees git's output as it comes. The returned `cancel`
 * stops it (git is killed, nothing more of it runs); `result` is what it came to. Unless
 * `confirmed`, work that would be lost comes back as `needsConfirmation` instead of being done. */
export function repoOp(repo: string, request: OpRequest, options: { confirmed?: boolean; onProgress?: (p: OpProgress) => void } = {}): { result: Promise<OpResult>; cancel: () => Promise<boolean> } {
	const id = 'op-' + nextOp++;
	const channel = new Channel<OpProgress>();
	channel.onmessage = (p) => options.onProgress?.(p);
	const result = invoke<OpResult>('repo_op', { repo, request, confirmed: options.confirmed === true, id, onProgress: channel });
	return { result, cancel: () => invoke<boolean>('repo_op_cancel', { id }) };
}

/** What the graph loads until the settings say otherwise. */
export function defaultLoadOptions(maxCommits = 300): LoadOptions {
	return {
		maxCommits, branches: null, authors: null, filterPaths: [], order: 'date', firstParentOnly: false,
		showTags: true, showRemoteBranches: true, showRemoteHeads: true, hideRemotes: [],
		showUncommitted: true, showUntracked: true, authorDates: true, includeReflog: false
	};
}

/** A diff window for `spec` (web/diff.html). */
export const openDiffWindow = (spec: DiffSpec): Promise<void> => invoke<void>('open_diff_window', { spec: JSON.stringify(spec), title: spec.title });

export const log = (line: string): Promise<void> => invoke<void>('host_log', { line }).catch(() => {});
