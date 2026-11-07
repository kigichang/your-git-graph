<script lang="ts">
	// The graph window. M1: the repository given on the command line, its commits in the
	// table with the graph, load more, and the timings the performance gate needs.
	import { invoke } from '@tauri-apps/api/core';
	import { loadCommits, defaultLoadOptions, log, type CommitsResponse, type Commit } from './lib/api/client';
	import GraphTable from './lib/components/GraphTable.svelte';

	let repo = $state<string | null>(null);
	let data = $state.raw<CommitsResponse | null>(null);
	let error = $state('');
	let status = $state('');
	let maxCommits = $state(300);
	let loading = $state(false);
	let table: ReturnType<typeof GraphTable> | undefined = $state();
	let selected = $state<Commit | null>(null);
	let firstPaintMs = $state<number | null>(null);

	async function load(max: number) {
		if (repo === null || loading) return;
		loading = true;
		const started = performance.now();
		try {
			let answer: CommitsResponse;
			try {
				answer = await loadCommits(repo, defaultLoadOptions(max));
			} catch (e) {
				// Not a repository itself: the first one found in the folder.
				const found = await invoke<string[]>('scan_repos', { folder: repo });
				if (found.length === 0) throw e;
				repo = found[0] as string;
				answer = await loadCommits(repo, defaultLoadOptions(max));
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
		} catch (e) {
			error = String((e as { message?: string })?.message ?? e);
		} finally {
			loading = false;
		}
	}

	async function open(folder: string) {
		repo = folder;
		await load(300);
		if (error === '') await invoke('repo_opened', { folder: repo, repos: [repo] }).catch(() => {});
	}

	invoke<string[]>('initial_repo').then((folders) => { if (folders[0] !== undefined) void open(folders[0]); }, () => {});

	const loadMore = () => load(maxCommits + 100);

	// What the self-test and the benchmark reach for.
	(window as unknown as { __gg: unknown }).__gg = {
		app: {
			state: () => ({ repo, data, error, status, firstPaintMs, selected }),
			load,
			table: () => table
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
		<div class="gg-toolbar">
			<span class="gg-repo">{repo}</span>
			<span class="gg-muted gg-status">{error || status}</span>
		</div>
		{#if data}
			<GraphTable bind:this={table} commits={data.commits} layout={data.layout} head={data.head} more={data.more}
				onLoadMore={loadMore} onSelect={(_, c) => { selected = c; }} />
		{/if}
	{/if}
</main>

<style>
	.gg-main { display: flex; flex-direction: column; height: 100vh; }
	.gg-start { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; }
	.gg-start h1 { font-size: 18px; font-weight: 600; margin: 0; }
	.gg-muted { color: var(--gg-descriptionForeground); }
	.gg-toolbar {
		flex: none; display: flex; align-items: center; gap: 12px; padding: 6px 10px;
		border-bottom: 1px solid var(--gg-panel-border); background: var(--gg-editorWidget-background); white-space: nowrap;
	}
	.gg-repo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
	.gg-status { overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
</style>
