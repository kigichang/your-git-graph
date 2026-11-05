/* The extension host of the Tauri app: boots the upstream webview on a repository and answers
 * its requests (see shim.js for the transport).
 *   reads.js   engine-backed reads        gitops.js  git CLI writes and reads
 *   app.js     what VS Code used to answer
 * Message shapes: upstream src/types/messages.ts. */
import { readHandlers } from './reads.js';
import { gitHandlers, READ_COMMANDS } from './gitops.js';
import { appHandlers, APP_WRITES } from './app.js';
import { installAskpass } from './askpass.js';
import { configFrom } from './settings.js';
import { importRepoConfig } from './repoconfig.js';
import { createSidebar, addRepos, removeRepo, moveRepo, moveToGroup, renameGroup, removeGroup, parseAheadBehind, baseName } from './sidebar.js';
import { isRemote, parseRemote, hostOf, withPath, absolutePath, remoteId } from './remote.js';
import { askRemote, askServer, askGroup } from './addremote.js';

const { invoke, Channel } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;
const events = window.__TAURI__.event;
/* Events for this window only (Rust emit_to): events.listen hears those of every window. */
const thisWindow = window.__TAURI__.window.getCurrentWindow();
/* The repositories of the sidebar (shared by all windows; the view's repository set and what
 * routing accepts) and the one this window shows. */
let windowRepos = [];
let repoRoot = null;

/* The view configuration: settings.json over upstream's defaults (settings.js). The webview
 * gets copies (it adjusts its own, e.g. the row grid of the narrow layout); configJson is what
 * the settings gave last, to tell real changes apart. */
let config = null, configJson = null;

