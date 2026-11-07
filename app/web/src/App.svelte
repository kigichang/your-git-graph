<script lang="ts">
	// The graph window: the repository given on the command line, its graph, the branch
	// filter, and the details of what is selected (M2). The sidebar, settings and the
	// operations come with the later milestones.
	import { invoke } from '@tauri-apps/api/core';
	import {
		loadCommits, loadRepoInfo, commitDetails, stashDetails, uncommittedDetails, compare, lineCounts, tagDetails, openDiffWindow,
		defaultLoadOptions, log, UNCOMMITTED, type CommitsResponse, type Commit, type FileChange, type RepoInfo, type LoadOptions
	} from './lib/api/client';
	import { diffSpec, fileSpec, revisions } from './lib/diffspec';
	import { errorText } from './lib/errors';
	import GraphTable from './lib/components/GraphTable.svelte';
	import Toolbar from './lib/components/Toolbar.svelte';
	import DetailsPanel, { type DetailsView } from './lib/components/DetailsPanel.svelte';
	import { settings, watchSettings } from './lib/settings.svelte';

	let repo = $state<string | null>(null);
	let data = $state.raw<CommitsResponse | null>(null);
	let info = $state.raw<RepoInfo | null>(null);
	let error = $state('');
	let status = $state('');
	let maxCommits = $state(300);
	let branches = $state<string[] | null>(null);
	let showRemoteBranches = $state(true);
	let loading = $state(false);
	let table: ReturnType<typeof GraphTable> | undefined = $state();
	let details = $state.raw<DetailsView | null>(null);
	let detailsFor = ''; // what the panel shows, so a late answer for something else is dropped
	let firstPaintMs = $state<number | null>(null);

	const options = (max: number): LoadOptions => {
		const s = settings.current;
		return {
			...defaultLoadOptions(max), branches, showRemoteBranches, order: s.commits.order,
			showRemoteHeads: s.repository.showRemoteHeads, showUncommitted: s.commits.showUncommitted, showUntracked: s.commits.showUntracked
		};
	};

	async function load(max: number) {
		if (repo === null || loading) return;
		loading = true;
		const started = performance.now();
		try {
			let answer: CommitsResponse;
			try {
				answer = await loadCommits(repo, options(max));
			} catch (e) {
				// Not a repository itself: the first one found in the folder.
				const found = await invoke<string[]>('scan_repos', { folder: repo });
				if (found.length === 0) throw e;
				repo = found[0] as string;
				answer = await loadCommits(repo, options(max));
			}
			const requestMs = performance.now() - started;
			data = answer;
			maxCommits = max;
			error = '';
			const t = answer.timing;
			status = `${answer.commits.length} commits${answer.more ? ' (more available)' : ''} · engine ${t.engineMs.toFixed(0)} ms · layout ${t.layoutMs.toFixed(1)} ms · request ${requestMs.toFixed(0)} ms · ${answer.layout.lanes} lanes`;
			void log('graph: ' + status);
			if (firstPaintMs === null) {
				requestAnimationFrame(() => {
					firstPaintMs = performance.now();
					void log(`graph: first paint at ${firstPaintMs.toFixed(0)} ms since navigation`);
				});
			}
			info = await loadRepoInfo(repo, { showRemoteBranches, showRemoteHeads: true, hideRemotes: [], showStashes: true });
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}

	async function open(folder: string) {
		repo = folder;
		await load(settings.current.commits.initialLoad);
		if (error === '') await invoke('repo_opened', { folder: repo, repos: [repo] }).catch(() => {});
	}

	// The settings first (they decide what is loaded), then the folder from the command line.
	// A later change of the settings reloads the graph with them.
	let settingsSeen = '';
	watchSettings().then((s) => {
		settingsSeen = JSON.stringify(s);
		showRemoteBranches = s.repository.showRemoteBranches;
		settings.onChange((next) => {
			const text = JSON.stringify(next);
			if (text === settingsSeen) return;
			settingsSeen = text;
			void reload();
		});
		invoke<string[]>('initial_repo').then((folders) => { if (folders[0] !== undefined) void open(folders[0]); }, () => {});
	});

	const reload = () => load(maxCommits);
	const loadMore = () => load(maxCommits + settings.current.commits.loadMore);

	/* ---------- The details panel ---------- */

	/** Show `view` once `work` answers, unless something else was asked for meanwhile. */
	async function showDetails(key: string, work: () => Promise<DetailsView>) {
		detailsFor = key;
		details = { kind: 'loading' };
		try {
			const view = await work();
			if (detailsFor === key) details = view;
		} catch (e) {
			if (detailsFor === key) details = { kind: 'error', message: errorText(e) };
		}
	}

	/** The `+n −m` of a commit's files, filled in after the details are shown. */
	async function countLines(key: string, from: string | null, to: string, files: FileChange[]) {
		if (repo === null || files.length === 0 || to === UNCOMMITTED) return;
		try {
			const counts = await lineCounts(repo, from, to, files.map((f) => f.newPath));
			if (detailsFor !== key || details === null || details.kind === 'loading' || details.kind === 'error' || details.kind === 'tag') return;
			const counted = files.map((f) => ({ ...f, ...(counts[f.newPath] ?? {}) }));
			details = details.kind === 'compare' ? { ...details, files: counted } : { ...details, details: { ...details.details, files: counted } };
		} catch (e) {
			void log('line counts: ' + errorText(e));
		}
	}

	function onSelect(_row: number, commit: Commit, again: boolean) {
		if (repo === null) return;
		if (again && details !== null) { closeDetails(); return; }
		const r = repo;
		if (commit.hash === UNCOMMITTED) {
			void showDetails('*', async () => {
				const d = await uncommittedDetails(r);
				return { kind: 'commit', details: d, stash: null };
			});
		} else if (commit.stash !== null) {
			const stash = commit.stash;
			void showDetails(commit.hash, async () => {
				const d = await stashDetails(r, commit.hash, stash);
				void countLines(commit.hash, stash.baseHash, commit.hash, d.files);
				return { kind: 'commit', details: d, stash: stash.selector };
			});
		} else {
			void showDetails(commit.hash, async () => {
				const d = await commitDetails(r, commit.hash);
				void countLines(commit.hash, d.parents[0] ?? null, commit.hash, d.files);
				return { kind: 'commit', details: d, stash: null };
			});
		}
	}

	function onCompare(selected: Commit, other: Commit) {
		if (repo === null || data === null) return;
		// The older commit first, so the diff reads old → new; the uncommitted row is newest.
		const older = (c: Commit) => (data as CommitsResponse).commits.indexOf(c);
		const [from, to] = older(selected) > older(other) ? [selected, other] : [other, selected];
		const r = repo, key = from.hash + '..' + to.hash;
		void showDetails(key, async () => {
			const files = await compare(r, from.hash, to.hash);
			void countLines(key, from.hash, to.hash, files);
			return { kind: 'compare', from: from.hash, to: to.hash, files };
		});
	}

	function onTag(name: string) {
		if (repo === null) return;
		const r = repo;
		void showDetails('tag:' + name, async () => ({ kind: 'tag', name, details: await tagDetails(r, name) }));
	}

	function closeDetails() {
		details = null;
		detailsFor = '';
	}

	/** A file of the details: its change in a diff window, or (⌘-click) the file itself. */
	function openFile(change: FileChange, fileOnly: boolean) {
		if (repo === null || details === null || details.kind === 'loading' || details.kind === 'error' || details.kind === 'tag') return;
		const [from, to] = details.kind === 'compare' ? [details.from, details.to]
			: details.stash !== null ? [details.details.parents[0] ?? details.details.hash, details.details.hash]
				: [details.details.hash, details.details.hash];
		const spec = fileOnly && change.status !== 'D'
			? fileSpec(repo, revisions(from, to).right, change.newPath)
			: diffSpec(repo, from, to, change.oldPath, change.newPath, change.status);
		openDiffWindow(spec).catch((e) => log('diff window: ' + errorText(e)));
	}

	// What the self-test and the benchmark reach for.
	(window as unknown as { __gg: unknown }).__gg = {
		app: {
			state: () => ({ repo, data, info, error, status, firstPaintMs, details, branches, settings: settings.current }),
			load,
			table: () => table,
			setBranches: (b: string[] | null) => { branches = b; return reload(); },
			selectRow: (row: number) => table?.select(row),
			compareRows: (a: number, b: number) => { if (data) onCompare(data.commits[a] as Commit, data.commits[b] as Commit); },
			showTag: onTag,
			closeDetails
		}
	};
</script>

<main class="gg-main">
	{#if repo === null}
		<div class="gg-start">
			<h1>Your Git Graph</h1>
			<p class="gg-muted">{error || 'No repository open.'}</p>
		</div>
	{:else}
		<Toolbar {repo} branches={info?.branches ?? []} selected={branches} {showRemoteBranches} status={error || status}
			onBranches={(b) => { branches = b; void reload(); }}
			onShowRemoteBranches={(on) => { showRemoteBranches = on; void reload(); }}
			onRefresh={reload} />
		{#if data}
			<GraphTable bind:this={table} commits={data.commits} layout={data.layout} head={data.head} more={data.more}
				rowHeight={settings.current.graph.rowHeight} fontSize={settings.current.graph.fontSize} palette={settings.current.graph.colours}
				loadMoreAutomatically={settings.current.commits.loadMoreAutomatically}
				onLoadMore={loadMore} {onSelect} {onCompare} onEscape={closeDetails} {onTag} />
		{/if}
		{#if details !== null}
			<DetailsPanel view={details} fileView={settings.current.details.fileView} compactFolders={settings.current.details.compactFolders}
				onClose={closeDetails} onOpenFile={openFile} />
		{/if}
	{/if}
</main>

<style>
	.gg-main { display: flex; flex-direction: column; height: 100vh; }
	.gg-start { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; }
	.gg-start h1 { font-size: 18px; font-weight: 600; margin: 0; }
	.gg-muted { color: var(--gg-descriptionForeground); }
</style>
