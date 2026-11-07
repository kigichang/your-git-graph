<script lang="ts">
	// The graph window: the sidebar's repositories (shared by every window), the one shown
	// here with its graph and details, the operations, and the ways a repository gets in
	// (the command line, File > Open, the sidebar, a folder dropped on the window, a machine
	// over ssh, a share).
	import { tick } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { getCurrentWebview } from '@tauri-apps/api/webview';
	import { open as pickFolders, save } from '@tauri-apps/plugin-dialog';
	import {
		loadCommits, loadRepoInfo, commitDetails, stashDetails, uncommittedDetails, compare, lineCounts, tagDetails, operationState, aheadBehind, openDiffWindow,
		authors as readAuthors, repoConfig as readRepoConfig, countCommitsBefore,
		defaultLoadOptions, log, UNCOMMITTED, type CommitsResponse, type Commit, type FileChange, type RepoInfo, type LoadOptions, type OpRequest, type OperationKind, type RepoConfig, type Worktree
	} from './lib/api/client';
	import { diffSpec, fileSpec, workingFileSpec, revisions } from './lib/diffspec';
	import { errorText } from './lib/errors';
	import { isRemote } from './lib/remote';
	import { menuFor, type MenuAction, type MenuItem, type MenuTarget } from './lib/menus';
	import { dialogFor, resetFileDialog, type DialogSpec, type Values } from './lib/dialogs';
	import { addRemoteDialog, connectServerDialog, groupNameDialog, remoteName, remoteRoot, type RemoteAnswer } from './lib/addremote';
	import { addRepos, removeRepos as removeFromList, removeGroup, renameGroup, moveManyToGroup, DEFAULT_GROUP, type SidebarState } from './lib/sidebar';
	import { ops, runOperation } from './lib/ops.svelte';
	import { settings, watchSettings } from './lib/settings.svelte';
	import { appState, loadState } from './lib/state.svelte';
	import { t, setLanguage, languageFor } from './lib/i18n';
	import { findRows, stepMatch } from './lib/find';
	import { DEFAULT_REPO_STATE, REPO_CONFIG_FILE, exportRepoConfig, importRepoConfig, repoStateFrom, type RepoState } from './lib/repoconfig';
	import GraphTable from './lib/components/GraphTable.svelte';
	import Toolbar from './lib/components/Toolbar.svelte';
	import DetailsPanel, { type DetailsView } from './lib/components/DetailsPanel.svelte';
	import ContextMenu from './lib/components/ContextMenu.svelte';
	import FormDialog from './lib/components/FormDialog.svelte';
	import OpDialogs from './lib/components/OpDialogs.svelte';
	import StatusBar from './lib/components/StatusBar.svelte';
	import Sidebar, { type RepoStatus, type SidebarTarget } from './lib/components/Sidebar.svelte';
	import StartPage from './lib/components/StartPage.svelte';
	import AskpassDialog from './lib/components/AskpassDialog.svelte';
	import FindWidget from './lib/components/FindWidget.svelte';
	import ReflogPanel from './lib/components/ReflogPanel.svelte';
	import WorktreePanel from './lib/components/WorktreePanel.svelte';
	import SettingsPanel from './lib/components/SettingsPanel.svelte';

	let repo = $state<string | null>(null);
	let data = $state.raw<CommitsResponse | null>(null);
	let info = $state.raw<RepoInfo | null>(null);
	let inProgress = $state.raw<{ operation: OperationKind; progress: { step: number; total: number } | null; conflicted: string[] } | null>(null);
	/** The index has changes to commit (fixup and squash need some). */
	let staged = $state(false);
	let error = $state('');
	let status = $state('');
	let maxCommits = $state(300);
	let branches = $state<string[] | null>(null);
	let authorFilter = $state<string[] | null>(null);
	let authorNames = $state<string[]>([]);
	let showRemoteBranches = $state(true);
	let firstParentOnly = $state(false);
	let panel = $state<'reflog' | 'worktrees' | null>(null);
	let settingsOpen = $state(false);
	let repoConfig = $state.raw<RepoConfig | null>(null);
	let worktreeVersion = $state(0);
	let find = $state<{ open: boolean; query: string; caseSensitive: boolean; regex: boolean; index: number }>({ open: false, query: '', caseSensitive: false, regex: false, index: -1 });
	let findWidget: ReturnType<typeof FindWidget> | undefined = $state();
	const findMatches = $derived(data === null || !find.open ? [] : findRows(data.commits, find.query, { caseSensitive: find.caseSensitive, regex: find.regex }));
	const highlighted = $derived(new Set(findMatches));
	let loading = $state(false);
	let table: ReturnType<typeof GraphTable> | undefined = $state();
	let details = $state.raw<DetailsView | null>(null);
	let detailsFor = ''; // what the panel shows, so a late answer for something else is dropped
	let selected = $state.raw<Commit | null>(null);
	/** Where the open details are: chosen as they open (`details.location`), kept until closed. */
	let detailsWhere = $state<'bottom' | 'inline'>('bottom');
	let detailsHeight = $state(280);
	/** The commit whose row the details belong to (the newer one of a comparison, a tag's). */
	let detailsAt = $state<string | null>(null);
	/** The row the details are shown below when inline; -1 docks them at the bottom (also when
	 * that row is not loaded). */
	const inlineRow = $derived(details !== null && detailsWhere === 'inline' && detailsAt !== null && data !== null ? data.commits.findIndex((c) => c.hash === detailsAt) : -1);
	let firstPaintMs = $state<number | null>(null);
	let menu = $state.raw<{ x: number; y: number; items: MenuItem[]; onPick: (id: string) => void } | null>(null);
	let dialog = $state.raw<{ spec: DialogSpec<unknown>; onDone: (built: unknown) => void } | null>(null);
	let repoStatus = $state<Record<string, RepoStatus>>({});
	let recent = $state<string[]>([]);
	let booted = $state(false);

	const sidebar = $derived(appState.sidebar);
	const windowLabel = getCurrentWindow().label;

	const options = (max: number): LoadOptions => {
		const s = settings.current;
		return {
			...defaultLoadOptions(max), branches, authors: authorFilter, showRemoteBranches, firstParentOnly, order: repoState().order ?? s.commits.order,
			hideRemotes: repoState().hiddenRemotes, showRemoteHeads: s.repository.showRemoteHeads, showUncommitted: s.commits.showUncommitted, showUntracked: s.commits.showUntracked,
			authorDates: s.commits.dateType === 'author', includeReflog: s.commits.includeReflog
		};
	};

	/* ---------- Per-repository state (state.json "repo:<repo>") ---------- */

	const repoState = (): RepoState => (repo === null ? DEFAULT_REPO_STATE : repoStateFrom(appState.get('repo:' + repo)));
	function saveRepoState(patch: Partial<RepoState>) {
		if (repo === null) return;
		appState.set('repo:' + repo, { ...repoState(), ...patch });
	}
	/** The repository's own view settings, and its config file when it is newer than what was taken before. */
	async function restoreRepoState(r: string) {
		let st = repoStateFrom(appState.get('repo:' + r));
		try {
			const file = await invoke<{ exists: boolean; text?: string | null }>('worktree_file', { repo: r, path: REPO_CONFIG_FILE });
			if (file.exists && typeof file.text === 'string') {
				const imported = importRepoConfig(st, file.text);
				if (imported !== null) { st = imported; appState.set('repo:' + r, st); void log('repo config: imported ' + REPO_CONFIG_FILE); }
			}
		} catch (e) {
			void log('repo config: ' + errorText(e));
		}
		branches = st.branches;
		authorFilter = st.authors;
		showRemoteBranches = st.showRemoteBranches;
		firstParentOnly = st.firstParentOnly;
	}
	/** Write the repository's config file (Export Repository Configuration, in the settings):
	 * the path written, or null when the file exists already (it is never written over). */
	async function exportRepoState(): Promise<string | null> {
		if (repo === null) return null;
		const existing = await invoke<{ exists: boolean }>('worktree_file', { repo, path: REPO_CONFIG_FILE }).catch(() => ({ exists: false }));
		if (existing.exists) return null;
		const now = Math.floor(Date.now() / 1000);
		const path = await invoke<string>('export_repo_config', { repo, contents: exportRepoConfig(repoState(), now) });
		saveRepoState({ lastImportAt: now });
		return path;
	}

	/* ---------- Loading the shown repository ---------- */

	async function load(max: number): Promise<boolean> {
		if (repo === null || loading) return false;
		loading = true;
		const started = performance.now();
		const r = repo;
		try {
			const answer = await loadCommits(r, options(max));
			if (repo !== r) return false; // switched meanwhile
			const requestMs = performance.now() - started;
			data = answer;
			maxCommits = max;
			error = '';
			const tm = answer.timing;
			status = `${answer.commits.length} commits${answer.more ? ' (more available)' : ''} · engine ${tm.engineMs.toFixed(0)} ms${tm.reflogMs > 0 ? ` · reflog ${tm.reflogMs.toFixed(0)} ms` : ''}${tm.datesMs > 0 ? ` · author dates ${tm.datesMs.toFixed(0)} ms` : ''} · layout ${tm.layoutMs.toFixed(1)} ms · request ${requestMs.toFixed(0)} ms · ${answer.layout.lanes} lanes`;
			void log('graph: ' + status);
			if (firstPaintMs === null) {
				requestAnimationFrame(() => {
					firstPaintMs = performance.now();
					void log(`graph: first paint at ${firstPaintMs.toFixed(0)} ms since navigation`);
				});
			}
			info = await loadRepoInfo(r, { showRemoteBranches, showRemoteHeads: true, hideRemotes: [], showStashes: true });
			const state = await operationState(r);
			inProgress = state.operation === null ? null : { operation: state.operation, progress: state.progress, conflicted: state.conflictedFiles };
			staged = state.staged;
			setStatus(r, { missing: false, note: undefined });
			return true;
		} catch (e) {
			if (repo === r) error = errorText(e);
			return false;
		} finally {
			if (repo === r) loading = false;
		}
	}

	const reload = () => load(maxCommits);
	const loadMore = () => load(maxCommits + settings.current.commits.loadMore);

	function setStatus(r: string, patch: RepoStatus) {
		repoStatus = { ...repoStatus, [r]: { ...(repoStatus[r] ?? {}), ...patch } };
	}

	/** Tell Rust what this window shows and the list it watches. */
	const reportShown = () => repo !== null && invoke('repo_opened', { folder: repo, repos: sidebar.repos }).catch((e) => log('repo_opened: ' + errorText(e)));

	/* ---------- The sidebar's list ---------- */

	/** Settled once Rust has the new list: it serves only the sidebar's repositories. */
	function saveSidebar(next: SidebarState): Promise<void> {
		return appState.set('sidebar', next);
	}

	/** Show `r` in this window: connect (ssh) or mount (a share) when it is not reachable,
	 * then load it; a failure dims it in the sidebar with the reason. */
	async function show(r: string): Promise<boolean> {
		closeDetails();
		menu = null;
		try {
			if (isRemote(r)) {
				await invoke('remote_connect', { repo: r });
			} else if (repoStatus[r]?.missing && appState.mounts[r] !== undefined) {
				await invoke('mount_volume', { url: appState.mounts[r] });
			}
		} catch (e) {
			setStatus(r, { missing: true, note: errorText(e) });
			error = errorText(e);
			return false;
		}
		repo = r;
		data = null;
		info = null;
		selected = null;
		error = '';
		panel = null;
		appState.set('lastActiveRepo', r);
		await restoreRepoState(r);
		const ok = await load(settings.current.commits.initialLoad);
		if (!ok) { setStatus(r, { missing: true, note: error }); return false; }
		void reportShown();
		void updateAheadBehind([r]);
		if (!isRemote(r)) {
			const share = await invoke<string | null>('network_volume', { path: r }).catch(() => null);
			const mounts = { ...appState.mounts };
			if (share && mounts[r] !== share) { mounts[r] = share; appState.set('mounts', mounts); }
		}
		recent = await invoke<string[]>('recent_repos').catch(() => recent);
		authorNames = await readAuthors(r).then((list) => list.map((a) => a.name)).catch(() => []);
		return true;
	}

	/** Add `paths` (folders, or ssh:// names) to the sidebar and show the last one: a folder
	 * inside a repository adds that repository; a folder of repositories adds all it holds. */
	async function addAndShow(paths: string[]) {
		const found: string[] = [];
		for (const path of paths) {
			if (isRemote(path)) { found.push(path); continue; }
			const inside = await invoke<string[]>('scan_repos', { folder: path }).catch(() => []);
			if (inside.length === 0) found.push(path); else found.push(...inside);
		}
		if (found.length === 0) return;
		await saveSidebar({ ...sidebar, repos: addRepos(sidebar.repos, found) });
		await show(found[found.length - 1] as string);
	}

	async function removeRepos(repos: string[]) {
		const { list, show: next } = removeFromList(sidebar.repos, repos, repo);
		const groupOf = { ...sidebar.groupOf };
		for (const r of repos) delete groupOf[r];
		saveSidebar({ ...sidebar, repos: list, groupOf });
		const mounts = { ...appState.mounts };
		let changed = false;
		for (const r of repos) if (mounts[r] !== undefined) { delete mounts[r]; changed = true; }
		if (changed) appState.set('mounts', mounts);
		if (next !== repo) {
			if (next === null) { repo = null; data = null; info = null; closeDetails(); appState.set('lastActiveRepo', null); }
			else await show(next);
		}
		void reportShown();
	}

	/** Ahead/behind of the given local (or connected) repositories; one that cannot be read is dimmed. */
	async function updateAheadBehind(repos: string[]) {
		for (const r of repos) {
			if (isRemote(r) && r !== repo && repoStatus[r]?.missing) continue;
			try {
				const ab = await aheadBehind(r);
				setStatus(r, { ahead: ab.ahead, behind: ab.behind, missing: false });
			} catch (e) {
				if (r !== repo) setStatus(r, { missing: true, note: errorText(e) });
			}
		}
	}

	/* ---------- Boot ---------- */

	async function boot() {
		await Promise.all([loadState(), watchSettings()]);
		// The graph is loaded again only when a setting that decides what is loaded changed; the
		// others (the look, the language, the log, …) apply where they are shown.
		const loadKey = (s: typeof settings.current) => {
			const { markdown: _m, dateFormat: _f, loadMoreAutomatically: _a, ...commits } = s.commits;
			return JSON.stringify({ commits, repository: s.repository });
		};
		let settingsSeen = loadKey(settings.current);
		showRemoteBranches = settings.current.repository.showRemoteBranches;
		setLanguage(languageFor(settings.current.language));
		settings.onChange((next) => {
			setLanguage(languageFor(next.language));
			const text = loadKey(next);
			if (text === settingsSeen) return;
			settingsSeen = text;
			void reload();
		});
		recent = await invoke<string[]>('recent_repos').catch(() => []);
		const savedFind = appState.get<{ caseSensitive?: boolean; regex?: boolean }>('find');
		if (savedFind) find = { ...find, caseSensitive: savedFind.caseSensitive === true, regex: savedFind.regex === true };
		// What this window opens with: the folder it was made for, the command line (main), or
		// the repository shown last. Repositories on other machines wait until shown.
		const forThisWindow = (window as unknown as { __GG_OPEN_REPO?: string }).__GG_OPEN_REPO;
		const launched = forThisWindow !== undefined ? [forThisWindow] : windowLabel === 'main' ? await invoke<string[]>('initial_repo').catch(() => []) : [];
		for (const r of sidebar.repos) if (isRemote(r)) setStatus(r, { missing: true, note: t('sidebar.offline') });
		booted = true;
		if (launched.length > 0) await addAndShow(launched);
		else {
			const last = appState.lastActiveRepo;
			const first = last !== null && sidebar.repos.includes(last) ? last : sidebar.repos.find((r) => !isRemote(r)) ?? null;
			if (first !== null) await show(first);
		}
		void updateAheadBehind(sidebar.repos.filter((r) => !isRemote(r) && r !== repo));
	}
	void boot();

	// Folders handed to this window: File > Open and Open Recent, the Dock, `open -a` (Rust's
	// open_folder), and a drop on the window.
	void getCurrentWindow().listen<string>('open-repo', (event) => { void addAndShow([event.payload]); });
	void getCurrentWebview().onDragDropEvent((event) => {
		if (event.payload.type === 'drop') void addAndShow(event.payload.paths);
	});

	// The menu bar's commands for the focused window.
	void getCurrentWindow().listen<string>('menu-command', (event) => {
		switch (event.payload) {
			case 'refresh': void reload(); break;
			case 'fetch': fetchDialog(); break;
			case 'head': void showHead(); break;
			case 'find': openFind(); break;
			case 'settings': openSettings(); break;
			case 'sidebar': saveSidebar({ ...sidebar, collapsed: !sidebar.collapsed }); break;
			case 'addRemote': addRemote(); break;
			case 'addServer': connectServer(); break;
			default: void log('menu-command ' + event.payload + ': not handled yet');
		}
	});

	// Another window changed the shared list: the repository shown here may be gone.
	appState.onChange((key) => {
		if (key !== 'sidebar' || repo === null) return;
		if (!sidebar.repos.includes(repo)) { repo = null; data = null; info = null; closeDetails(); }
		void reportShown();
	});

	// The file watcher: a change in the shown repository reloads the graph, unless an operation
	// of this window is running or just ended (its own writes come back as changes); any listed
	// repository's ahead/behind is recounted.
	const ECHO_MS = 1000;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	void getCurrentWindow().listen<{ repos: string[] }>('repo-changed', (event) => {
		void updateAheadBehind(event.payload.repos.filter((r) => r !== repo));
		if (repo === null || !event.payload.repos.includes(repo)) return;
		if (ops.running !== null || performance.now() - ops.lastEndedAt < ECHO_MS) return;
		if (refreshTimer !== null) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => { refreshTimer = null; void log('watcher: refresh'); void reload(); void updateAheadBehind([repo as string]); }, 150);
	});
	// Changes on another machine or by another one on a share are not watched: look again
	// when the window comes to the front.
	window.addEventListener('focus', () => { if (repo !== null && (isRemote(repo) || appState.mounts[repo] !== undefined)) void reload(); });

	/* ---------- Find, HEAD, the panels ---------- */

	function openFind() {
		find = { ...find, open: true };
		findWidget?.focus();
	}
	function onFindChange(next: { query: string; caseSensitive: boolean; regex: boolean }) {
		find = { ...find, ...next, index: -1 };
		appState.set('find', { caseSensitive: next.caseSensitive, regex: next.regex });
		const rows = data === null ? [] : findRows(data.commits, next.query, { caseSensitive: next.caseSensitive, regex: next.regex });
		if (rows.length > 0) { find.index = 0; table?.select(rows[0] as number); }
	}
	function onFindStep(forward: boolean) {
		const rows = findMatches;
		if (rows.length === 0) return;
		const current = table?.stats().selected ?? -1;
		const i = stepMatch(rows, current, forward);
		find = { ...find, index: i };
		table?.select(rows[i] as number);
	}
	/** Show HEAD's row: loaded, or after loading as far as it (⌘J). */
	async function showHead() {
		if (table?.showHead()) return;
		if (repo === null || data === null || data.head === null || !data.more) return;
		const before = await countCommitsBefore(repo, data.head, branches, showRemoteBranches).catch(() => null);
		if (before === null) return;
		await load(Math.max(maxCommits, before + 50));
		table?.showHead();
	}
	/** Select the row of `hash` when it is loaded. */
	function showCommit(hash: string): boolean {
		const row = data?.commits.findIndex((c) => c.hash === hash) ?? -1;
		if (row < 0) return false;
		table?.select(row);
		return true;
	}
	async function openSettings() {
		if (repo !== null) repoConfig = await readRepoConfig(repo).catch(() => null);
		settingsOpen = true;
	}
	function worktreeAddDialog() {
		if (repo === null) return;
		const spec: DialogSpec<OpRequest> = {
			title: t('worktree.addTitle'), action: t('worktree.add').replace('…', ''),
			fields: [
				{ kind: 'text', id: 'path', label: t('worktree.path'), value: repo.replace(/\/+$/, '') + '-worktree' },
				{ kind: 'text', id: 'branch', label: t('worktree.branch'), value: '', refName: true },
				{ kind: 'text', id: 'newBranch', label: t('worktree.newBranch'), value: '', refName: true }
			],
			build: (v) => {
				const path = String(v['path'] ?? '').trim(), branch = String(v['branch'] ?? '').trim(), newBranch = String(v['newBranch'] ?? '').trim();
				if (path === '') return { error: t('worktree.path') + '?' };
				return { kind: 'worktreeAdd', path, branch: branch === '' ? null : branch, newBranch: newBranch === '' ? null : newBranch };
			}
		};
		dialog = { spec: spec as DialogSpec<unknown>, onDone: (built) => { void operate(built as OpRequest).then(() => { worktreeVersion++; }); } };
	}
	function worktreeRemoveDialog(w: Worktree) {
		const spec: DialogSpec<OpRequest> = {
			title: t('worktree.removeTitle', { name: w.path }), action: t('worktree.remove').replace('…', ''), danger: true,
			fields: [{ kind: 'checkbox', id: 'force', label: t('worktree.force'), value: false }],
			build: (v) => ({ kind: 'worktreeRemove', path: w.path, force: v['force'] === true })
		};
		dialog = { spec: spec as DialogSpec<unknown>, onDone: (built) => { void operate(built as OpRequest).then(() => { worktreeVersion++; }); } };
	}

	/* ---------- The details panel ---------- */

	/** Show `view` once `work` answers, unless something else was asked for meanwhile; `at` is
	 * the commit whose row the details belong to. The row is brought into view (centred as the
	 * details open, with `details.autoCenter`) once the panel has its place. */
	async function showDetails(key: string, at: string | null, work: () => Promise<DetailsView>) {
		const opening = details === null;
		if (opening) detailsWhere = settings.current.details.location;
		detailsFor = key;
		detailsAt = at;
		details = { kind: 'loading' };
		void tick().then(() => {
			const row = at === null || data === null ? -1 : data.commits.findIndex((c) => c.hash === at);
			if (detailsFor === key && row >= 0) table?.showRow(row, opening && settings.current.details.autoCenter);
		});
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

	/** Enter on the selected row: its details, unless they are what the panel shows already. */
	function onOpen(row: number, commit: Commit) {
		if (details === null || detailsFor !== (commit.hash === UNCOMMITTED ? '*' : commit.hash)) onSelect(row, commit, false);
	}

	function onSelect(_row: number, commit: Commit, again: boolean) {
		if (repo === null) return;
		selected = commit;
		if (again && details !== null) { closeDetails(); return; }
		const r = repo;
		if (commit.hash === UNCOMMITTED) {
			void showDetails('*', UNCOMMITTED, async () => ({ kind: 'commit', details: await uncommittedDetails(r), stash: null }));
		} else if (commit.stash !== null) {
			const stash = commit.stash;
			void showDetails(commit.hash, commit.hash, async () => {
				const d = await stashDetails(r, commit.hash, stash);
				void countLines(commit.hash, stash.baseHash, commit.hash, d.files);
				return { kind: 'commit', details: d, stash: stash.selector };
			});
		} else {
			void showDetails(commit.hash, commit.hash, async () => {
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
		void showDetails(key, to.hash, async () => {
			const files = await compare(r, from.hash, to.hash);
			void countLines(key, from.hash, to.hash, files);
			return { kind: 'compare', from: from.hash, to: to.hash, files };
		});
	}

	function onTag(name: string, commit?: Commit) {
		if (repo === null) return;
		const r = repo;
		void showDetails('tag:' + name, commit?.hash ?? null, async () => ({ kind: 'tag', name, details: await tagDetails(r, name) }));
	}

	function closeDetails() {
		details = null;
		detailsFor = '';
		detailsAt = null;
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

	function showMenu(e: MouseEvent, items: MenuItem[], onPick: (id: string) => void) {
		menu = { x: e.clientX, y: e.clientY, items, onPick };
	}

	function onContextMenu(e: MouseEvent, target: MenuTarget) {
		if (repo === null) return;
		const items = menuFor(target, { hasSelection: selected !== null && 'commit' in target && selected.hash !== target.commit.hash, remote: isRemote(repo), staged });
		showMenu(e, items, (id) => { void doAction(id as MenuAction, target); });
	}

	function onFileMenu(e: MouseEvent, change: FileChange) {
		onContextMenu(e, { kind: 'file', change });
	}

	const copy = (text: string) => invoke('clipboard_write', { text }).catch((e) => log('clipboard: ' + errorText(e)));
	const dialogContext = (d: DetailsView | null) => ({ settings: settings.current, remotes: info?.remotes ?? [], currentBranch: info?.head ?? null, details: d !== null && d.kind === 'commit' ? d.details : null });

	function askOp(spec: DialogSpec | null) {
		if (spec === null) return;
		dialog = { spec: spec as DialogSpec<unknown>, onDone: (built) => { void operate(built as OpRequest); } };
	}

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
				else askOp(resetFileDialog(target.change.newPath, at === UNCOMMITTED ? 'HEAD' : at));
				return;
			}
			case 'editMessage': {
				// The whole message: from the details when they are up, else read now.
				const d = details !== null && details.kind === 'commit' && details.details.hash === commit?.hash ? details : null;
				const ctx = dialogContext(d);
				if (ctx.details === null && commit) ctx.details = await commitDetails(r, commit.hash).catch(() => null);
				return askOp(dialogFor(action, target, ctx));
			}
			default: {
				const spec = dialogFor(action, target, dialogContext(null));
				if (spec) askOp(spec); else void log('menu: no dialog for ' + action);
			}
		}
	}

	function onDialogSubmit(values: Values) {
		if (dialog === null) return;
		const built = dialog.spec.build(values);
		const done = dialog.onDone;
		dialog = null;
		if (built !== null && typeof built === 'object' && 'error' in (built as object)) return;
		done(built);
	}

	/** Run an operation and reload the graph afterwards (whatever happened: git may have done part). */
	async function operate(request: OpRequest): Promise<boolean> {
		if (repo === null) return false;
		const done = await runOperation(repo, request);
		await reload();
		void updateAheadBehind([repo]);
		if (settingsOpen) repoConfig = await readRepoConfig(repo).catch(() => null);
		return done;
	}

	const fetchDialog = () => { if (repo !== null) void doAction('fetch', { kind: 'background' }); };

	/* ---------- Adding repositories ---------- */

	async function addLocal() {
		const picked = await pickFolders({ directory: true, multiple: true, title: 'Open Git Repository' }).catch(() => null);
		if (picked) void addAndShow(Array.isArray(picked) ? picked : [picked]);
	}

	function addRemote() {
		dialog = {
			spec: addRemoteDialog() as DialogSpec<unknown>,
			onDone: (built) => {
				const answer = built as RemoteAnswer;
				void (async () => {
					try {
						let name = remoteName(answer, null);
						if (name === null) {
							// A relative path starts from the home directory over there: ask the machine.
							const hello = await invoke<{ home?: string | null }>('remote_connect', { repo: remoteRoot(answer) });
							name = remoteName(answer, hello.home ?? '/');
						}
						if (name !== null) await addAndShow([name]);
					} catch (e) {
						error = errorText(e);
						ops.error = { message: errorText(e), step: null };
					}
				})();
			}
		};
	}

	function connectServer() {
		dialog = {
			spec: connectServerDialog() as DialogSpec<unknown>,
			onDone: (built) => {
				const { url } = built as { url: string };
				void (async () => {
					try {
						const mounted = await invoke<string>('mount_volume', { url });
						const picked = await pickFolders({ directory: true, multiple: true, defaultPath: mounted, title: 'Open Git Repository' }).catch(() => null);
						if (picked) await addAndShow(Array.isArray(picked) ? picked : [picked]);
					} catch (e) {
						ops.error = { message: errorText(e), step: null };
					}
				})();
			}
		};
	}

	/* ---------- The sidebar's menus ---------- */

	function onSidebarMenu(e: MouseEvent, target: SidebarTarget) {
		if (target.kind === 'add') {
			showMenu(e, [{ id: 'addLocal' as MenuAction, label: t('sidebar.addLocal') }, { id: 'addRemote' as MenuAction, label: t('sidebar.addRemote') }, { id: 'addServer' as MenuAction, label: t('sidebar.addServer') }, { separator: true }, { id: 'newGroup' as MenuAction, label: t('sidebar.newGroup') }],
				(id) => { if (id === 'addLocal') void addLocal(); else if (id === 'addRemote') addRemote(); else if (id === 'addServer') connectServer(); else if (id === 'newGroup') groupDialog(null); });
			return;
		}
		if (target.kind === 'group') {
			showMenu(e, [{ id: 'rename' as MenuAction, label: t('sidebar.renameGroup') }, { id: 'delete' as MenuAction, label: t('sidebar.deleteGroup'), danger: true }],
				(id) => { if (id === 'rename') groupDialog(target.name); else { const next = removeGroup(sidebar.groups, sidebar.groupOf, target.name); saveSidebar({ ...sidebar, ...next, foldedGroups: sidebar.foldedGroups.filter((g) => g !== target.name) }); } });
			return;
		}
		const repos = target.repos;
		const one = repos.length === 1 ? (repos[0] as string) : null;
		const items: MenuItem[] = [];
		if (one !== null) {
			items.push({ id: 'newWindow' as MenuAction, label: t('sidebar.newWindow') });
			if (!isRemote(one)) items.push({ id: 'reveal' as MenuAction, label: t('menu.revealFinder') });
			items.push({ id: 'terminal' as MenuAction, label: t('menu.openTerminal') }, { separator: true });
		}
		for (const group of sidebar.groups) items.push({ id: ('moveTo:' + group) as MenuAction, label: t('sidebar.moveTo', { group }) });
		if (repos.some((r) => sidebar.groupOf[r] !== undefined)) items.push({ id: 'moveTo:' as MenuAction, label: t('sidebar.moveToDefault') });
		if (sidebar.groups.length > 0) items.push({ separator: true });
		items.push({ id: 'remove' as MenuAction, label: t('sidebar.remove'), danger: true });
		showMenu(e, items, (id) => {
			if (id === 'newWindow' && one) void invoke('open_new_window', { repo: one }).catch((e2) => log('new window: ' + errorText(e2)));
			else if (id === 'reveal' && one) void invoke('open_path', { path: one, text: null }).catch(() => {});
			else if (id === 'terminal' && one) void invoke('open_terminal', { cwd: one, gitArgs: null }).catch(() => {});
			else if (id === 'remove') void removeRepos(repos);
			else if (id.startsWith('moveTo:')) {
				const group = id.slice('moveTo:'.length) || null;
				const moved = moveManyToGroup(sidebar.repos, sidebar.groupOf, repos, group, null);
				saveSidebar({ ...sidebar, repos: moved.list, groupOf: moved.groupOf });
			}
		});
	}

	function groupDialog(current: string | null) {
		dialog = {
			spec: groupNameDialog(sidebar.groups, current) as DialogSpec<unknown>,
			onDone: (built) => {
				const { name } = built as { name: string };
				if (current === null) saveSidebar({ ...sidebar, groups: [...sidebar.groups, name] });
				else {
					const next = renameGroup(sidebar.groups, sidebar.groupOf, current, name);
					saveSidebar({ ...sidebar, ...next, foldedGroups: sidebar.foldedGroups.map((g) => (g === current ? name : g)) });
				}
			}
		};
	}

	// What the self-test and the benchmark reach for.
	(window as unknown as { __gg: unknown }).__gg = {
		app: {
			state: () => ({ repo, data, info, error, status, firstPaintMs, details, branches, settings: settings.current, menu, dialog, inProgress, ops, sidebar, repoStatus, recent, booted }),
			load,
			table: () => table,
			setBranches: (b: string[] | null) => { branches = b; return reload(); },
			selectRow: (row: number) => table?.select(row),
			compareRows: (a: number, b: number) => { if (data) onCompare(data.commits[a] as Commit, data.commits[b] as Commit); },
			showTag: onTag,
			closeDetails,
			operate,
			action: doAction,
			addAndShow,
			show,
			removeRepos,
			saveSidebar,
			addRemote,
			connectServer,
			openFind,
			onFindChange,
			onFindStep,
			findMatches: () => findMatches,
			openSettings,
			closeSettings: () => { settingsOpen = false; },
			showPanel: (p: 'reflog' | 'worktrees' | null) => { panel = p; },
			exportRepoState,
			repoState,
			saveRepoState,
			setAuthors: (a: string[] | null) => { authorFilter = a; saveRepoState({ authors: a }); return reload(); }
		}
	};
</script>

<main class="gg-main">
	{#if booted && !sidebar.collapsed && (sidebar.repos.length > 0 || repo !== null)}
		<Sidebar {sidebar} current={repo} status={repoStatus} onSelect={(r) => { void show(r); }} onChange={saveSidebar}
			onContextMenu={onSidebarMenu} onCollapse={() => saveSidebar({ ...sidebar, collapsed: true })} />
	{/if}
	<div class="gg-content">
		{#if repo === null}
			{#if booted}
				<StartPage {recent} {error} onOpen={(r) => { void addAndShow([r]); }} onAddLocal={addLocal} onAddRemote={addRemote} onConnectServer={connectServer} />
			{/if}
		{:else}
			<Toolbar {repo} branches={info?.branches ?? []} selected={branches} authors={authorNames} selectedAuthors={authorFilter} {showRemoteBranches} {firstParentOnly} status={error || status} sidebarCollapsed={sidebar.collapsed}
				onBranches={(b) => { branches = b; saveRepoState({ branches: b }); void reload(); }}
				onAuthors={(a) => { authorFilter = a; saveRepoState({ authors: a }); void reload(); }}
				onShowRemoteBranches={(on) => { showRemoteBranches = on; saveRepoState({ showRemoteBranches: on }); void reload(); }}
				onFirstParent={(on) => { firstParentOnly = on; saveRepoState({ firstParentOnly: on }); void reload(); }}
				onRefresh={reload} onFetch={fetchDialog} onFind={openFind} onReflog={() => { panel = panel === 'reflog' ? null : 'reflog'; }}
				onWorktrees={() => { panel = panel === 'worktrees' ? null : 'worktrees'; }} onSettings={openSettings}
				onExpandSidebar={() => saveSidebar({ ...sidebar, collapsed: false })} />
			{#if find.open}
				<FindWidget bind:this={findWidget} query={find.query} caseSensitive={find.caseSensitive} regex={find.regex} count={findMatches.length} index={find.index}
					onChange={onFindChange} onStep={onFindStep} onClose={() => { find = { ...find, open: false }; }} />
			{/if}
			{#snippet inlineDetails()}
				{#if details !== null}
					<DetailsPanel view={details} inline fileView={settings.current.details.fileView} compactFolders={settings.current.details.compactFolders} dateFormat={settings.current.commits.dateFormat}
						markdown={settings.current.commits.markdown} bind:height={detailsHeight} onClose={closeDetails} onOpenFile={openFile} {onFileMenu} />
				{/if}
			{/snippet}
			{#if data}
				<GraphTable bind:this={table} commits={data.commits} layout={data.layout} head={data.head} currentBranch={info?.head ?? null} more={data.more}
					gapRow={inlineRow} gapHeight={detailsHeight} gap={inlineDetails}
					rowHeight={settings.current.graph.rowHeight} fontSize={settings.current.graph.fontSize} palette={settings.current.graph.colours}
					loadMoreAutomatically={settings.current.commits.loadMoreAutomatically} {highlighted} dateFormat={settings.current.commits.dateFormat}
					combineLabels={settings.current.graph.combineLocalAndRemoteLabels} graphStyle={settings.current.graph.style}
					stickyHeader={settings.current.graph.stickyHeader} markdown={settings.current.commits.markdown}
					onLoadMore={loadMore} {onSelect} {onOpen} {onCompare} onEscape={() => { if (find.open) find = { ...find, open: false }; else closeDetails(); }} {onTag} {onContextMenu} />
			{:else if error}
				<p class="gg-error">{error}</p>
			{/if}
			{#if inProgress}
				<StatusBar operation={inProgress.operation} progress={inProgress.progress} conflicted={inProgress.conflicted}
					onContinue={() => inProgress && operate({ kind: 'continueOperation', operation: inProgress.operation })}
					onAbort={() => inProgress && operate({ kind: 'abortOperation', operation: inProgress.operation })} />
			{/if}
			{#if panel === 'reflog'}
				<ReflogPanel {repo} references={info?.branches.filter((b) => !b.startsWith('remotes/')) ?? []} onShow={showCommit} onClose={() => { panel = null; }} />
			{:else if panel === 'worktrees'}
				<WorktreePanel {repo} version={worktreeVersion} onAdd={worktreeAddDialog} onRemove={worktreeRemoveDialog}
					onPrune={() => { void operate({ kind: 'worktreePrune' }).then(() => { worktreeVersion++; }); }} onOpen={(path) => { void addAndShow([path]); }} onClose={() => { panel = null; }} />
			{/if}
			{#if details !== null && inlineRow < 0}
				<DetailsPanel view={details} fileView={settings.current.details.fileView} compactFolders={settings.current.details.compactFolders} dateFormat={settings.current.commits.dateFormat}
					markdown={settings.current.commits.markdown} bind:height={detailsHeight} onClose={closeDetails} onOpenFile={openFile} {onFileMenu} />
			{/if}
		{/if}
	</div>
	{#if settingsOpen}
		<SettingsPanel {repo} remoteRepo={repo !== null && isRemote(repo)} config={repoConfig} onClose={() => { settingsOpen = false; }} onOperate={operate} onExport={exportRepoState}
			onDialog={(spec, onDone) => { dialog = { spec, onDone }; }} />
	{/if}
	{#if menu}
		<ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => { menu = null; }}
			onPick={(id) => { const pick = (menu as { onPick: (id: string) => void }).onPick; menu = null; pick(id); }} />
	{/if}
	{#if dialog}
		<FormDialog spec={dialog.spec} onSubmit={onDialogSubmit} onCancel={() => { dialog = null; }} />
	{/if}
	<OpDialogs />
	<AskpassDialog />
</main>

<style>
	.gg-main { display: flex; flex-direction: row; height: 100vh; }
	.gg-content { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
	.gg-error { color: var(--gg-errorForeground); padding: 16px; white-space: pre-wrap; margin: 0; }
</style>