const log = (line) => { console.log(line); invoke('host_log', { line, persist: config !== null && config.enableLog }).catch(() => {}); };
installAskpass({ listen: (name, handler) => thisWindow.listen(name, handler), invoke, log }); // this window's prompts only (askpass.rs)
window.addEventListener('error', (e) => log('webview error: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => log('webview rejection: ' + ((e.reason && e.reason.stack) || e.reason)));

/* ---------- Backends ---------- */

/** One engine call. Failures come back in-band as {"error": "Kind: message"} - thrown here. */
async function engine(repo, method, params) {
	const t0 = performance.now();
	const raw = await invoke('engine_request', { repo, request: JSON.stringify({ method, params: params || null }) });
	const answer = JSON.parse(raw);
	log(`engine ${method} ${Math.round(performance.now() - t0)}ms (${raw.length} bytes)`);
	if (answer !== null && typeof answer === 'object' && !Array.isArray(answer)
		&& Object.keys(answer).length === 1 && typeof answer.error === 'string') {
		throw new Error(answer.error);
	}
	return answer;
}

/** One git CLI run (Rust: src-tauri/src/git.rs).
 * opts: { env, timeoutMs, id (cancellable via invoke('git_cancel', { id })), onOutput(chunk) }.
 * Resolves to { exitCode, stdout, stderr, timedOut, cancelled, durationMs }; rejects only when
 * git cannot be started at all. */
async function git(cwd, args, opts = {}) {
	const onOutput = new Channel();
	if (opts.onOutput) onOutput.onmessage = opts.onOutput;
	const result = await invoke('git_exec', {
		request: { args, cwd, env: opts.env, timeoutMs: opts.timeoutMs, id: opts.id, stream: !!opts.onOutput },
		onOutput
	});
	log(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) || args[0]} exit=${result.exitCode} ${result.durationMs}ms${result.timedOut ? ' TIMED OUT' : ''}${result.cancelled ? ' CANCELLED' : ''}`);
	return result;
}

/* ---------- Persisted state (Rust: state.rs → state.json in Application Support) ---------- */

/* All of it, held here for synchronous reads; every window holds a copy, kept current by the
 * others' changes (event state-changed). Ready before anything boots. */
let saved = {};
const stateReady = invoke('state_snapshot').then((all) => { saved = all; migrateLocalStorage(); },
	(e) => log('state unavailable, nothing is kept: ' + e));
events.listen('state-changed', ({ payload }) => {
	if (payload.from === thisWindow.label) return;
	if (payload.value === null) delete saved[payload.key]; else saved[payload.key] = payload.value;
	if (payload.key === 'sidebar' && viewLoaded) sidebarChangedElsewhere();
});

const store = {
	get(key, fallback) { return key in saved ? structuredClone(saved[key]) : fallback; },
	/** null removes the key. */
	set(key, value) {
		if (value === null || value === undefined) delete saved[key]; else saved[key] = structuredClone(value);
		invoke('state_set', { key, value: value ?? null }).catch((e) => log('cannot save ' + key + ': ' + e));
	},
	repoState(repo) { return { ...window.__GG_DEFAULT_REPO_STATE, ...this.get('repoState:' + repo, {}) }; },
	repos() { return Object.fromEntries(windowRepos.map((repo) => [repo, this.repoState(repo)])); },
	setRepoState(repo, state) { this.set('repoState:' + repo, state); }
};
/* shim.js keeps the webview's own state (getState/setState) here too. */
window.__ggStore = store;

/** Earlier versions kept the state in localStorage ("gg." + key): move it over, once. The diff
 * window's layout preferences (gg.diffPrefs) stay there - they belong to that page. */
function migrateLocalStorage() {
	if (saved.migratedFromLocalStorage) return;
	let moved = 0;
	try {
		for (const name of Object.keys(localStorage)) {
			if (!name.startsWith('gg.') || name === 'gg.diffPrefs') continue;
			const key = name.slice(3);
			try {
				if (!(key in saved)) { store.set(key, JSON.parse(localStorage.getItem(name))); moved++; }
			} catch (_) { /* unreadable: dropped */ }
			localStorage.removeItem(name);
		}
	} catch (_) { /* localStorage unavailable: nothing to move */ }
	store.set('migratedFromLocalStorage', true);
	if (moved > 0) log('state: moved ' + moved + ' entries from localStorage');
}

/* ---------- Settings (Rust: state.rs → settings.json; settings.js turns them into the config) ---------- */

/** The configuration from settings.json as it is now; a file that cannot be read gives the
 * defaults and `error`. */
async function readConfig() {
	let settings = {}, error = null;
	try { settings = await invoke('settings_read'); } catch (e) { error = String(e); log('settings: ' + error); }
	const result = configFrom(window.__GG_DEFAULT_CONFIG, settings, { language: navigator.language });
	if (result.ignored.length > 0) log('settings: ignored ' + result.ignored.join(', ') + ' (unknown, invalid, or not offered by the app)');
	return { config: result.config, error };
}

/** settings.json changed (through the app, in any window, or by hand - checked when the window
 * comes to the front): apply it. The interface language is only read when the view starts, so
 * changing it reloads the page (which reopens the same repository). */
let configChanges = 0, viewLoaded = false;
async function reloadConfig() {
	if (!viewLoaded) return;
	const { config: next } = await readConfig();
	const json = JSON.stringify(next);
	if (json === configJson) return;
	const relaunch = next.interfaceLanguage !== config.interfaceLanguage;
	config = next;
	configJson = json;
	configChanges++;
	if (relaunch) {
		log('settings: interface language now ' + next.interfaceLanguage + ', reloading');
		sessionStorage.setItem('gg.reopen', repoRoot);
		window.location.reload();
		return;
	}
	log('settings: configuration changed');
	window.__ggDeliver({ command: 'configChanged', config: structuredClone(config) });
}
events.listen('settings-changed', () => reloadConfig());
thisWindow.onFocusChanged(({ payload: focused }) => {
	if (!focused) return;
	reloadConfig();
	// A repository on another machine: only its git directory is watched there (remote.rs), and
	// on a network share nothing tells of what other machines change. Both show what happened
	// meanwhile when the window comes back to the front.
	if (viewLoaded && (isRemote(repoRoot) || repoRoot in shares()) && !(repoStatus[repoRoot] && repoStatus[repoRoot].missing) && operationsRunning === 0) {
		window.__ggDeliver({ command: 'refresh' });
	}
});

function codeReviewsOf(repo) {
	const key = 'codeReviews:' + repo;
	return {
		get: (id) => store.get(key, {})[id] ?? null,
		set: (id, review) => store.set(key, { ...store.get(key, {}), [id]: review }),
		delete: (id) => { const all = store.get(key, {}); delete all[id]; store.set(key, all); }
	};
}

const system = {
	clipboard: (text) => invoke('clipboard_write', { text }),
	openUrl: (url) => invoke('open_url', { url }),
	openPath: (path) => invoke('open_path', { path }),
	terminal: (cwd, gitArgs) => invoke('open_terminal', { cwd, gitArgs }),
	showError: (message) => dialog.message(message, { title: 'Your Git Graph', kind: 'error' }),
	openDiff: (spec) => invoke('open_diff_window', { spec: JSON.stringify(spec), title: spec.title }),
	openSettings: async () => invoke('open_path', { path: await invoke('settings_path'), text: true }),
	openLog: async () => invoke('open_path', { path: await invoke('session_log_path'), text: true }),
	exportRepoConfig: (repo, contents) => invoke('export_repo_config', { repo, contents })
};
const settings = { write: (key, value) => invoke('settings_write', { key, value }) };

/* ---------- Routing ---------- */

const handlers = { ...readHandlers, ...gitHandlers, ...appHandlers };

function contextFor(repo) {
	return {
		repo,
		git: (args, opts) => git(repo, args, opts),
		engine: (method, params) => engine(repo, method, params),
		terminal: (gitArgs) => invoke('open_terminal', { cwd: repo, gitArgs }),
		saveDialog: async (name) => (await dialog.save({ defaultPath: repo.replace(/\/[^/]*$/, '') + '/' + name, title: 'Save Archive' })) ?? null,
		operationMarker: () => invoke('repo_operation_state', { repo }),
		codeReviews: codeReviewsOf(repo),
		config: () => config,
		store, system, settings
	};
}

/* git operations the host runs (writes above all) change the repository, and the webview
 * refreshes after each by itself: watcher events during one and shortly after are its own echo. */
let operationsRunning = 0, lastOperationEnd = -Infinity;
const ECHO_MS = 1000;

/** The response to one webview request, or null when it needs none. */
async function respond(msg) {
	const handler = handlers[msg.command];
	if (!handler) {
		log('unhandled webview request: ' + msg.command);
		return null;
	}
	// The webview only knows the repositories of this window; never act on another path.
	if (typeof msg.repo === 'string' && !windowRepos.includes(msg.repo)) {
		log(`refused ${msg.command} for ${msg.repo}: not a repository of this window`);
		return null;
	}
	if ((msg.command === 'loadRepoInfo' || msg.command === 'loadCommits') && msg.repo !== repoRoot) {
		shown(msg.repo); // switched in the sidebar (or the view's own repo dropdown)
	}
	const operation = (msg.command in gitHandlers && !READ_COMMANDS.has(msg.command)) || APP_WRITES.has(msg.command);
	if (operation) operationsRunning++;
	try {
		return await handler(contextFor(msg.repo ?? repoRoot), msg);
	} finally {
		if (operation) { operationsRunning--; lastOperationEnd = performance.now(); }
	}
}

/* The file watcher (Rust: watch.rs) reports which repositories changed. */
let watcherRefreshes = 0;
events.listen('repo-changed', ({ payload }) => {
	updateStatus(payload.repos.filter((repo) => windowRepos.includes(repo)));
	if (!payload.repos.includes(repoRoot)) return;
	if (operationsRunning > 0 || performance.now() - lastOperationEnd < ECHO_MS) return;
	watcherRefreshes++;
	log('watcher: ' + repoRoot + ' changed, refreshing');
	window.__ggDeliver({ command: 'refresh' });
});
/* Folders to show here: File > Open Repository…, Open Recent, dropped on the Dock icon (Rust
 * open_folder → open-repo) or on this window. Added to the sidebar and shown once the view is up;
 * before that, one start at a time (a folder arriving during the boot waits for it). */
let opening = Promise.resolve();
const openHere = (path) => { opening = opening.then(() => (viewLoaded ? addAndShow(path) : start(path))); return opening; };
thisWindow.listen('open-repo', ({ payload }) => openHere(payload));
/** The folders picked in the system's dialog (several can be selected; none when cancelled).
 * Each goes to openHere: added one after the other, the last one ends up shown. */
const pickFolders = async (title, defaultPath) => (await dialog.open({ directory: true, multiple: true, defaultPath, title })) ?? [];
window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
	if (payload.type === 'drop') for (const path of payload.paths) openHere(path);
});

/* The app menu's and View menu's commands (Rust: repos.rs), as the view's own buttons and
 * shortcuts (upstream observers.ts: ⌘ + the configured key) carry them out. */
const viewShortcut = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }));
const click = (id) => { const button = document.getElementById(id); if (button !== null) button.click(); };
const MENU_COMMANDS = {
	settings: () => click('settingsBtn'),
	refresh: () => viewShortcut(config.keybindings.refresh),
	find: () => viewShortcut(config.keybindings.find),
	head: () => viewShortcut(config.keybindings.scrollToHead),
	fetch: () => click('fetchBtn'),
	sidebar: () => toggleSidebar()
};
thisWindow.listen('menu-command', ({ payload }) => {
	if (payload === 'addRemote') addRemote(); // File > Add SSH Repository…: on the start page too
	else if (payload === 'addServer') connectServer();
	else if (viewLoaded && payload in MENU_COMMANDS) MENU_COMMANDS[payload]();
});

function setTitle() {
	const remote = parseRemote(repoRoot);
	const title = baseName(repoRoot) + (remote === null ? '' : ' (' + remote.authority + ')') + ' — Your Git Graph';
	document.title = title;
	thisWindow.setTitle(title).catch(() => {});
}

/* ---------- The repository sidebar (sidebar.js; the list is state.json "sidebar") ---------- */

let sidebar = null;
let repoStatus = {}; // repo -> { ahead, behind } | { missing: true } (not found, not connected) | null (no upstream)
const sidebarState = () => store.get('sidebar', { repos: [], collapsed: false });
const saveSidebar = (changes) => store.set('sidebar', { ...sidebarState(), ...changes });
const reportShown = () => invoke('repo_opened', { folder: repoRoot, repos: windowRepos }).catch((e) => log('not watching ' + repoRoot + ': ' + e));

/* The groups of the sidebar (sidebar.js): their names in order, and each repository's group. */
const groupsState = () => ({ groups: sidebarState().groups ?? [], groupOf: sidebarState().groupOf ?? {} });
/* The names of the folded groups ("default" for that of the ungrouped). */
const foldedGroups = () => sidebarState().foldedGroups ?? [];

/** The + menu's New Group…, a group's Rename Group…: ask for the name and keep it. */
async function nameGroup(current) {
	const { groups, groupOf } = groupsState();
	const answer = await askGroup({ language: config.interfaceLanguage, groups, current });
	if (answer === null || answer.name === current) return;
	saveSidebar(current === undefined ? { groups: [...groups, answer.name] }
		: { ...renameGroup(groups, groupOf, current, answer.name), foldedGroups: foldedGroups().map((g) => (g === current ? answer.name : g)) });
	renderSidebar();
}

function renderSidebar() {
	if (sidebar !== null) sidebar.render({ repos: windowRepos, ...groupsState(), folded: foldedGroups(), current: repoRoot, status: repoStatus, collapsed: sidebarState().collapsed, language: config.interfaceLanguage });
}

/** The view now shows `repo`: title, sidebar, watcher and the next launch follow. */
function shown(repo) {
	repoRoot = repo;
	store.set('lastActiveRepo', repo);
	setTitle();
	renderSidebar();
	reportShown();
}

/** Hand the view the repository set (after the list changed) and show `repo` in it. */
function showInView(repo) {
	window.__ggDeliver({ command: 'loadRepos', repos: store.repos(), lastActiveRepo: repo, loadViewTo: repo === repoRoot ? null : { repo } });
}

/** The list is now `list`: routing, the watcher and the sidebar follow (the view: showInView). */
function setRepos(list) {
	windowRepos = list;
	saveSidebar({ repos: list });
	reportShown();
	renderSidebar();
}

/** Ahead/behind of each of `repos` against its upstream, for the sidebar's badges. */
async function updateStatus(repos) {
	if (repos.length === 0) return;
	await Promise.all(repos.map(async (repo) => {
		try {
			const r = await git(repo, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
			repoStatus[repo] = r.exitCode === 0 ? parseAheadBehind(r.stdout) : null;
		} catch (_) {
			repoStatus[repo] = { missing: true }; // git cannot even start there: the folder is gone, its machine not connected
		}
	}));
	renderSidebar();
}

/** Add the repositories of `path` to the sidebar and show (the first of) them. */
async function addAndShow(path) {
	let found;
	try { found = await repositoriesOf(path); } catch (e) { system.showError(String((e && e.message) || e)).catch(() => {}); return; }
	const added = found.filter((repo) => !windowRepos.includes(repo));
	await importRepoConfigs(added);
	setRepos(addRepos(windowRepos, found));
	showInView(found.includes(repoRoot) ? repoRoot : found[0]);
	updateStatus(added);
	rememberShares(added);
}

/* The network shares the sidebar's local repositories are on (state.json "mounts": repo → the
 * share's address), noted while they are mounted: what to mount when one is not there. */
const shares = () => store.get('mounts', {});
async function rememberShares(repos) {
	for (const repo of repos) {
		const url = await invoke('network_volume', { path: repo }).catch(() => null);
		if (url !== null && shares()[repo] !== url) { store.set('mounts', { ...shares(), [repo]: url }); log('on a network share: ' + repo + ' (' + url + ')'); }
	}
}

/** A click on a faded row: connect to its machine, or mount its share (else just look for the
 * folder again), then show it. */
async function reconnect(repo) {
	try {
		if (isRemote(repo)) await invoke('remote_connect', { repo });
		else if (repo in shares()) await invoke('mount_volume', { url: shares()[repo] });
		await engine(repo, 'close').catch(() => {}); // a handle from before the volume went away
		await engine(repo, 'open');
	} catch (e) {
		system.showError(String((e && e.message) || e)).catch(() => {});
		return;
	}
	// Everything on that machine is reachable again.
	const back = windowRepos.filter((r) => r === repo || (isRemote(repo) && hostOf(r) === hostOf(repo)));
	for (const r of back) delete repoStatus[r];
	reportShown();
	await importRepoConfigs(back);
	updateStatus(back);
	if (repo === repoRoot) window.__ggDeliver({ command: 'refresh' }); else showInView(repo);
}

/* The connection to a machine is gone (Rust: remote.rs): its repositories fade until clicked. */
events.listen('remote-disconnected', ({ payload }) => {
	log('remote: ' + payload.error);
	for (const repo of windowRepos) if (hostOf(repo) === payload.host) repoStatus[repo] = { missing: true };
	renderSidebar();
});

/** File > Add SSH Repository…, the sidebar's + menu, the start page: ask where, connect (ssh's
 * questions appear in the credential prompt), and open what is there. */
async function addRemote(initial, error) {
	const language = config !== null ? config.interfaceLanguage : (await readConfig()).config.interfaceLanguage;
	const answer = await askRemote({ language, initial, error });
	if (answer === null) return;
	let repo;
	try {
		const hello = await invoke('remote_connect', { repo: remoteId(answer.destination, answer.port, '/') });
		repo = remoteId(answer.destination, answer.port, absolutePath(answer.path, hello.home));
	} catch (e) {
		addRemote(answer, String((e && e.message) || e));
		return;
	}
	openHere(repo);
}

/** File > Connect to Server…, the sidebar's + menu, the start page: mount a share (macOS asks
 * for the name and password), then pick the repository on it. */
async function connectServer(initial, error) {
	const language = config !== null ? config.interfaceLanguage : (await readConfig()).config.interfaceLanguage;
	const answer = await askServer({ language, initial, error });
	if (answer === null) return;
	let mounted;
	try { mounted = await invoke('mount_volume', { url: answer.url }); } catch (e) { connectServer(answer, String((e && e.message) || e)); return; }
	(await pickFolders('Add Repository', mounted)).forEach(openHere);
}

function removeFromSidebar(repo) {
	const { list, show } = removeRepo(windowRepos, repo, repoRoot);
	delete repoStatus[repo];
	if (repo in shares()) { const rest = shares(); delete rest[repo]; store.set('mounts', rest); }
	if (repo in groupsState().groupOf) { const rest = groupsState().groupOf; delete rest[repo]; saveSidebar({ groupOf: rest }); }
	if (show === null) { // nothing left: the start page
		saveSidebar({ repos: [] });
		sessionStorage.setItem('gg.reopen', '');
		window.location.reload();
		return;
	}
	setRepos(list);
	showInView(show);
}

function toggleSidebar() {
	saveSidebar({ collapsed: !sidebarState().collapsed });
	renderSidebar();
}

/** Another window changed the shared list (or folded the sidebar). */
function sidebarChangedElsewhere() {
	const list = sidebarState().repos;
	if (JSON.stringify(list) !== JSON.stringify(windowRepos)) {
		if (list.length === 0) { sessionStorage.setItem('gg.reopen', ''); window.location.reload(); return; }
		const added = list.filter((repo) => !windowRepos.includes(repo));
		windowRepos = list;
		reportShown();
		showInView(list.includes(repoRoot) ? repoRoot : list[0]);
		updateStatus(added);
	}
	renderSidebar();
}

function installSidebar() {
	sidebar = createSidebar({
		select: (repo) => (repoStatus[repo] && repoStatus[repo].missing ? reconnect(repo) : showInView(repo)),
		add: async () => {
			(await pickFolders('Add Repository')).forEach(openHere);
		},
		addRemote: () => addRemote(),
		addServer: () => connectServer(),
		remove: removeFromSidebar,
		reveal: (repo) => invoke('open_path', { path: repo }).catch((e) => system.showError(String(e))),
		terminal: (repo) => invoke('open_terminal', { cwd: repo, gitArgs: null }).catch((e) => system.showError(String(e))),
		newWindow: (repo) => invoke('open_new_window', { repo }).catch((e) => system.showError(String(e))),
		move: (repo, group, before) => {
			const moved = moveToGroup(windowRepos, groupsState().groupOf, repo, group, before);
			saveSidebar({ groupOf: moved.groupOf });
			setRepos(moved.list);
			showInView(repoRoot);
		},
		moveGroup: (name, before) => { saveSidebar({ groups: moveRepo(groupsState().groups, name, before) }); renderSidebar(); },
		newGroup: () => nameGroup(),
		renameGroup: (name) => nameGroup(name),
		deleteGroup: (name) => {
			saveSidebar({ ...removeGroup(groupsState().groups, groupsState().groupOf, name), foldedGroups: foldedGroups().filter((g) => g !== name) });
			renderSidebar();
		},
		foldGroup: (name) => {
			saveSidebar({ foldedGroups: foldedGroups().includes(name) ? foldedGroups().filter((g) => g !== name) : [...foldedGroups(), name] });
			renderSidebar();
		},
		toggle: toggleSidebar,
		settings: () => click('settingsBtn')
	});
	renderSidebar();
}

/** The sidebar's list at boot; the first time, the recent folders' repositories. */
async function initialRepos() {
	const kept = store.get('sidebar', null);
	if (kept !== null) return kept.repos;
	let list = [];
	for (const path of await invoke('recent_repos').catch(() => [])) {
		try { list = addRepos(list, await repositoriesOf(path)); } catch (_) { /* gone or no longer a repository */ }
	}
	return list;
}

window.__ggHost = {
	handle(msg) {
		respond(msg).then((response) => {
			if (response !== null) window.__ggDeliver(response);
		}, (e) => log('handler ' + msg.command + ' failed: ' + ((e && e.stack) || e)));
	}
};

/* ---------- Startup: pick a repository, then boot the upstream webview ---------- */

/* The elements the upstream view looks up when it starts - in VS Code the extension host writes
 * them into the page. Ids, classes and nesting are what the view's code and CSS expect. */
function el(tag, props, ...children) {
	const e = document.createElement(tag);
	for (const [key, value] of Object.entries(props || {})) {
		if (key === 'class') e.className = value;
		else if (key === 'hidden') e.style.display = 'none'; // the view shows them by style
		else e.setAttribute(key, value);
	}
	e.append(...children);
	return e;
}
/** `nodes` with a space around each: the toolbar's controls are inline, spaced like words. */
const spaced = (...nodes) => [' ', ...nodes.flatMap((n) => [n, ' '])];
const button = (name) => el('div', { id: name + 'Btn' });
const dropdownControl = (name) => el('span', { id: name + 'Control' },
	el('span', { id: name + 'ControlLabel', class: 'unselectable' }), el('div', { id: name + 'Dropdown', class: 'dropdown' }));
const viewSkeleton = () => el('div', { id: 'view', tabindex: '-1' },
	el('div', { id: 'headerRow' },
		el('div', { id: 'controls' }, ...spaced(
			...['repo', 'branch', 'author'].map(dropdownControl),
			el('label', { id: 'showRemoteBranchesControl' },
				el('input', { type: 'checkbox', id: 'showRemoteBranchesCheckbox', tabindex: '-1' }),
				el('span', { class: 'customCheckbox' }), el('span', { id: 'showRemoteBranchesLabel' })),
			el('span', { id: 'controlBtns' }, ' ',
				...['current', 'find', 'filter', 'statistics'].map(button), ' ',
				...['terminal', 'settings', 'fetch', 'refresh'].map(button), ' '))),
		el('div', { id: 'pinnedControls', hidden: true }, el('span', { id: 'pinnedRowLabel', class: 'unselectable pinnedRowLabel' }))),
	el('div', { id: 'conflictBanner', hidden: true }),
	el('div', { id: 'content' }, el('div', { id: 'commitGraph' }), el('div', { id: 'commitTable' })),
	el('div', { id: 'footer' }));

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const s = document.createElement('script');
		s.src = src;
		s.onload = resolve;
		s.onerror = () => reject(new Error('failed to load ' + src));
		document.body.appendChild(s);
	});
}

/** The repositories `path` opens: the one containing it, else those found below it. A path on
 * another machine (ssh://…) connects to it first. */
async function repositoriesOf(path) {
	if (isRemote(path)) await invoke('remote_connect', { repo: path });
	try {
		const root = await engine(path, 'repoRoot'); // a path on the repository's machine
		return [isRemote(path) ? withPath(path, root) : root];
	} catch (e) {
		const found = await invoke('scan_repos', { folder: path });
		if (found.length === 0) throw new Error(path + ' is not in a Git repository, and none was found inside it.');
		return found;
	}
}

/** Merge each repository's committed configuration (.vscode/vscode-git-graph.json, written by
 * Export Repository Configuration) into its state when it is newer than the last import. */
async function importRepoConfigs(repos) {
	await Promise.all(repos.map(async (repo) => {
		try {
			const file = await invoke('worktree_file', { repo, path: '.vscode/vscode-git-graph.json' });
			const next = file.exists && file.text !== null ? importRepoConfig(store.repoState(repo), file.text) : null;
			if (next !== null) { store.setRepoState(repo, next); log('imported the repository configuration of ' + repo); }
		} catch (e) { log('repository configuration of ' + repo + ' not read: ' + e); }
	}));
}

/** Thrown by boot when there is nothing to show: the start page, without an error. */
const NO_REPOSITORIES = 'no repositories';

/** Boot the view on `path` (added to the sidebar), or with null on the repository shown last. */
async function boot(path) {
	const t0 = performance.now();
	await stateReady;
	let list = await initialRepos();
	const last = store.get('lastActiveRepo', null);
	let candidates;
	if (path) {
		const found = await repositoriesOf(path);
		list = addRepos(list, found);
		candidates = found.includes(last) ? [last] : found;
	} else {
		candidates = list.includes(last) ? [last, ...list.filter((r) => r !== last)] : list;
	}
	// The first that opens (a listed repository may be gone, e.g. on an unmounted volume). Only
	// the first choice is worth connecting to its machine for; the rest of the sidebar's remote
	// repositories stay faded until clicked.
	repoRoot = null;
	for (const repo of candidates) {
		try {
			if (repo === candidates[0]) {
				if (isRemote(repo)) await invoke('remote_connect', { repo });
				else if (repo in shares() && (await invoke('network_volume', { path: repo })) === null) await invoke('mount_volume', { url: shares()[repo] });
			}
			await engine(repo, 'open'); repoRoot = repo; break;
		} catch (e) { log('cannot open ' + repo + ': ' + e.message); repoStatus[repo] = { missing: true }; }
	}
	if (repoRoot === null) throw new Error(candidates.length === 0 ? NO_REPOSITORIES : 'None of the repositories could be opened.');
	windowRepos = list;
	saveSidebar({ repos: list });
	store.set('lastActiveRepo', repoRoot);
	const repos = list;
	const engineVersion = await engine(repoRoot, 'engineVersion');
	const gitInfo = await invoke('git_info').catch((e) => { log('git unavailable: ' + e); return null; });
	const read = await readConfig();
	config = read.config;
	configJson = JSON.stringify(config);
	if (read.error !== null) system.showError(read.error + '\n\nThe default settings are used until it is fixed.').catch(() => {});
	await importRepoConfigs(repos);

	window.initialState = {
		config: structuredClone(config), lastActiveRepo: repoRoot, loadViewTo: { repo: repoRoot },
		repos: store.repos(),
		loadRepoInfoRefreshId: 0, loadCommitsRefreshId: 0, loadConfigRefreshId: 0,
		backend: { platform: 'darwin-' + (navigator.userAgent.includes('ARM') ? 'arm64' : 'x64'), engineAvailable: true,
			engineVersion, gitCliAvailable: gitInfo !== null, capabilities: [] },
		restoredSnapshot: null
	};
	window.globalState = store.get('globalViewState', { alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false });
	window.workspaceState = store.get('workspaceViewState', { findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false });

	/* Lane colours: the view's CSS draws a lane in --git-graph-color, chosen by its data-color index. */
	const colours = config.graph.colours;
	const style = document.createElement('style');
	style.textContent = 'body{' + colours.map((c, i) => `--git-graph-color${i}:${c};`).join('') + '}\n'
		+ colours.map((_, i) => `[data-color="${i}"]{--git-graph-color:var(--git-graph-color${i});}`).join('\n');
	document.head.appendChild(style);

	setTitle();
	reportShown();
	document.body.replaceChildren(viewSkeleton());
	window.__ggTheme.apply();
	installSidebar();
	// The view's own state (scroll position, filters, ...) per window.
	window.__ggStateFolder = 'window:' + thisWindow.label;
	await loadScript('media/vendor/markdown-it.min.js');
	await loadScript('media/out.min.js');
	// The bundle initialises on window 'load' (upstream web/main.ts), which fired long before
	// this dynamic load: replay it.
	window.dispatchEvent(new Event('load'));
	viewLoaded = true;
	updateStatus(list);
	rememberShares(list.filter((repo) => !isRemote(repo)));
	log(`booted ${path || '(last shown)'} (${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} in the sidebar, showing ${repoRoot}; engine ${engineVersion}, git ${gitInfo ? gitInfo.version : 'none'}, language ${config.interfaceLanguage}) in ${Math.round(performance.now() - t0)}ms`);
	const previewScenes = await invoke('preview');
	if (previewScenes !== null) runPreview(previewScenes.split(','));
	const selfTestOptions = await invoke('self_test');
	if (selfTestOptions !== null) {
		const current = window.__TAURI__.window.getCurrentWindow();
		if (current.label === 'main') {
			selfTest(t0, gitInfo, selfTestOptions);
		} else {
			// A window the self-test opened: its git's credential prompt shows here (the main window
			// checks it does not show there); report that it booted, then go away.
			await until('the graph of the new window', () => document.querySelector('#commitTable tr.commit'));
			const asking = git(repoRoot, ['-c', 'alias.ap=!"$GIT_ASKPASS" "Password: "', 'ap'], { timeoutMs: 3000 });
			const askpassShown = await until('the askpass dialog of the new window', () => document.querySelector('#ggAskpass'), 2500).then(() => true, () => false);
			await asking;
			await events.emit('selftest-window', { label: current.label, repo: repoRoot, repos: windowRepos, askpassShown });
			setTimeout(() => current.close(), 200);
		}
	}
}

async function showPicker(error) {
	document.body.innerHTML = '<div id="ggOpenRepo"><h2>Your Git Graph</h2><div><button id="ggOpenBtn">Open Repository…</button> <button id="ggOpenRemoteBtn">Add SSH Repository…</button> <button id="ggOpenServerBtn">Connect to Server (SMB)…</button></div>'
		+ '<div class="error" hidden></div><div class="recent" hidden><h3>Recent</h3><ul></ul></div></div>';
	if (error) Object.assign(document.querySelector('#ggOpenRepo .error'), { hidden: false, textContent: error });
	document.getElementById('ggOpenBtn').addEventListener('click', async () => {
		(await pickFolders('Open Git Repository')).forEach(openHere);
	});
	document.getElementById('ggOpenRemoteBtn').addEventListener('click', () => addRemote());
	document.getElementById('ggOpenServerBtn').addEventListener('click', () => connectServer());
	const recent = await invoke('recent_repos').catch(() => []);
	const list = document.querySelector('#ggOpenRepo .recent ul');
	for (const path of recent) {
		const item = document.createElement('li');
		const button = document.createElement('button');
		button.className = 'recentRepo';
		button.title = path;
		const name = document.createElement('span');
		name.textContent = baseName(path);
		const where = document.createElement('span');
		where.className = 'where';
		where.textContent = path.replace(/^\/Users\/[^/]+/, '~');
		button.append(name, where);
		button.addEventListener('click', () => start(path));
		item.appendChild(button);
		list.appendChild(item);
	}
	document.querySelector('#ggOpenRepo .recent').hidden = recent.length === 0;
}

async function start(path) {
	try {
		await boot(path);
	} catch (e) {
		windowRepos = []; repoRoot = null;
		const message = String((e && e.message) || e);
		if (message !== NO_REPOSITORIES) log('boot failed: ' + message);
		showPicker(message === NO_REPOSITORIES ? null : message);
	}
}

/* A page reloaded (a setting, the sidebar emptied) reopens what it showed ('' : nothing); a
 * window opened by File > Open or Open in New Window carries its repository; the first window
 * takes the command line; otherwise the repository shown last. */
const reopen = sessionStorage.getItem('gg.reopen');
sessionStorage.removeItem('gg.reopen');
(reopen !== null ? Promise.resolve(reopen ? [reopen] : [])
	: window.__GG_OPEN_REPO ? Promise.resolve([window.__GG_OPEN_REPO])
		: thisWindow.label === 'main' ? invoke('initial_repo') : Promise.resolve([]))
	.then((paths) => { openHere(paths[0] || null); paths.slice(1).forEach(openHere); }, (e) => showPicker(String(e)));

/* ---------- GG_PREVIEW: the view in a given state, to look at (no checks) ---------- */

async function runPreview(scenes) {
	try {
		const rows = await until('commit rows', () => { const r = document.querySelectorAll('#commitTable tr.commit:not([data-hash="*"])'); return r.length > 1 && r; });
		const row = rows[1];
		const pause = (ms) => new Promise((r) => setTimeout(r, ms));
		const contextMenu = () => {
			const cell = row.querySelector('td:nth-child(2)'), box = cell.getBoundingClientRect();
			cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + 8 }));
		};
		for (const scene of scenes) {
			if (scene === 'details') row.querySelector('td:nth-child(2)').click();
			else if (scene === 'settings') click('settingsBtn');
			else if (scene === 'find') { MENU_COMMANDS.find(); await pause(300); const input = document.querySelector('.findWidget input'); if (input) { input.value = 'fix'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', bubbles: true })); } }
			else if (scene === 'menu') contextMenu();
			else if (scene === 'dialog') {
				contextMenu();
				const item = await until('a context menu item', () => [...document.querySelectorAll('.contextMenu li.contextMenuItem')].find((li) => /branch/i.test(li.textContent)));
				item.click();
			} else if (scene === 'fold') {
				MENU_COMMANDS.sidebar();
			} else if (scene === 'repomenu') {
				const item = document.querySelectorAll('#ggRepoList .ggRepo')[1] || document.querySelector('#ggRepoList .ggRepo');
				const box = item.getBoundingClientRect();
				item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 60, clientY: box.top + 14 }));
			} else if (scene === 'addmenu') {
				document.querySelector('.ggSidebarHead .ggIconBtn').click();
			} else if (scene === 'addremote') {
				addRemote({ destination: 'me@build.example.com', port: '', path: '' }, 'Cannot connect to me@build.example.com: Permission denied (publickey,password).');
			} else if (scene === 'addserver') {
				connectServer();
			} else if (scene === 'resize') {
				await invoke('preview_resize', { width: 2400, height: 1300 });
			} else if (scene === 'diff') {
				const d = await respond({ command: 'commitDetails', repo: repoRoot, commitHash: row.dataset.hash, hasParents: true, stash: null, avatarEmail: null, refresh: false });
				const f = d.commitDetails.fileChanges.find((x) => x.type === 'M') ?? d.commitDetails.fileChanges[0];
				await respond({ command: 'viewDiff', repo: repoRoot, fromHash: row.dataset.hash, toHash: row.dataset.hash, oldFilePath: f.oldFilePath, newFilePath: f.newFilePath, type: f.type });
			} else if (scene !== 'contrast') log('preview: unknown scene ' + scene);
			await pause(700);
		}
		log('preview: ready (' + scenes.join(', ') + ')');
	} catch (e) {
		log('preview: ' + ((e && e.message) || e));
	}
}

/* ---------- GG_SELFTEST=1: end-to-end checks from inside the page (no screen access needed) ---------- */

const until = async (what, cond, ms = 15000) => {
	const end = performance.now() + ms;
	while (performance.now() < end) { const v = cond(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
	throw new Error('timed out waiting for ' + what);
};
const check = (ok, what) => { if (!ok) throw new Error(what); };

async function selfTest(t0, gitInfo, options) {
	try {
		/* The interface language: changing it reloads the page, which reopens the same repository in
		 * the new language. Two reloads (to Chinese, back to English), carried across them by
		 * sessionStorage; the rest of the self-test runs after the second. */
		const label = () => until('the toolbar', () => document.getElementById('showRemoteBranchesLabel')?.textContent.trim());
		const phase = sessionStorage.getItem('gg.selftestPhase');
		if (phase === null) {
			sessionStorage.setItem('gg.selftestPhase', 'zh-cn');
			const r = await respond({ command: 'setInterfaceLanguage', language: 'zh-cn' });
			check(r.error === null, 'setInterfaceLanguage: ' + JSON.stringify(r));
			await new Promise((resolve) => setTimeout(resolve, 5000));
			throw new Error('the page did not reload for the new interface language');
		}
		if (phase === 'zh-cn') {
			check(config.interfaceLanguage === 'zh-cn' && await label() === '遠端', 'after the reload: ' + config.interfaceLanguage + ', toolbar "' + await label() + '"');
			check((await invoke('settings_read')).interfaceLanguage === 'zh-tw', 'Chinese is kept as ' + JSON.stringify((await invoke('settings_read')).interfaceLanguage) + ', not "zh-tw"');
			check(document.querySelector('.ggSidebarTitle')?.textContent === '儲存庫', 'the sidebar is not in Traditional Chinese');
			sessionStorage.setItem('gg.selftestPhase', 'en');
			await respond({ command: 'setInterfaceLanguage', language: 'en' });
			await new Promise((resolve) => setTimeout(resolve, 5000));
			throw new Error('the page did not reload for English');
		}
		sessionStorage.removeItem('gg.selftestPhase');
		check(config.interfaceLanguage === 'en' && await label() === 'Remote', 'back to English: toolbar "' + await label() + '"');
		log('selftest: interface language Traditional Chinese and back to English, reloading into ' + repoRoot.split('/').pop() + ' each time OK');

		/* The view: graph rendered, a click opens commit details with its file list. */
		const rows = await until('commit rows', () => { const r = document.querySelectorAll('#commitTable tr.commit'); return r.length > 0 && r; });
		const svg = document.querySelector('#commitGraph svg');
		// The graph's SVG <mask> is off (WebKit drops the lines after a resize; theme.css).
		const masked = svg && svg.querySelector('g[mask]');
		check(masked && getComputedStyle(masked).mask === 'none' && /gradient/.test(getComputedStyle(svg).webkitMaskImage || getComputedStyle(svg).maskImage), 'the graph still draws through its SVG mask');
		log(`selftest: first paint ${Math.round(performance.now() - t0)}ms, ${rows.length} rows in DOM, graph svg ${svg ? svg.querySelectorAll('path').length + ' paths, ' + svg.querySelectorAll('circle').length + ' vertices' : 'MISSING'}`);
		// The first commit that changed files (an empty commit opens an empty file list).
		let target = null;
		for (const row of Array.from(rows).filter((r) => r.dataset.hash !== '*').slice(0, 20)) {
			const d = await respond({ command: 'commitDetails', repo: repoRoot, commitHash: row.dataset.hash, hasParents: true, stash: null, avatarEmail: null, refresh: false });
			if (d.commitDetails && d.commitDetails.fileChanges.length > 0) { target = row; break; }
		}
		check(target !== null, 'no commit with file changes among the first rows');
		target.querySelector('td:nth-child(2)').click();
		const files = await until('commit details file list', () => { const f = document.getElementById('cdvFiles'); return f && f.textContent.trim() !== '' && f; });
		await new Promise((r) => setTimeout(r, 500)); // let the deferred line counts settle
		log(`selftest: details for ${target.dataset.hash.slice(0, 8)} opened, files: ${files.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)}`);

		/* git_exec over the real IPC: cwd, streaming, cancel. */
		check(gitInfo !== null, 'git not found');
		const top = await git(repoRoot, ['rev-parse', '--show-toplevel']);
		check(top.exitCode === 0 && top.stdout.trim() === repoRoot, 'git_exec cwd: ' + JSON.stringify(top));
		const chunks = [];
		const logged = await git(repoRoot, ['log', '-3', '--format=%h %s'], { onOutput: (c) => chunks.push(c) });
		const streamed = chunks.filter((c) => c.stream === 'stdout').map((c) => c.data).join('');
		check(logged.exitCode === 0 && streamed === logged.stdout && streamed !== '', 'git_exec streaming mismatch');
		const pending = git(repoRoot, ['-c', 'alias.s=!sleep 30', 's'], { id: 'selftest-cancel' });
		await new Promise((r) => setTimeout(r, 200));
		check(await invoke('git_cancel', { id: 'selftest-cancel' }), 'git_cancel found no run');
		const cancelled = await pending;
		check(cancelled.cancelled && cancelled.durationMs < 5000, 'git_exec cancel: ' + JSON.stringify(cancelled));
		log(`selftest: git ${gitInfo.version} at ${gitInfo.path}; cwd, streaming, cancel OK`);

		/* The router: reads through every backend. */
		const head = target.dataset.hash;
		const reads = [
			['loadRepoInfo', { refreshId: 1, showRemoteBranches: true, showStashes: true, hideRemotes: [] }, (r) => r.error === null && Array.isArray(r.operationState.conflictedFiles)],
			['loadConfig', { refreshId: 1, remotes: [] }, (r) => r.error === null && r.config.user !== undefined],
			['reflog', { ref: 'HEAD', limit: 5 }, (r) => r.error === null && r.entries.length > 0],
			['worktreeList', {}, (r) => r.worktrees.length > 0 && r.worktrees[0].isMain],
			['repoStatistics', {}, (r) => r.authors.length > 0 && r.activity.length > 0],
			['commitBodies', { commitHashes: [head], requestId: 1 }, (r) => typeof r.bodies[head] === 'string'],
			['compareCommits', { commitHash: head, compareWithHash: head + '~1', fromHash: head + '~1', toHash: head, refresh: false }, (r) => r.error === null && r.fileChanges.length > 0],
			['predictConflicts', { ours: 'HEAD', theirs: head }, (r) => r.prediction !== null]
		];
		for (const [command, extra, ok] of reads) {
			const r = await respond({ command, repo: repoRoot, ...extra });
			check(r !== null && ok(r), command + ': ' + JSON.stringify(r).slice(0, 300));
		}
		log(`selftest: ${reads.length} reads through the router OK`);

		/* A reversible write through the router: create a branch, see it, delete it. */
		const name = 'gg-selftest-' + Date.now();
		const created = await respond({ command: 'createBranch', repo: repoRoot, commitHash: head, branchName: name, checkout: false, force: false });
		check(created.errors.every((e) => e === null), 'createBranch: ' + JSON.stringify(created));
		const info = await respond({ command: 'loadRepoInfo', repo: repoRoot, refreshId: 2, showRemoteBranches: false, showStashes: false, hideRemotes: [] });
		check(info.branches.includes(name), 'the engine does not see the new branch');
		const deleted = await respond({ command: 'deleteBranch', repo: repoRoot, branchName: name, forceDelete: true, deleteOnRemotes: [] });
		check(deleted.errors.every((e) => e === null), 'deleteBranch: ' + JSON.stringify(deleted));
		check(await respond({ command: 'createBranch', repo: '/elsewhere', commitHash: head, branchName: 'x', checkout: false, force: false }) === null, 'a foreign repo path was accepted');
		log('selftest: write round trip (createBranch → engine sees it → deleteBranch) OK; foreign repo refused');

		/* Data-loss warning, the whole loop: force-moving a branch that alone holds a commit is
		 * answered with a warning, the view shows its dialog, Continue re-sends the request
		 * confirmed, and it runs. The commit is made with commit-tree (no working tree change). */
		const lonely = (await git(repoRoot, ['commit-tree', head + '^{tree}', '-p', head, '-m', 'gg-selftest lonely commit'])).stdout.trim();
		const forced = 'gg-selftest-loss-' + Date.now();
		check((await git(repoRoot, ['branch', forced, lonely])).exitCode === 0, 'creating ' + forced);
		const warning = await respond({ command: 'createBranch', repo: repoRoot, commitHash: head, branchName: forced, checkout: false, force: true });
		check(warning.command === 'lossWarning' && /1 commit of <b>gg-selftest-loss-/.test(warning.message) && warning.retry.confirmed === true, 'no data-loss warning: ' + JSON.stringify(warning));
		window.__ggDeliver(warning);
		const proceed = await until('the data-loss dialog', () => document.querySelector('.dataLossMascot') && document.getElementById('dialogAction'));
		proceed.click();
		let moved = lonely;
		for (let tries = 0; tries < 80 && moved !== head; tries++) {
			await new Promise((r) => setTimeout(r, 100));
			moved = (await git(repoRoot, ['rev-parse', 'refs/heads/' + forced])).stdout.trim();
		}
		await git(repoRoot, ['branch', '-D', forced]);
		check(moved === head, 'the confirmed request did not run: ' + forced + ' at ' + moved);
		log('selftest: data-loss warning shown by the view, Continue re-sent it confirmed, branch moved OK');

		/* askpass: the real helper executable (as git runs it), the socket, the dialog. */
		const answerPrompt = async (answer) => {
			const input = await until('askpass dialog', () => document.querySelector('#ggAskpass input'));
			const prompt = document.querySelector('#ggAskpass .ggAskpassPrompt').textContent;
			const type = input.type;
			if (answer === null) {
				document.querySelector('#ggAskpass .ggAskpassCancel').click();
			} else {
				input.value = answer;
				document.querySelector('#ggAskpass .ggAskpassOk').click();
			}
			return { prompt, type };
		};
		const askVia = (prompt, opts) => git(repoRoot, ['-c', 'alias.ap=!"$GIT_ASKPASS" "' + prompt + '"', 'ap'], opts);

		let run = askVia("Password for 'https://selftest.invalid': ");
		const secret = await answerPrompt('s3cret "quoted" $HOME');
		let result = await run;
		check(secret.type === 'password', 'a password prompt must be masked');
		check(result.exitCode === 0 && result.stdout === 's3cret "quoted" $HOME\n', 'askpass answer: ' + JSON.stringify(result));
		run = askVia("Username for 'https://selftest.invalid': ");
		const user = await answerPrompt(null);
		result = await run;
		check(user.type === 'text' && result.exitCode !== 0 && result.stdout === '', 'askpass cancel: ' + JSON.stringify(result));
		run = askVia('Password: ', { timeoutMs: 1500 });
		await until('askpass dialog', () => document.querySelector('#ggAskpass'));
		result = await run;
		check(result.timedOut, 'the unanswered helper should time out');
		await until('the dialog of a killed helper to close', () => document.querySelector('#ggAskpass') === null, 3000);
		log('selftest: askpass answer (masked), cancel, and close-on-git-exit OK');

		/* ssh's passphrase prompt (the same askpass path ssh uses for keys and host checks):
		 * a throwaway key with passphrase "pp", read back with ssh-keygen -y. */
		run = git(repoRoot, ['-c', 'alias.sshk=!k="${TMPDIR:-/tmp}/gg-selftest-key-$$"; ssh-keygen -q -t ed25519 -N pp -f "$k" && ssh-keygen -y -f "$k"; s=$?; rm -f "$k" "$k.pub"; exit $s', 'sshk']);
		const passphrase = await answerPrompt('pp');
		result = await run;
		check(passphrase.type === 'password' && result.exitCode === 0 && result.stdout.startsWith('ssh-ed25519 '), 'ssh passphrase via askpass: ' + JSON.stringify({ passphrase, result }));
		log(`selftest: ssh passphrase prompt ${JSON.stringify(passphrase.prompt.slice(0, 40))}… answered through the dialog OK`);

		/* Diff windows: each opens, renders, reports back (event 'diff-selftest') and closes itself. */
		const details = await respond({ command: 'commitDetails', repo: repoRoot, commitHash: head, hasParents: true, stash: null, avatarEmail: null, refresh: false });
		const isImage = (f) => /\.(png|jpe?g|gif|webp)$/i.test(f.newFilePath);
		const file = details.commitDetails.fileChanges.find((f) => f.type === 'M' && !isImage(f)) ?? details.commitDetails.fileChanges[0];
		let escapeFindChecks = 0;
		const openAndReport = async (request) => {
			const report = new Promise((resolve) => window.__TAURI__.event.once('diff-selftest', (e) => resolve(e.payload)));
			const response = await respond({ repo: repoRoot, ...request });
			check(response === null || response.error === null, request.command + ': ' + JSON.stringify(response));
			const r = await Promise.race([report, new Promise((_, reject) => setTimeout(() => reject(new Error(request.command + ': no report from the diff window')), 20000))]);
			check(r.workerProblems.length === 0, 'Monaco worker problems: ' + r.workerProblems.join(' | '));
			const t = window.__ggTheme.current(), expected = t.contrast ? (t.dark ? 'hc-black' : 'hc-light') : t.dark ? 'vs-dark' : 'vs';
			check(r.theme === expected, 'the diff window is drawn in ' + r.theme + ', not ' + expected);
			check(r.escape.closes && r.escape.findFirst !== false, request.command + ': Esc ' + JSON.stringify(r.escape) + ' (findFirst: Esc closed the window instead of the find widget)');
			escapeFindChecks += r.escape.findFirst === true ? 1 : 0;
			return r.result;
		};
		const fileRequest = { fromHash: head, toHash: head, oldFilePath: file.oldFilePath, newFilePath: file.newFilePath, type: file.type };
		const diffs = [
			['viewDiff', fileRequest, (r) => r.kind === 'text' && r.changes > 0],
			['viewFileAtRevision', { hash: head, filePath: file.newFilePath }, (r) => r.kind === 'file' && r.lines > 0],
			['openCompareTab', { fromHash: head, toHash: head, singleCommit: true }, (r) => r.kind === 'compare' && r.files === details.commitDetails.fileChanges.length],
			['viewDiffWithWorkingFile', { hash: head, filePath: file.newFilePath }, (r) => r.kind === 'text'],
			['viewDiffBinary', fileRequest, (r) => r.kind === 'binary' && r.identical === false]
		];
		const image = details.commitDetails.fileChanges.find((f) => f.type === 'M' && isImage(f));
		if (image) {
			diffs.push(['viewDiffBinary', { fromHash: head, toHash: head, oldFilePath: image.oldFilePath, newFilePath: image.newFilePath, type: image.type },
				(r) => r.kind === 'image' && r.identical === false && r.dimensions.length === 2 && !r.dimensions.includes('undecodable')]);
		}
		const summary = [];
		for (const [command, extra, ok] of diffs) {
			const r = await openAndReport({ command, ...extra });
			check(ok(r), command + ' rendered ' + JSON.stringify(r));
			summary.push(command + ' ' + JSON.stringify(r));
		}
		// Each closed itself on the Esc the test sent.
		for (let tries = 0; tries < 50 && (await window.__TAURI__.window.getAllWindows()).some((w) => w.label.startsWith('diff-')); tries++) await new Promise((r) => setTimeout(r, 100));
		check(!(await window.__TAURI__.window.getAllWindows()).some((w) => w.label.startsWith('diff-')), 'a diff window did not close on Esc');
		check(escapeFindChecks > 0, 'Esc with the find widget open was never checked');
		log('selftest: diff windows OK (Esc closes them; with the find widget open it closes only the widget, checked in ' + escapeFindChecks + ') - ' + summary.join('; '));

		/* Repositories: the scan, the recent list, switching within the window's set. */
		const parent = repoRoot.replace(/\/[^/]+$/, '');
		check((await invoke('scan_repos', { folder: parent })).includes(repoRoot), 'scan_repos does not find ' + repoRoot + ' in ' + parent);
		check((await invoke('recent_repos'))[0] === repoRoot, 'the repository shown is not first in the recent list');
		if (windowRepos.length > 1) {
			// Switch away and back to the repository the view shows, so host and view agree again.
			const shown = repoRoot, second = windowRepos.find((r) => r !== shown);
			const other = await respond({ command: 'loadRepoInfo', repo: second, refreshId: 3, showRemoteBranches: false, showStashes: false, hideRemotes: [] });
			check(other.error === null && repoRoot === second, 'switching to ' + second + ': ' + JSON.stringify(other).slice(0, 200));
			await respond({ command: 'loadRepoInfo', repo: shown, refreshId: 4, showRemoteBranches: false, showStashes: false, hideRemotes: [] });
			check(repoRoot === shown, 'switching back to ' + shown);
			check(getComputedStyle(document.getElementById('repoControl')).display === 'none', 'the repo dropdown shows next to the sidebar');
			log('selftest: ' + windowRepos.length + ' repositories in this window; switching between them OK');
		}

		/* The file watcher: a file appearing in and leaving the working tree refreshes the view. */
		const awaitRefresh = async (what) => {
			const before = watcherRefreshes;
			await until(what, () => watcherRefreshes > before, 8000);
		};
		const tmp = 'gg-selftest-watch-' + Date.now() + '.tmp';
		let refreshed = awaitRefresh('a watcher refresh after creating ' + tmp);
		await git(repoRoot, ['-c', 'alias.mk=!printf x > ' + tmp, 'mk']);
		await refreshed;
		refreshed = awaitRefresh('a watcher refresh after deleting ' + tmp);
		await git(repoRoot, ['-c', 'alias.rmf=!rm -f ' + tmp, 'rmf']);
		await refreshed;
		log('selftest: watcher refreshed the view on create and on delete OK');

		/* Settings: saved to settings.json, applied by every window (configChanged), invalid
		 * values refused. The data directory is the self-test's own (GG_DATA_DIR). */
		const changesBefore = configChanges;
		const saved1 = await respond({ command: 'setGlobalSetting', setting: 'graph.style', value: 'angular' });
		check(saved1.error === null, 'setGlobalSetting: ' + JSON.stringify(saved1));
		await until('the new configuration to be applied', () => configChanges > changesBefore && config.graph.style === 1, 5000);
		check((await invoke('settings_read'))['graph.style'] === 'angular', 'settings.json does not hold the setting');
		const refused = await respond({ command: 'setGlobalSetting', setting: 'graph.rowHeight', value: 100 });
		check(refused.error !== null && /16 to 48/.test(refused.error), 'an out-of-range row height was accepted: ' + JSON.stringify(refused));
		await invoke('settings_write', { key: 'graph.style', value: null });
		await until('the default graph style back', () => config.graph.style === 0, 5000);
		log('selftest: settings saved, applied (configChanged) and reset; invalid value refused OK');

		/* settings.json beyond the Settings Widget: a dialog default and where the Commit Details
		 * View goes reach the running view. */
		await invoke('settings_write', { key: 'dialog.createBranch.checkOut', value: true });
		await invoke('settings_write', { key: 'commitDetailsView.location', value: 'Docked to Bottom' });
		await until('the dialog default and the docked details applied', () => config.dialogDefaults.createBranch.checkout === true && config.commitDetailsView.location === 1, 5000);
		const commitRow = document.querySelectorAll('#commitTable tr.commit:not([data-hash="*"])')[0];
		const rowBox = commitRow.querySelector('td:nth-child(2)').getBoundingClientRect();
		commitRow.querySelector('td:nth-child(2)').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rowBox.left + 40, clientY: rowBox.top + 8 }));
		(await until('Create Branch in the context menu', () => [...document.querySelectorAll('.contextMenu li.contextMenuItem')].find((li) => /create branch/i.test(li.textContent)))).click();
		const checkOut = await until('the Create Branch dialog', () => [...document.querySelectorAll('.dialog tr')].find((tr) => /check ?out/i.test(tr.cells[0]?.textContent || ''))?.querySelector('input[type=checkbox]'));
		check(checkOut.checked === true, 'Create Branch does not start checked out with dialog.createBranch.checkOut');
		document.getElementById('dialogSecondaryAction').click(); // Cancel
		await until('the dialog closed', () => !checkOut.isConnected, 5000);
		// Details already open (from the start of the self-test) stay where they are: close them first.
		if (document.getElementById('cdv')) {
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			await until('the open details closed', () => !document.getElementById('cdv'), 5000);
		}
		commitRow.querySelector('td:nth-child(2)').click();
		const cdv = await until('the Commit Details View', () => document.getElementById('cdv'));
		check(cdv.classList.contains('docked'), 'the Commit Details View is not docked: ' + cdv.className);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await until('the docked details closed', () => !document.getElementById('cdv'), 5000);
		await invoke('settings_write', { key: 'dialog.createBranch.checkOut', value: null });
		await invoke('settings_write', { key: 'commitDetailsView.location', value: null });
		await until('the defaults back', () => config.dialogDefaults.createBranch.checkout === false && config.commitDetailsView.location === 0, 5000);
		log('selftest: dialog default (Create Branch checks out) and docked Commit Details View from settings.json OK');

		/* State: kept by the Rust side (state.json), not localStorage. */
		store.set('selftest', { at: Date.now() });
		check((await invoke('state_snapshot')).selftest !== undefined, 'the state did not reach state.json');
		store.set('selftest', null);
		check(!('selftest' in (await invoke('state_snapshot'))), 'removing a state key');
		check(Object.keys(localStorage).every((k) => !k.startsWith('gg.') || k === 'gg.diffPrefs'), 'state left in localStorage: ' + Object.keys(localStorage).join(', '));
		log('selftest: state round trip through state.json OK');

		/* Export Repository Configuration, read back as an import would (skipped when the
		 * repository already has the file: it is not ours to overwrite). */
		const exportPath = '.vscode/vscode-git-graph.json';
		if (!(await invoke('worktree_file', { repo: repoRoot, path: exportPath })).exists) {
			const exported = await respond({ command: 'exportRepoConfig', repo: repoRoot });
			check(exported.error === null, 'exportRepoConfig: ' + JSON.stringify(exported));
			const file = await invoke('worktree_file', { repo: repoRoot, path: exportPath });
			const imported = file.exists ? importRepoConfig({ ...store.repoState(repoRoot), lastImportAt: 0 }, file.text) : null;
			await git(repoRoot, ['-c', 'alias.rmx=!rm -f ' + exportPath + ' && (rmdir .vscode 2>/dev/null; true)', 'rmx']);
			check(imported !== null && imported.lastImportAt > 0, 'the exported configuration does not import: ' + (file.text || 'missing'));
			log('selftest: repository configuration exported and read back OK');
		}

		/* The View menu's commands: Find opens the view's find widget. */
		MENU_COMMANDS.find();
		await until('the find widget', () => document.querySelector('.findWidget.active'), 3000);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		log('selftest: View > Find opened the find widget OK');

		/* The theme (theme.js, theme.css). The system accent colour as WebKit resolves it: */
		const probe = document.createElement('div');
		probe.style.cssText = 'position:absolute;visibility:hidden;color:AccentColor;background-color:AccentColorText;outline:1px solid var(--vscode-focusBorder)';
		document.body.appendChild(probe);
		const accent = getComputedStyle(probe);
		const accentInfo = { accent: accent.color, accentText: accent.backgroundColor, focusBorder: accent.outlineColor };
		const button = document.createElement('div');
		button.style.cssText = 'position:absolute;visibility:hidden;color:var(--vscode-button-foreground)';
		document.body.appendChild(button);
		check(getComputedStyle(button).color === 'rgb(255, 255, 255)', 'text on the accent colour is not white: ' + getComputedStyle(button).color);
		button.remove();
		probe.remove();
		check(/^rgb/.test(accentInfo.accent) && accentInfo.focusBorder === accentInfo.accent, 'AccentColor does not resolve: ' + JSON.stringify(accentInfo));
		// Upstream reads these from <html>'s inline style (theme.js copies them there).
		const inline = (name) => document.documentElement.style.getPropertyValue(name).trim();
		check(/^rgba?\(/.test(inline('--vscode-editor-findMatchHighlightBackground')) && /^rgba\(/.test(document.body.style.getPropertyValue('--git-graph-findMatch')),
			'find match colour not handed to the view: ' + JSON.stringify([inline('--vscode-editor-findMatchHighlightBackground'), document.body.style.getPropertyValue('--git-graph-findMatch')]));
		const contrastQuery = window.matchMedia('(prefers-contrast: more)');
		log(`selftest: accent ${accentInfo.accent} (text ${accentInfo.accentText}); prefers-contrast ${contrastQuery.media === 'not all' ? 'UNSUPPORTED' : contrastQuery.matches ? 'more' : 'no-preference'}`);
		// View > Appearance: light and dark, app-wide; the page follows through prefers-color-scheme.
		const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		const appearanceBefore = await invoke('get_appearance');
		for (const [appearance, dark, background] of [['light', false, 'rgb(255, 255, 255)'], ['dark', true, 'rgb(30, 30, 30)']]) {
			await invoke('set_appearance', { appearance });
			await until('the ' + appearance + ' appearance', () => window.matchMedia('(prefers-color-scheme: dark)').matches === dark && document.documentElement.classList.contains('gg-dark') === dark, 5000);
			const bg = getComputedStyle(document.body).backgroundColor, classes = document.body.className;
			check(bg === background && classes.includes(dark ? 'vscode-dark' : 'vscode-light') && document.documentElement.classList.contains('gg-dark') === dark,
				appearance + ': background ' + bg + ', body "' + classes + '"');
		}
		await invoke('set_appearance', { appearance: appearanceBefore });
		// Increase Contrast cannot be switched for one app: forced here, both ways.
		for (const dark of [false, true]) {
			window.__ggTheme.force({ dark, contrast: true });
			const classes = document.body.className;
			check(classes.includes('vscode-high-contrast') && classes.includes('vscode-high-contrast-light') === !dark && !/vscode-(light|dark)\b/.test(classes),
				'high contrast body classes: "' + classes + '"');
			check(token('--vscode-foreground') === (dark ? '#ffffff' : '#000000'), 'high contrast foreground: ' + token('--vscode-foreground'));
		}
		window.__ggTheme.force(null);
		log(`selftest: appearance light and dark (View > Appearance), high contrast light and dark OK; back to ${appearanceBefore}`);

		/* The sidebar: it lists the repositories and marks the one shown; folding it moves the view
		 * back to the window's edge (and brings back the view's own repo dropdown). */
		const viewLeft = () => getComputedStyle(document.getElementById('view')).left;
		const rowsInSidebar = () => [...document.querySelectorAll('#ggRepoList .ggRepo')].map((b) => b.dataset.repo);
		check(JSON.stringify(rowsInSidebar()) === JSON.stringify(windowRepos) && document.querySelector('.ggRepo.current').dataset.repo === repoRoot, 'the sidebar lists ' + JSON.stringify(rowsInSidebar()));
		check(viewLeft() === '220px', 'the view does not start after the sidebar: ' + viewLeft());
		MENU_COMMANDS.sidebar();
		check(document.body.classList.contains('ggSidebarCollapsed') && viewLeft() === '0px' && store.get('sidebar').collapsed === true, 'folding the sidebar: view at ' + viewLeft());
		MENU_COMMANDS.sidebar();
		check(!document.body.classList.contains('ggSidebarCollapsed') && viewLeft() === '220px', 'unfolding the sidebar: view at ' + viewLeft());
		// The view's context menu opens at the cursor, not the sidebar's width to the left of it.
		const cell = document.querySelector('#commitTable tr.commit td:nth-child(2)'), cellBox = cell.getBoundingClientRect();
		const clickX = Math.round(cellBox.left + 40), clickY = Math.round(cellBox.top + 8);
		cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY }));
		const menuBox = (await until('the commit context menu', () => document.querySelector('#view > .contextMenu'))).getBoundingClientRect();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		check(Math.abs(menuBox.left - (clickX + 2)) <= 4, 'the context menu opened at x=' + Math.round(menuBox.left) + ', the cursor was at ' + clickX);
		log('selftest: sidebar lists ' + windowRepos.length + ' repositor' + (windowRepos.length === 1 ? 'y' : 'ies') + ', folds and unfolds; the view\'s context menu opens at the cursor OK');

		/* Another repository: File > Open adds it to the sidebar and shows it in this window; the
		 * sidebar switches back; Open in New Window opens a window on it; Remove takes it out. */
		const otherFolder = (await invoke('scan_repos', { folder: parent })).find((r) => !windowRepos.includes(r));
		if (otherFolder) {
			const originally = repoRoot;
			let newWindows = 0;
			const unlisten = await events.listen('selftest-window', () => { newWindows++; });
			await invoke('open_repo_folder', { folder: otherFolder });
			await until('the other repository in this window', () => repoRoot === otherFolder && document.querySelector('.ggRepo.current')?.dataset.repo === otherFolder);
			document.querySelector('.ggRepo[data-repo="' + CSS.escape(originally) + '"]').click();
			await until('switching back through the sidebar', () => repoRoot === originally && document.querySelector('.ggRepo.current')?.dataset.repo === originally);
			await invoke('open_repo_folder', { folder: originally });
			await new Promise((r) => setTimeout(r, 1500));
			unlisten();
			check(newWindows === 0 && repoRoot === originally, 'opening repositories opened ' + newWindows + ' window(s)');
			const opened = new Promise((resolve) => events.once('selftest-window', (e) => resolve(e.payload)));
			let askpassHere = 0; // the new window's credential prompt must not show in this one
			const watchAskpass = new MutationObserver(() => { if (document.querySelector('#ggAskpass')) askpassHere++; });
			watchAskpass.observe(document.body, { childList: true });
			await invoke('open_new_window', { repo: otherFolder });
			const report = await Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('no report from the new window')), 20000))]);
			watchAskpass.disconnect();
			check(report.label !== 'main' && report.repo === otherFolder && report.repos.includes(originally), 'new window: ' + JSON.stringify(report));
			check(report.askpassShown === true && askpassHere === 0, 'the new window\'s askpass prompt: shown there ' + report.askpassShown + ', here ' + askpassHere + ' time(s)');
			// Dragging its row above the first one moves it to the top, in the list kept for every window.
			const firstBefore = windowRepos[0];
			const row = (repo) => document.querySelector('.ggRepo[data-repo="' + CSS.escape(repo) + '"]');
			const fromBox = row(otherFolder).getBoundingClientRect(), toBox = row(firstBefore).getBoundingClientRect();
			const pointer = (type, target, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, isPrimary: true, clientX: fromBox.left + 30, clientY: y }));
			pointer('pointerdown', row(otherFolder), fromBox.top + 5);
			pointer('pointermove', document, fromBox.top - 10);
			pointer('pointermove', document, toBox.top + 2);
			check(row(firstBefore).classList.contains('ggDropBefore') && row(otherFolder).classList.contains('dragging'), 'no drop line above ' + firstBefore + ' while dragging');
			pointer('pointerup', document, toBox.top + 2);
			check(windowRepos[0] === otherFolder && windowRepos[1] === firstBefore && rowsInSidebar()[0] === otherFolder && store.get('sidebar').repos[0] === otherFolder && repoRoot === originally,
				'dragging ' + otherFolder + ' to the top: ' + JSON.stringify(windowRepos));
			check(document.querySelectorAll('.ggRepo.dragging, .ggRepo.ggDropBefore, .ggRepo.ggDropAfter').length === 0, 'drag marks left behind');
			// Groups: one made through the + menu's dialog; the row dragged onto it lands in it; renamed
			// and deleted through its own menu, which puts the repository back under "default".
			const header = (name) => [...document.querySelectorAll('#ggRepoList .ggGroup')].find((h) => h.textContent === name);
			const menuItem = (text) => [...document.querySelectorAll('.ggMenu .ggMenuItem')].find((i) => i.textContent === text);
			const groupMenu = (name, item) => {
				header(name).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
				menuItem(item).click();
			};
			check(header('default') !== undefined && rowsInSidebar().every((r) => row(r).dataset.group === ''), 'everything starts under "default"');
			document.querySelector('.ggSidebarHead .ggIconBtn').click();
			menuItem('New Group…').click();
			let nameForm = await until('the New Group dialog', () => document.querySelector('#ggGroupName form'));
			nameForm.elements.name.value = 'Default';
			nameForm.requestSubmit();
			check(document.querySelector('#ggGroupName') !== null && !nameForm.querySelector('.ggDialogError').hidden, 'a group named like the default one was accepted');
			nameForm.elements.name.value = 'gg selftest';
			nameForm.requestSubmit();
			await until('the new group in the sidebar', () => header('gg selftest'));
			const rowBox = row(otherFolder).getBoundingClientRect(), groupBox = header('gg selftest').getBoundingClientRect();
			pointer('pointerdown', row(otherFolder), rowBox.top + 5);
			pointer('pointermove', document, rowBox.top + 15);
			pointer('pointermove', document, groupBox.top + 4);
			check(header('gg selftest').classList.contains('ggDropInto'), 'the empty group is not marked while a row is dragged onto it');
			pointer('pointerup', document, groupBox.top + 4);
			check(store.get('sidebar').groupOf[otherFolder] === 'gg selftest' && row(otherFolder).dataset.group === 'gg selftest' && rowsInSidebar().at(-1) === otherFolder && repoRoot === originally,
				'dragging ' + otherFolder + ' into the group: ' + JSON.stringify(store.get('sidebar')));
			// A second group, dragged by its name above the first.
			saveSidebar({ groups: [...store.get('sidebar').groups, 'gg second'] });
			renderSidebar();
			const secondBox = header('gg second').getBoundingClientRect(), firstBox = header('gg selftest').getBoundingClientRect();
			pointer('pointerdown', header('gg second'), secondBox.top + 3);
			pointer('pointermove', document, secondBox.top - 8);
			pointer('pointermove', document, firstBox.top + 2);
			check(header('gg selftest').classList.contains('ggDropBefore') && header('gg second').classList.contains('dragging'), 'no drop line above the first group while dragging the second');
			pointer('pointerup', document, firstBox.top + 2);
			const groupNames = () => [...document.querySelectorAll('#ggRepoList .ggGroup')].map((h) => h.textContent);
			check(JSON.stringify(store.get('sidebar').groups) === '["gg second","gg selftest"]' && JSON.stringify(groupNames()) === '["default","gg second","gg selftest"]'
				&& row(otherFolder).dataset.group === 'gg selftest', 'dragging a group above another: ' + JSON.stringify(groupNames()));
			groupMenu('gg second', 'Delete Group');
			// A click on a group's name folds it away, and its rename keeps it folded.
			await new Promise((r) => setTimeout(r, 0)); // the click right after a drag's release is not one
			header('gg selftest').click();
			check(row(otherFolder) === null && header('gg selftest').classList.contains('folded') && header('gg selftest').dataset.count === '1'
				&& JSON.stringify(store.get('sidebar').foldedGroups) === '["gg selftest"]', 'folding the group: ' + JSON.stringify(store.get('sidebar')));
			groupMenu('gg selftest', 'Rename Group…');
			nameForm = await until('the Rename Group dialog', () => document.querySelector('#ggGroupName form'));
			check(nameForm.elements.name.value === 'gg selftest', 'the dialog starts with the group\'s name');
			nameForm.elements.name.value = 'gg renamed';
			nameForm.requestSubmit();
			await until('the renamed group', () => header('gg renamed'));
			check(header('gg selftest') === undefined && header('gg renamed').classList.contains('folded') && row(otherFolder) === null, 'the renamed group is no longer folded: ' + JSON.stringify(store.get('sidebar')));
			header('gg renamed').click();
			check(store.get('sidebar').foldedGroups.length === 0 && store.get('sidebar').groupOf[otherFolder] === 'gg renamed' && row(otherFolder).dataset.group === 'gg renamed', 'renaming and unfolding the group: ' + JSON.stringify(store.get('sidebar')));
			groupMenu('gg renamed', 'Delete Group');
			check(header('gg renamed') === undefined && row(otherFolder).dataset.group === '' && store.get('sidebar').groups.length === 0 && !(otherFolder in store.get('sidebar').groupOf),
				'deleting the group: ' + JSON.stringify(store.get('sidebar')));
			removeFromSidebar(otherFolder);
			check(!windowRepos.includes(otherFolder) && !rowsInSidebar().includes(otherFolder) && repoRoot === originally, 'removing ' + otherFolder + ' from the sidebar');
			// A folder dropped on the window (Tauri's drag-drop event, as the webview gets it from Finder).
			await events.emitTo({ kind: 'Webview', label: thisWindow.label }, 'tauri://drag-drop', { paths: [otherFolder], position: { x: 400, y: 300 } });
			await until('the dropped folder shown here', () => repoRoot === otherFolder && rowsInSidebar().includes(otherFolder));
			removeFromSidebar(otherFolder);
			await until('back on ' + originally, () => repoRoot === originally);
			log(`selftest: ${otherFolder.split('/').pop()} added and shown here, switched back through the sidebar, opened in window ${report.label} (its askpass prompt only there), dragged to the top, into a new group (reordered, folded, renamed, deleted), removed, dropped on the window OK`);
		}

		if (options.remote) {
			/* The repository as one on another machine. By default it is this one, through a
			 * stand-in for ssh (GG_REMOTE_SSH=tests/fake-ssh.sh) that runs the helper on this Mac;
			 * with GG_SELFTEST_SSH=ssh://user@host[:port]/path it is that repository through the real
			 * ssh, whose questions (host key, password) are answered in the credential prompt.
			 * Added through the dialog, read, written to and watched through the connection; a lost
			 * connection fades its row until clicked. */
			const local = repoRoot, real = options.sshUrl ? parseRemote(options.sshUrl) : null;
			const authority = real ? real.authority : 'selftest@localhost', there = real ? real.path : local;
			const [destination, port = ''] = authority.split(':');
			const remote = 'ssh://' + authority + there;
			const row = (repo) => document.querySelector('.ggRepo[data-repo="' + CSS.escape(repo) + '"]');
			const failure = (promise) => promise.then(() => null, (e) => String((e && e.message) || e));
			const asked = [];
			/** Wait for `cond`, answering ssh's questions meanwhile. */
			const connecting = async (what, cond) => {
				const deadline = performance.now() + 60000;
				while (!cond()) {
					check(performance.now() < deadline, 'timed out waiting for ' + what);
					const input = document.querySelector('#ggAskpass input');
					if (input !== null) {
						const prompt = document.querySelector('#ggAskpass .ggAskpassPrompt').textContent;
						asked.push(prompt.slice(0, 60) + ' (' + input.type + ')');
						input.value = /yes\/no/.test(prompt) ? 'yes' : options.sshPassword;
						document.querySelector('#ggAskpass .ggAskpassOk').click();
					}
					await new Promise((r) => setTimeout(r, 100));
				}
			};
			check((await failure(engine(remote, 'open'))).includes('Not connected'), 'nothing connects by itself');
			addRemote();
			const form = await until('the Add SSH Repository dialog', () => document.querySelector('#ggAddRemote form'));
			form.elements.destination.value = '-oProxyCommand=x';
			form.requestSubmit();
			check(document.querySelector('#ggAddRemote') !== null && !form.querySelector('.ggDialogError').hidden, 'a destination that reads as an ssh option was accepted');
			form.elements.destination.value = destination;
			form.elements.port.value = port;
			form.elements.path.value = there + '/';
			form.requestSubmit();
			await connecting('the remote repository shown here', () => repoRoot === remote && row(remote) !== null && row(remote).classList.contains('current'));
			await until('the remote repository\'s commits', () => document.querySelectorAll('#commitTable tr.commit').length > 1);
			check(document.title.includes('(' + authority + ')') && row(remote).querySelector('.ggRepoHint').textContent.trim() === authority, 'title ' + document.title + ', row ' + row(remote).textContent);
			check((await git(remote, ['rev-parse', '--show-toplevel'])).stdout.trim() === there && await engine(remote, 'repoRoot') === there, 'git and the engine run in ' + there);
			const tracked = (await git(remote, ['ls-files'])).stdout.split('\n')[0];
			const file = await invoke('worktree_file', { repo: remote, path: tracked });
			check(file.exists && (await invoke('repo_operation_state', { repo: remote })).type === null, 'reading ' + tracked + ' of the work tree: ' + JSON.stringify(file).slice(0, 200));
			check((await respond({ command: 'createArchive', repo: remote, ref: 'HEAD' })).error !== null, 'an archive of a remote repository was not refused');
			// A question of the git over there (a fetch asking for a password) is asked here.
			const asking = git(remote, ['-c', 'alias.ap=!"$GIT_ASKPASS" "Password for the other machine: "', 'ap']);
			const question = await answerPrompt('over-there');
			const told = await asking;
			check(question.type === 'password' && question.prompt === 'Password for the other machine:' && told.stdout === 'over-there\n', 'the remote git\'s prompt: ' + JSON.stringify(question) + ' → ' + JSON.stringify(told));
			await until('the prompt to close', () => document.querySelector('#ggAskpass') === null);
			// A branch made behind the view's back (as from a shell on that machine) refreshes it.
			await new Promise((r) => setTimeout(r, 800)); // the watcher there needs a moment to start
			const side = 'gg-selftest-remote-' + Date.now();
			let seen = watcherRefreshes;
			check((await git(remote, ['branch', side])).exitCode === 0, 'creating ' + side);
			await until('a refresh after a branch was made on the other machine', () => watcherRefreshes > seen, 8000);
			seen = watcherRefreshes;
			check((await git(remote, ['branch', '-D', side])).exitCode === 0, 'deleting ' + side);
			await until('a refresh after the branch was deleted', () => watcherRefreshes > seen, 8000);
			// The connection goes away: the row fades, requests fail; a click connects again.
			await invoke('remote_disconnect', { repo: remote });
			await until('the row of the disconnected repository to fade', () => row(remote).classList.contains('missing'));
			check((await failure(engine(remote, 'open'))).includes('Not connected'), 'a request after the connection was lost');
			row(remote).click();
			await connecting('the row to come back after a click', () => !row(remote).classList.contains('missing'));
			check((await git(remote, ['rev-parse', '--show-toplevel'])).stdout.trim() === there, 'git after reconnecting');
			removeFromSidebar(remote);
			if (repoRoot !== local) showInView(local);
			await until('back on ' + local, () => repoRoot === local && row(remote) === null);
			log('selftest: ' + remote + (real ? ' (asked: ' + asked.join('; ') + ')' : ' (stand-in for ssh)') + ' added through the dialog, read, a prompt of its git answered here, branched, watched, disconnected, reconnected by a click, removed OK');
		}

		if (options.httpUrl) {
			/* Real git over HTTP Basic auth: both prompts come through the dialog. The credential
			 * helper is switched off so nothing is read from or stored in the keychain. */
			run = git(repoRoot, ['-c', 'credential.helper=', 'ls-remote', options.httpUrl]);
			const first = await answerPrompt('gg-user');
			const second = await answerPrompt('gg-pass');
			result = await run;
			log(`selftest: http prompts ${JSON.stringify(first.prompt)} (${first.type}), ${JSON.stringify(second.prompt)} (${second.type}); git exit ${result.exitCode}`);
			check(first.type === 'text' && second.type === 'password', 'http prompt types');
		}

		const cs = getComputedStyle(document.body);
		log(`selftest: body bg ${cs.backgroundColor}, classes "${document.body.className}"`);
		log('selftest: PASS');
	} catch (e) {
		log('selftest: FAIL ' + ((e && e.message) || e));
	}
}
