// The typed calls into Rust. The request and response types are generated from the Rust ones
// (generated/, written by `cargo test -p gg-backend`); this file only adds the invoke.
import { invoke } from '@tauri-apps/api/core';
import type { LoadOptions } from './generated/LoadOptions';
import type { ReadRequest } from './generated/ReadRequest';
import type { ReadResponse } from './generated/ReadResponse';

export type { Commit } from './generated/Commit';
export type { Layout } from './generated/Layout';
export type { LoadOptions, ReadRequest, ReadResponse };

/** The answer to one read of `repo` (a path, or ssh://… for a repository on another machine). */
export function repoRead(repo: string, request: ReadRequest): Promise<ReadResponse> {
	return invoke<ReadResponse>('repo_read', { repo, request });
}

export type CommitsResponse = Extract<ReadResponse, { kind: 'commits' }>;

export async function loadCommits(repo: string, options: LoadOptions): Promise<CommitsResponse> {
	const answer = await repoRead(repo, { kind: 'commits', options });
	if (answer.kind !== 'commits') throw new Error('unexpected answer ' + answer.kind);
	return answer;
}

/** What the graph loads until the settings say otherwise. */
export function defaultLoadOptions(maxCommits = 300): LoadOptions {
	return {
		maxCommits, branches: null, authors: null, filterPaths: [], order: 'date', firstParentOnly: false,
		showTags: true, showRemoteBranches: true, showRemoteHeads: true, hideRemotes: [],
		showUncommitted: true, showUntracked: true
	};
}

/** The hash of the row that stands for the uncommitted changes. */
export const UNCOMMITTED = '*';

export const log = (line: string): Promise<void> => invoke<void>('host_log', { line }).catch(() => {});
