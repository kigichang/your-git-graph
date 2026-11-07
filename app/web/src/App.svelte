<script lang="ts">
	// The graph window: the repository given on the command line, its graph, the branch
	// filter, the details of what is selected, and the operations (context menus, dialogs).
	// The sidebar and the settings panel come with the later milestones.
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { save } from '@tauri-apps/plugin-dialog';
	import {
		loadCommits, loadRepoInfo, commitDetails, stashDetails, uncommittedDetails, compare, lineCounts, tagDetails, operationState, openDiffWindow,
		defaultLoadOptions, log, UNCOMMITTED, type CommitsResponse, type Commit, type FileChange, type RepoInfo, type LoadOptions, type OpRequest, type OperationKind
	} from './lib/api/client';
	import { diffSpec, fileSpec, workingFileSpec, revisions } from './lib/diffspec';
	import { errorText } from './lib/errors';
	import { isRemote } from './lib/remote';
	import { menuFor, type MenuAction, type MenuItem, type MenuTarget } from './lib/menus';
	import { dialogFor, resetFileDialog, type DialogSpec, type Values } from './lib/dialogs';
	import { ops, runOperation } from './lib/ops.svelte';
	import { settings, watchSettings } from './lib/settings.svelte';
	import GraphTable from './lib/components/GraphTable.svelte';
	import Toolbar from './lib/components/Toolbar.svelte';
	import DetailsPanel, { type DetailsView } from './lib/components/DetailsPanel.svelte';
	import ContextMenu from './lib/components/ContextMenu.svelte';
	import FormDialog from './lib/components/FormDialog.svelte';
	import OpDialogs from './lib/components/OpDialogs.svelte';
	import StatusBar from './lib/components/StatusBar.svelte';

	let repo = $state<string | null>(null);
	let data = $state.raw<CommitsResponse | null>(null);
	let info = $state.raw<RepoInfo | null>(null);
	let inProgress = $state.raw<{ operation: OperationKind; progress: { step: number; total: number } | null; conflicted: string[] } | null>(null);
	let error = $state('');
	let status = $state('');
	let maxCommits = $state(300);
	let branches = $state<string[] | null>(null);
	let showRemoteBranches = $state(true);
	let loading = $state(false);
	let table: ReturnType<typeof GraphTable> | undefined = $state();
	let details = $state.raw<DetailsView | null>(null);
	let detailsFor = ''; // what the panel shows, so a late answer for something else is dropped
	let selected = $state.raw<Commit | null>(null);
	let firstPaintMs = $state<number | null>(null);
	let menu = $state.raw<{ x: number; y: number; items: MenuItem[]; target: MenuTarget } | null>(null);
	let dialog = $state.raw<{ spec: DialogSpec; target: MenuTarget } | null>(null);

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
			const state = await operationState(repo);
			inProgress = state.operation === null ? null : { operation: state.operation, progress: state.progress, conflicted: state.conflictedFiles };
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

	// The file watcher: a change in the shown repository reloads the graph, unless an operation
	// of this window is running or just ended (its own writes come back as changes).
	const ECHO_MS = 1000;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	void listen<{ repos: string[] }>('repo-changed', (event) => {
		if (repo === null || !event.payload.repos.includes(repo)) return;
		if (ops.running !== null || performance.now() - ops.lastEndedAt < ECHO_MS) return;
		if (refreshTimer !== null) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => { refreshTimer = null; void log('watcher: refresh'); void reload(); }, 150);
	});

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
		selected = commit;
		if (again && details !== null) { closeDetails(); return; }
		const r = repo;
		if (commit.hash === UNCOMMITTED) {
			void showDetails('*', async () => ({ kind: 'commit', details: await uncommittedDetails(r), stash: null }));
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

	function onCompare(a: Commit, other: Commit) {
		if (repo === null || data === null) return;
		// The older commit first, so the diff reads old → new; the uncommitted row is newest.
		const older = (c: Commit) => (data as CommitsResponse).commits.indexOf(c);
		const [from, to] = older(a) > older(other) ? [a, other] : [other, a];
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

	/** The revisions the details panel shows a file between. */
	function shownRevisions(): { from: string; to: string } | null {
		if (details === null || details.kind === 'loading' || details.kind === 'error' || details.kind === 'tag') return null;
		if (details.kind === 'compare') return { from: details.from, to: details.to };
		const d = details.details;
		if (details.stash !== null) return { from: d.parents[0] ?? d.hash, to: d.hash };
		return { from: d.hash, to: d.hash };
	}

	/** A file of the details: its change in a diff window, or (⌘-click) the file itself. */
	function openFile(change: FileChange, fileOnly: boolean) {
		const revs = shownRevisions();
		if (repo === null || revs === null) return;
		const spec = fileOnly && change.status !== 'D'
			? fileSpec(repo, revisions(revs.from, revs.to).right, change.newPath)
			: diffSpec(repo, revs.from, revs.to, change.oldPath, change.newPath, change.status);
		openDiffWindow(spec).catch((e) => log('diff window: ' + errorText(e)));
	}

	/* ---------- Menus, dialogs, operations ---------- */

	function onContextMenu(e: MouseEvent, target: MenuTarget) {
		if (repo === null) return;
		const staged = false; // known with the uncommitted details (M6: a status read)
		const items = menuFor(target, { hasSelection: selected !== null && 'commit' in target && selected.hash !== target.commit.hash, remote: isRemote(repo), staged: staged || target.kind === 'commit' });
		menu = { x: e.clientX, y: e.clientY, items, target };
	}

	function onFileMenu(e: MouseEvent, change: FileChange) {
		onContextMenu(e, { kind: 'file', change });
	}

	const copy = (text: string) => invoke('clipboard_write', { text }).catch((e) => log('clipboard: ' + errorText(e)));

	async function doAction(action: MenuAction, target: MenuTarget) {
		if (repo === null) return;
		const r = repo;
		const commit = 'commit' in target ? target.commit : null;
		switch (action) {
			case 'refresh': return void reload();
			case 'copyHash': return void copy(commit?.hash ?? '');
			case 'copySubject': return void copy(commit?.message ?? '');
			case 'copyName': return void copy(target.kind === 'stash' ? target.selector : 'name' in target ? target.name : '');
			case 'copyPath': return void copy(target.kind === 'file' ? target.change.newPath : '');
			case 'compare': if (commit && selected) onCompare(selected, commit); return;
			case 'viewTag': if (target.kind === 'tag') onTag(target.name); return;
			case 'openTerminal': return void invoke('open_terminal', { cwd: r, gitArgs: null }).catch((e) => log('terminal: ' + errorText(e)));
			case 'revealFinder': return void invoke('open_path', { path: r, text: null }).catch((e) => log('reveal: ' + errorText(e)));
			case 'checkoutCommit': return void operate({ kind: 'checkoutCommit', commit: commit?.hash ?? '' });
			case 'checkoutBranch': if (target.kind === 'branch') void operate({ kind: 'checkoutBranch', branch: target.name, remoteBranch: null, pullAfterwards: null }); return;
			case 'fixup': return void operate({ kind: 'commitFixup', commit: commit?.hash ?? '' });
			case 'squash': return void operate({ kind: 'commitSquash', commit: commit?.hash ?? '' });
			case 'createArchive': {
				const ref = target.kind === 'tag' ? target.name : (commit?.hash ?? '');
				const name = r.replace(/\/+$/, '').split('/').pop() + '-' + ref.slice(0, target.kind === 'tag' ? undefined : 8).replace(/[^\w.-]+/g, '-') + '.zip';
				const path = await save({ defaultPath: name, filters: [{ name: 'Zip archive', extensions: ['zip'] }] }).catch(() => null);
				if (path !== null) void operate({ kind: 'createArchive', reference: ref, path });
				return;
			}
			case 'viewFile': case 'openFile': case 'diffWithWorking': case 'resetFile': {
				if (target.kind !== 'file') return;
				const revs = shownRevisions();
				if (revs === null) return;
				const at = revisions(revs.from, revs.to).right;
				if (action === 'viewFile') openFile(target.change, true);
				else if (action === 'openFile') void invoke('open_path', { path: r + '/' + target.change.newPath, text: null }).catch((e) => log('open: ' + errorText(e)));
				else if (action === 'diffWithWorking') void openDiffWindow(workingFileSpec(r, at === UNCOMMITTED ? 'HEAD' : at, target.change.newPath)).catch((e) => log('diff window: ' + errorText(e)));
				else dialog = { spec: resetFileDialog(target.change.newPath, at === UNCOMMITTED ? 'HEAD' : at), target };
				return;
			}
			case 'editMessage': {
				// The whole message: from the details when they are up, else read now.
				const d = details !== null && details.kind === 'commit' && details.details.hash === commit?.hash ? details.details : commit ? await commitDetails(r, commit.hash).catch(() => null) : null;
				const spec = dialogFor(action, target, { settings: settings.current, remotes: info?.remotes ?? [], currentBranch: info?.head ?? null, details: d });
				if (spec) dialog = { spec, target };
				return;
			}
			default: {
				const spec = dialogFor(action, target, { settings: settings.current, remotes: info?.remotes ?? [], currentBranch: info?.head ?? null, details: null });
				if (spec) dialog = { spec, target };
				else void log('menu: no dialog for ' + action);
			}
		}
	}

	function onDialogSubmit(values: Values) {
		if (dialog === null) return;
		const built = dialog.spec.build(values);
		dialog = null;
		if ('error' in built) return;
		void operate(built);
	}

	/** Run an operation and reload the graph afterwards (whatever happened: git may have done part). */
	async function operate(request: OpRequest): Promise<boolean> {
		if (repo === null) return false;
		const done = await runOperation(repo, request);
		await reload();
		return done;
	}

	const fetchDialog = () => { if (repo !== null) void doAction('fetch', { kind: 'background' }); };

	// What the self-test and the benchmark reach for.
	(window as unknown as { __gg: unknown }).__gg = {
		app: {
			state: () => ({ repo, data, info, error, status, firstPaintMs, details, branches, settings: settings.current, menu, dialog, inProgress, ops }),
			load,
			table: () => table,
			setBranches: (b: string[] | null) => { branches = b; return reload(); },
			selectRow: (row: number) => table?.select(row),
			compareRows: (a: number, b: number) => { if (data) onCompare(data.commits[a] as Commit, data.commits[b] as Commit); },
			showTag: onTag,
			closeDetails,
			operate,
			action: doAction
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
			onRefresh={reload} onFetch={fetchDialog} />
		{#if data}
			<GraphTable bind:this={table} commits={data.commits} layout={data.layout} head={data.head} currentBranch={info?.head ?? null} more={data.more}
				rowHeight={settings.current.graph.rowHeight} fontSize={settings.current.graph.fontSize} palette={settings.current.graph.colours}
				loadMoreAutomatically={settings.current.commits.loadMoreAutomatically}
				onLoadMore={loadMore} {onSelect} {onCompare} onEscape={closeDetails} {onTag} {onContextMenu} />
		{/if}
		{#if inProgress}
			<StatusBar operation={inProgress.operation} progress={inProgress.progress} conflicted={inProgress.conflicted}
				onContinue={() => inProgress && operate({ kind: 'continueOperation', operation: inProgress.operation })}
				onAbort={() => inProgress && operate({ kind: 'abortOperation', operation: inProgress.operation })} />
		{/if}
		{#if details !== null}
			<DetailsPanel view={details} fileView={settings.current.details.fileView} compactFolders={settings.current.details.compactFolders}
				onClose={closeDetails} onOpenFile={openFile} {onFileMenu} />
		{/if}
	{/if}
	{#if menu}
		<ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => { menu = null; }}
			onPick={(id) => { const target = (menu as { target: MenuTarget }).target; menu = null; void doAction(id, target); }} />
	{/if}
	{#if dialog}
		<FormDialog spec={dialog.spec} onSubmit={onDialogSubmit} onCancel={() => { dialog = null; }} />
	{/if}
	<OpDialogs />
</main>

<style>
	.gg-main { display: flex; flex-direction: column; height: 100vh; }
	.gg-start { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; }
	.gg-start h1 { font-size: 18px; font-weight: 600; margin: 0; }
	.gg-muted { color: var(--gg-descriptionForeground); }
</style>
