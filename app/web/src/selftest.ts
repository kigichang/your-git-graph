// The built-in end-to-end check (GG_SELFTEST=1, scripts/selftest.sh): drives the app the way a
// person would and reports `selftest: PASS` or `selftest: FAIL …` on stderr (host_log). What it
// covers is listed in docs/spec/99-acceptance.md; it grows with the milestones.
import { cspViolations } from './lib/csp';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { errorText } from './lib/errors';
import { compareSpec, diffSpec, fileSpec, revisions, UNCOMMITTED, WORKTREE, type DiffSpec } from './lib/diffspec';
import { loadRepoInfo, operationState, repoOp, type Commit, type CommitsResponse, type Details, type FileChange, type OpRequest, type RepoInfo } from './lib/api/client';
import { t } from './lib/i18n';
import type { SidebarState } from './lib/sidebar';

const log = (line: string) => invoke('host_log', { line: 'selftest: ' + line }).catch(() => {});

type DetailsView =
	| { kind: 'loading' } | { kind: 'error'; message: string }
	| { kind: 'commit'; details: Details; stash: string | null }
	| { kind: 'compare'; from: string; to: string; files: FileChange[] }
	| { kind: 'tag'; name: string; details: { annotated: boolean; message: string } };
type AppHandle = {
	state: () => { repo: string | null; data: CommitsResponse | null; info: RepoInfo | null; error: string; firstPaintMs: number | null; details: DetailsView | null; branches: string[] | null; menu: unknown; dialog: unknown; ops: { question: unknown; error: { message: string } | null; running: unknown }; sidebar: SidebarState };
	operate: (request: OpRequest) => Promise<boolean>;
	show: (repo: string) => Promise<boolean>;
	openFind: () => void;
	onFindChange: (next: { query: string; caseSensitive: boolean; regex: boolean }) => void;
	onFindStep: (forward: boolean) => void;
	findMatches: () => number[];
	openSettings: () => Promise<void>;
	closeSettings: () => void;
	showPanel: (p: 'reflog' | 'worktrees' | null) => void;
	exportRepoState: () => Promise<string | null>;
	repoState: () => { order: string | null };
	saveRepoState: (patch: Record<string, unknown>) => void;
	addAndShow: (paths: string[]) => Promise<void>;
	removeRepos: (repos: string[]) => Promise<void>;
	saveSidebar: (next: SidebarState) => void;
	load: (max: number) => Promise<void>;
	reload: () => Promise<boolean>;
	table: () => { stats: () => { rows: number; rendered: number; paints: number; selected: number }; scrollTo: (top: number) => void } | undefined;
	setBranches: (b: string[] | null) => Promise<void>;
	selectRow: (row: number) => void;
	compareRows: (a: number, b: number) => void;
	showTag: (name: string) => void;
	closeDetails: () => void;
};
const app = (): AppHandle => (window as unknown as { __gg: { app: AppHandle } }).__gg.app;

type PreviewReport = {
	shown: boolean; error?: string; blocks?: number; coloured?: number; images?: number; katex?: number; mermaid?: number;
	plantuml?: number; notes?: string[]; scripts?: number; synced?: boolean | null;
	remoteWaiting?: number; remoteLoaded?: number; remoteAsked?: number; remoteAnswer?: string | null;
};
type DiffReport = {
	mode: string; title: string; result: { kind: string; error?: string; files?: number; dimensions?: string[]; preview?: PreviewReport };
	workerProblems: string[]; theme: string | null; escape: { findFirst: boolean | null; closes: boolean };
	refused: Record<string, string>; csp: string[];
};

/** A 1×1 PNG, for the image checks. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const bytesOf = (base64: string): number[] => Array.from(atob(base64), (c) => c.charCodeAt(0));

type Check = (ok: boolean, what: string) => void;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settles(cond: () => Promise<boolean> | boolean, ms = 10000): Promise<boolean> {
	for (const end = performance.now() + ms; performance.now() < end; await pause(100)) if (await cond()) return true;
	return cond();
}
const detailsReady = () => settles(() => { const d = app().state().details; return d !== null && d.kind !== 'loading'; });

/** The report of the diff window whose title is `title`, once it has drawn (diff/main.js
 * emits one under GG_SELFTEST); `start` opens the window. */
function reportOf(title: string, start: () => void): Promise<DiffReport> {
	return new Promise<DiffReport>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no report from the diff window "' + title + '" within 30 s')), 30000);
		let unlisten: (() => void) | null = null;
		void listen<DiffReport>('diff-selftest', (event) => {
			if (event.payload.title !== title) return;
			clearTimeout(timer);
			unlisten?.();
			resolve(event.payload);
		}).then((u) => { unlisten = u; start(); });
	});
}

function checkReport(check: Check, report: DiffReport, expectKinds: string[]) {
	const what = report.mode + ' "' + report.title + '"';
	check(expectKinds.includes(report.result.kind), what + ': drew ' + report.result.kind + (report.result.error ? ' (' + report.result.error + ')' : ''));
	check(report.workerProblems.length === 0, what + ': Monaco worker problems ' + JSON.stringify(report.workerProblems));
	check(report.csp.length === 0, what + ': refused by the content security policy: ' + JSON.stringify(report.csp));
	for (const [command, said] of Object.entries(report.refused)) check(said.includes('not allowed'), what + ': a diff window may not call ' + command + ': ' + said);
	check(report.escape.closes, what + ': Esc does not close the window');
	check(report.escape.findFirst !== false, what + ': Esc with the find widget open closed more than the widget');
}

/** 3f: what asks for a load while one is running. A change that arrives then is not lost, and
 * showing a repository then neither fails nor leaves the window unable to load again. */
async function checkLoadsInFlight(check: Check): Promise<void> {
	const repo = app().state().repo;
	if (repo === null) return;
	const running = app().load(300);
	void app().reload();
	await running;
	const first = app().state().data;
	check(await settles(() => app().state().data !== first, 5000), 'a reload asked for during a load runs after it');
	await pause(300);
	const second = app().state().data;
	await pause(500);
	check(app().state().data === second, 'and runs once');

	// Another repository of the sidebar when there is one (a folder of them), else this one again.
	const other = app().state().sidebar.repos.find((r) => r !== repo) ?? repo;
	const superseded = app().load(300);
	const shown = await app().show(other);
	await superseded;
	check(shown && app().state().repo === other && app().state().data !== null, 'a repository shown during a load is shown: ' + app().state().error);
	const before = app().state().data;
	check(await app().reload() && app().state().data !== before, 'the window still loads after that');
	if (other !== repo) {
		check(await app().show(repo), 'and shows the first repository again: ' + app().state().error);
	}
}

/** 1b: the graph the window drew for the repository it opened: rows, their layout, the canvas;
 * on a large repository everything at once, and scrolling through it (the M1 gate). */
async function checkGraph(check: Check): Promise<void> {
	const ready = await settles(() => app().state().data !== null || app().state().error !== '', 30000);
	const s = app().state();
	check(ready && s.data !== null, 'the graph did not load: ' + s.error);
	if (s.data === null) return;
	const table = app().table();
	check(s.data.commits.length > 0, 'no commits');
	check(s.data.layout.nodeLane.length === s.data.commits.length, 'the layout has a lane per row');
	check(s.data.layout.lanes >= 1, 'at least one lane');
	const painted = await settles(() => (table?.stats().paints ?? 0) > 0 && (table?.stats().rendered ?? 0) > 0);
	const stats = table?.stats();
	check(painted, 'the graph canvas was not painted or no row was rendered: ' + JSON.stringify(stats));
	check((stats?.rendered ?? 0) <= 80, 'only the rows in view are in the DOM: ' + stats?.rendered);
	check(document.querySelectorAll('.gg-row').length === stats?.rendered, 'the DOM rows match the table');
	await log(`graph ${s.data.commits.length} rows, ${s.data.layout.lanes} lanes, ${stats?.rendered} rendered, first paint ${s.firstPaintMs?.toFixed(0)} ms`);
	const again = performance.now();
	await app().load(300);
	await log(`graph: warm reload of 300 in ${(performance.now() - again).toFixed(0)} ms`);
	if (s.data.more) {
		const started = performance.now();
		await app().load(100000);
		const all = app().state().data;
		const loadMs = performance.now() - started;
		if (all !== null && all.commits.length > 5000 && table) {
			await log(`bench: ${all.commits.length} commits loaded in ${loadMs.toFixed(0)} ms (${JSON.stringify(all.timing)})`);
			const total = all.commits.length * 24;
			const frames: number[] = [];
			await new Promise<void>((done) => {
				const begin = performance.now();
				let last = begin;
				const step = (now: number) => {
					frames.push(now - last);
					last = now;
					const t = (now - begin) / 3000;
					if (t >= 1) return done();
					table.scrollTo(t * total);
					requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			});
			frames.shift();
			const avg = frames.reduce((a, b) => a + b, 0) / frames.length, worst = Math.max(...frames);
			await log(`bench: scrolled ${all.commits.length} rows in 3 s: ${frames.length} frames, avg ${avg.toFixed(1)} ms, worst ${worst.toFixed(0)} ms, ${table.stats().paints} paints`);
			check(avg < 20, 'scrolling at 50 fps or better (avg ' + avg.toFixed(1) + ' ms)');
			await pause(9000); // time to read the process's memory from outside, twice
			table.scrollTo(0);
			await app().load(300);
		}
	}
}

/** 3, 4, 9, 1: the details of a commit (with its files counted), of a comparison and of a
 * tag; a file's change and the file itself in diff windows; the comparison window. */
async function checkDetails(check: Check): Promise<void> {
	const { data, info, repo } = app().state();
	if (data === null || repo === null) return;
	check(info !== null && info.branches.length > 0, 'repo info has branches');
	// A commit with a text file added or modified, among the first rows.
	let row = -1, change: FileChange | null = null, commit: Commit | null = null;
	for (let i = 0; i < Math.min(50, data.commits.length) && change === null; i++) {
		const c = data.commits[i] as Commit;
		if (c.hash === '*' || c.stash !== null) continue;
		app().selectRow(i);
		await detailsReady();
		const d = app().state().details;
		if (d?.kind === 'commit') {
			const found = d.details.files.find((f) => (f.status === 'M' || f.status === 'A') && !/\.(png|jpg|gif|icns|ico)$/i.test(f.newPath));
			if (found) { row = i; change = found; commit = c; }
		}
	}
	check(change !== null, 'a commit with an added or modified text file among the first 50 rows');
	if (change === null || commit === null) return;
	const d = app().state().details;
	check(d?.kind === 'commit' && d.details.hash === commit.hash && d.details.body.length > 0, 'the details are the selected commit\'s');
	check(app().table()?.stats().selected === row, 'the row is selected');
	const counted = await settles(() => { const v = app().state().details; return v?.kind === 'commit' && v.details.files.some((f) => f.additions !== null); });
	check(counted, 'the files get their line counts');
	check(document.querySelectorAll('.gg-details .gg-file').length > 0, 'the files are listed');
	const counts = document.querySelector('.gg-details .gg-counts')?.textContent ?? '';
	check(/^\( \+\d+ \| -\d+ \)$/.test(counts), 'a file shows its lines added and removed: ' + counts);
	const fields = document.querySelector('.gg-details .gg-fields')?.textContent ?? '';
	if (d?.kind === 'commit') {
		check(fields.includes(d.details.hash) && fields.includes(d.details.committer) && fields.includes(new Date(d.details.authorDate * 1000).toString()), 'the details show the hash, the committer and the whole date');
		const mail = document.querySelector<HTMLAnchorElement>('.gg-details .gg-fields a[href^="mailto:"]');
		check(mail?.textContent === d.details.authorEmail, 'the author\'s email is a link: ' + mail?.textContent);
	}
	// The icons beside the files: how they are shown (a setting), their folders.
	const tool = (name: string) => document.querySelector<HTMLButtonElement>('.gg-details .gg-tool-' + name);
	const fileRows = () => document.querySelectorAll('.gg-details .gg-file').length;
	const pressed = (name: string) => tool(name)?.getAttribute('aria-pressed') === 'true';
	const total = fileRows();
	check(pressed('list') && tool('collapse')?.disabled === true && tool('expand')?.disabled === true, 'as a list: nothing to collapse');
	tool('tree')?.click();
	check(await settles(() => pressed('tree') && !pressed('list')), 'the tree icon shows the files as a tree');
	const savedView = (await invoke<{ settings: { details: { fileView: string } } }>('settings_get')).settings.details.fileView;
	check(savedView === 'tree', 'and it is the setting: ' + savedView);
	check(fileRows() === total, 'the tree has every file');
	if (d?.kind === 'commit' && d.details.files.some((f) => f.newPath.includes('/'))) {
		const atRoot = d.details.files.filter((f) => !f.newPath.includes('/')).length;
		tool('collapse')?.click();
		check(await settles(() => fileRows() === atRoot), 'collapse all leaves the files outside any folder: ' + fileRows() + ' of ' + total);
		tool('expand')?.click();
		check(await settles(() => fileRows() === total), 'expand all shows them again');
	}
	tool('list')?.click();
	check(await settles(() => pressed('list') && fileRows() === total), 'the list icon shows the list again');
	await log(`details of ${commit.hash.slice(0, 8)}: ${d?.kind === 'commit' ? d.details.files.length : 0} files`);

	// The file's change (click) and the file itself (⌘-click), each in a diff window.
	const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.gg-details .gg-file')).find((b) => b.title === (change as FileChange).newPath || b.title.endsWith(' → ' + (change as FileChange).newPath));
	check(button !== undefined, 'the file has a row in the list');
	if (button !== undefined) {
		const ch = change;
		const diff = await reportOf(diffSpec(repo, commit.hash, commit.hash, ch.oldPath, ch.newPath, ch.status).title, () => button.click());
		checkReport(check, diff, ['text', 'image', 'binary']);
		await log('diff ' + JSON.stringify(diff.result));
		const file = await reportOf(fileSpec(repo, revisions(commit.hash, commit.hash).right, ch.newPath).title,
			() => button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
		checkReport(check, file, ['file', 'image', 'binary']);
		await log('file ' + JSON.stringify(file.result));
	}

	// A comparison: the selected commit against an older one.
	const other = Math.min(data.commits.length - 1, row + 2);
	if (other > row) {
		app().compareRows(row, other);
		await detailsReady();
		const v = app().state().details;
		check(v?.kind === 'compare' && v.from === (data.commits[other] as Commit).hash && v.to === commit.hash, 'the comparison runs from the older commit to the newer');
		check(v?.kind === 'compare' && v.files.length > 0, 'the comparison lists files');
		const spec: DiffSpec = compareSpec(repo, (data.commits[other] as Commit).hash, commit.hash);
		const report = await reportOf(spec.title, () => { void invoke('open_diff_window', { spec: JSON.stringify(spec), title: spec.title }); });
		checkReport(check, report, ['compare']);
		check((report.result.files ?? 0) >= 1, 'compare: no files listed');
		await log('compare ' + JSON.stringify(report.result));
	}

	// The branch filter: one branch (a remote one when there is any), then all again.
	if (info !== null && info.branches.length > 0) {
		const branch = info.branches.find((b) => b.startsWith('remotes/') && !b.endsWith('/HEAD')) ?? (info.branches[0] as string);
		const all = data.commits.length;
		await app().setBranches([branch]);
		const filtered = app().state();
		check(filtered.error === '' && filtered.data !== null && filtered.data.commits.length > 0 && filtered.data.commits.length <= all, `the graph of branch ${branch}: ${filtered.error || filtered.data?.commits.length}`);
		await log(`branch filter ${branch}: ${filtered.data?.commits.length} of ${all} rows`);
		await app().setBranches(null);
		check(app().state().data?.commits.length === all, 'all branches again');
	}

	// A tag, when the repository has one.
	const tag = data.commits.flatMap((c) => c.tags)[0];
	if (tag !== undefined) {
		app().showTag(tag.name);
		await detailsReady();
		const v = app().state().details;
		check(v?.kind === 'tag' && v.name === tag.name && v.details.annotated === tag.annotated, 'the tag\'s details: ' + JSON.stringify(v));
	}

	// Esc closes the panel; the diff windows closed themselves (Esc): only this window is left.
	document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	check(await settles(() => app().state().details === null), 'Esc closes the details');
	// Enter brings the selected row's details back; Esc closes them again.
	const selectedRow = app().table()?.stats().selected ?? -1;
	document.querySelector('.gg-viewport')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	await detailsReady();
	const reopened = app().state().details;
	check(selectedRow >= 0 && reopened !== null && reopened.kind === 'commit' && reopened.details.hash === app().state().data?.commits[selectedRow]?.hash,
		'Enter opens the selected row\'s details again: ' + selectedRow + ' ' + reopened?.kind);
	document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	check(await settles(() => app().state().details === null), 'and Esc closes them');
	const closed = await settles(async () => (await getAllWindows()).length === 1);
	check(closed, 'diff windows still open: ' + (await getAllWindows()).map((w) => w.label).join(', '));
}

/** 2, 4 (reflog, worktrees), 16, 17: the language switches in place; the reflog and worktree
 * panels read; the repository's config file is exported once and taken back when newer; the
 * find widget finds, steps and closes. */
async function checkPanelsAndMore(check: Check): Promise<void> {
	const { repo, data } = app().state();
	if (repo === null || data === null) return;
	// Language: Traditional Chinese reaches the toolbar and the sidebar without a reload; back to English.
	await invoke('settings_set', { key: 'language', value: 'zh-TW' });
	check(await settles(() => document.querySelector('.gg-sidebar .gg-title')?.textContent === '儲存庫'), 'the sidebar title is in Chinese');
	check(await settles(() => Array.from(document.querySelectorAll('.gg-toolbar .gg-button')).some((b) => b.textContent === '擷取')), 'the toolbar is in Chinese');
	const file = await invoke<{ settings: { language: string } }>('settings_get');
	check(file.settings.language === 'zh-TW', 'settings.json says zh-TW');
	await invoke('settings_set', { key: 'language', value: null });
	check(await settles(() => document.querySelector('.gg-sidebar .gg-title')?.textContent === 'Repositories'), 'back to English');
	// The reflog and worktree panels.
	app().showPanel('reflog');
	check(await settles(() => document.querySelectorAll('.gg-panel .gg-row').length > 0), 'the reflog lists entries');
	app().showPanel('worktrees');
	check(await settles(() => document.querySelectorAll('.gg-panel .gg-row').length >= 1), 'the worktree panel lists the main worktree');
	app().showPanel(null);
	// The repository's config file: exported once; a newer one is taken in when the repository is shown.
	// Exported from the settings' button once; a second time the file is left alone.
	await app().openSettings();
	const exportButton = await settles(() => document.querySelector('.gg-settings .gg-export') !== null);
	check(exportButton, 'the settings have the Export Repository Configuration button');
	document.querySelector<HTMLButtonElement>('.gg-settings .gg-export')?.click();
	check(await settles(() => (document.querySelector('.gg-settings .gg-note')?.textContent ?? '').includes('.your-git-graph.json')), 'the config file is written and the panel says where');
	check((await invoke<{ exists: boolean }>('worktree_file', { repo, path: '.your-git-graph.json' })).exists, 'the file is there');
	document.querySelector<HTMLButtonElement>('.gg-settings .gg-export')?.click();
	check(await settles(() => document.querySelector('.gg-settings .gg-error')?.textContent === t('settings.repoConfig.exists')), 'not written over an existing one, and the panel says so');
	check((await app().exportRepoState()) === null, 'nor through the app');
	app().closeSettings();
	const newer = JSON.stringify({ version: 1, exportedAt: Math.floor(Date.now() / 1000) + 10, order: 'topo' });
	await invoke('export_repo_config', { repo, contents: newer });
	await app().show(repo);
	check(app().repoState().order === 'topo', 'a newer file is imported when the repository is shown: ' + JSON.stringify(app().repoState()));
	app().saveRepoState({ order: null });
	await app().operate({ kind: 'cleanUntracked', directories: false }); // the file is untracked: gone again
	// The details inline: right below the row, the next row below them; a panel already open
	// stays where it is when the setting changes, the next one opens docked; Esc closes.
	const location = (where: string | null) => invoke('settings_set', { key: 'details.location', value: where });
	const esc = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	app().closeDetails();
	await location('inline');
	const row = data.commits.findIndex((c) => c.hash !== '*' && c.stash === null);
	if (row >= 0 && row + 1 < data.commits.length) {
		await settles(() => (app().state() as unknown as { settings: { details: { location: string } } }).settings.details.location === 'inline');
		app().selectRow(row);
		check(await settles(() => document.querySelector('.gg-gap .gg-details') !== null), 'the details open inline');
		const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
		const panel = rect('.gg-gap'), own = rect(`.gg-row[aria-rowindex="${row + 1}"]`), next = rect(`.gg-row[aria-rowindex="${row + 2}"]`);
		check(panel !== undefined && own !== undefined && Math.abs(panel.top - own.bottom) < 1, 'inline: right below its row');
		check(panel !== undefined && next !== undefined && next.top >= panel.bottom - 1, 'inline: the next row below the details');
		check(document.querySelectorAll('.gg-details').length === 1, 'inline: not docked as well');
		const graphColumn = rect(`.gg-row[aria-rowindex="${row + 1}"] .gg-col-graph`), canvas = document.querySelector<HTMLCanvasElement>('.gg-graph-canvas');
		check(panel !== undefined && graphColumn !== undefined && Math.abs(panel.left - graphColumn.right) < 1, 'inline: beside the graph column');
		const scale = canvas !== null && graphColumn !== undefined ? canvas.width / graphColumn.width : 1;
		const strip = canvas !== null && panel !== undefined ? canvas.getContext('2d')?.getImageData(0, Math.round((panel.top + 20 - canvas.getBoundingClientRect().top) * scale), canvas.width, 1).data : undefined;
		check((data.commits[row]?.parents.length ?? 0) === 0 || (strip !== undefined && strip.some((_, i) => i % 4 === 3 && strip[i] !== 0)), 'inline: the graph\'s lines run on beside the details');
		const parent = data.commits[row]?.parents[0], link = document.querySelector<HTMLAnchorElement>('.gg-gap .gg-fields a[href^="#"]');
		check(parent === undefined || link !== null, 'a parent is a link');
		if (parent !== undefined && link !== null && data.commits.some((c) => c.hash === parent)) {
			link.click();
			const parentShown = () => { const v = app().state().details; return v?.kind === 'commit' && v.details.hash === parent; };
			check(await settles(parentShown), 'the parent\'s link shows the parent');
			check(app().state().data?.commits[app().table()?.stats().selected ?? -1]?.hash === parent, 'and selects its row');
			app().closeDetails();
			app().selectRow(row);
			await settles(() => document.querySelector('.gg-gap .gg-fields') !== null);
		}
		await location('bottom');
		await pause(300);
		check(document.querySelector('.gg-gap .gg-details') !== null, 'an open panel stays where it is when the setting changes');
		esc();
		check(await settles(() => app().state().details === null && document.querySelector('.gg-gap') === null), 'Esc closes the inline details');
		app().selectRow(row);
		check(await settles(() => document.querySelector('.gg-details') !== null && document.querySelector('.gg-gap') === null), 'the next one opens docked');
		app().closeDetails();
		await location(null);
	} else await location(null);
	// Find.
	const word = (data.commits.find((c) => c.hash !== '*')?.message.split(/\s+/)[0] ?? 'a').toLowerCase();
	app().openFind();
	check(await settles(() => document.querySelector('.gg-find input') !== null), 'the find widget opens');
	app().onFindChange({ query: word, caseSensitive: false, regex: false });
	check(await settles(() => app().findMatches().length > 0), 'matches for "' + word + '"');
	const matches = app().findMatches();
	check(app().table()?.stats().selected === matches[0], 'the first match is selected');
	if (matches.length > 1) {
		app().onFindStep(true);
		check(app().table()?.stats().selected === matches[1], 'Enter steps to the next match');
	}
	check(document.querySelectorAll('.gg-row.highlighted').length > 0, 'matches are highlighted');
	// Esc on the graph with the widget open closes the widget only, not the details as well.
	const withDetails = await detailsReady();
	document.querySelector('.gg-viewport')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	check(await settles(() => document.querySelector('.gg-find') === null), 'Esc on the graph closes the find widget');
	if (withDetails) { await pause(200); check(app().state().details !== null, 'and leaves the details open'); }
	app().openFind();
	check(await settles(() => document.querySelector('.gg-find input') !== null), 'the find widget opens again');
	(document.querySelector('.gg-find input') as HTMLElement | null)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	check(await settles(() => document.querySelector('.gg-find') === null), 'Esc closes the find widget');
	// The settings drawer opens and closes.
	await app().openSettings();
	check(await settles(() => document.querySelector('.gg-settings') !== null), 'the settings open');
	app().closeSettings();
	check(await settles(() => document.querySelector('.gg-settings') === null), 'and close');
}

/** 14 (the part M2 has): the settings are read; a value out of range is refused; a change is
 * applied to the window (the row height) and announced; the default comes back. */
async function checkSettings(check: Check): Promise<void> {
	const s = (app().state() as unknown as { settings: { graph: { rowHeight: number } } }).settings;
	check(s.graph.rowHeight === 24, 'the settings start at their defaults in a fresh data directory');
	let refused = false;
	await invoke('settings_set', { key: 'graph.rowHeight', value: 99 }).catch((e) => { refused = String(e).includes('16 to 48'); });
	check(refused, 'a row height of 99 is refused with the range');
	await invoke('settings_set', { key: 'graph.rowHeight', value: 32 });
	const applied = await settles(() => (app().state() as unknown as { settings: { graph: { rowHeight: number } } }).settings.graph.rowHeight === 32
		&& document.querySelector('.gg-row')?.getBoundingClientRect().height === 32);
	check(applied, 'a changed row height reaches the window and its rows');
	await invoke('settings_set', { key: 'graph.rowHeight', value: null });
	check(await settles(() => (app().state() as unknown as { settings: { graph: { rowHeight: number } } }).settings.graph.rowHeight === 24), 'null brings the default back');
	// The date shown: the author's by default (git reads them for the listed commits), the
	// committer's (the engine's own) when chosen.
	const datesMs = () => app().state().data?.timing.datesMs ?? -1;
	check(await settles(() => datesMs() > 0), 'author dates are read by default: ' + datesMs());
	await invoke('settings_set', { key: 'commits.dateType', value: 'commit' });
	check(await settles(() => datesMs() === 0), 'the commit date: no author dates read');
	await invoke('settings_set', { key: 'commits.dateType', value: null });
	check(await settles(() => datesMs() > 0), 'back to the author date');
	// Commits only the reflog mentions: git is asked (the revert on the test's deleted branch is one).
	const shown = app().state().data?.commits.length ?? 0;
	await invoke('settings_set', { key: 'commits.includeReflog', value: true });
	check(await settles(() => (app().state().data?.timing.reflogMs ?? 0) > 0), 'the reflog is read when asked');
	await log(`reflog: ${shown} → ${app().state().data?.commits.length} rows`);
	check((app().state().data?.commits.length ?? 0) >= shown, 'the reflog only adds rows');
	await invoke('settings_set', { key: 'commits.includeReflog', value: null });
	check(await settles(() => app().state().data?.timing.reflogMs === 0 && app().state().data?.commits.length === shown), 'and they go again');
	// The header: at the top by default, scrolled away with the rows when not sticky.
	const stuck = () => document.querySelector('.gg-table > .gg-header') !== null;
	const scrolling = () => document.querySelector('.gg-viewport > .gg-header') !== null;
	check(stuck() && !scrolling(), 'the header stays at the top by default');
	await invoke('settings_set', { key: 'graph.stickyHeader', value: false });
	check(await settles(() => !stuck() && scrolling()), 'not sticky, the header scrolls with the rows');
	const firstRow = document.querySelector<HTMLElement>('.gg-viewport .gg-row');
	const header = document.querySelector<HTMLElement>('.gg-viewport > .gg-header');
	check(firstRow !== null && header !== null && Math.abs(firstRow.getBoundingClientRect().top - header.getBoundingClientRect().bottom) <= 1, 'the first row starts below the header');
	await invoke('settings_set', { key: 'graph.stickyHeader', value: null });
	check(await settles(() => stuck() && !scrolling()), 'sticky again');
	// The line style: the graph is drawn again with straight lines.
	const paints = app().table()?.stats().paints ?? 0;
	await invoke('settings_set', { key: 'graph.style', value: 'angular' });
	check(await settles(() => (app().table()?.stats().paints ?? 0) > paints), 'the angular graph is drawn');
	await invoke('settings_set', { key: 'graph.style', value: null });
	// The session log: written while log.enabled is on.
	await invoke('settings_set', { key: 'log.enabled', value: true });
	await log('session log marker');
	await invoke('settings_set', { key: 'log.enabled', value: null });
}

/** 6 (the dialogs), 9: the context menu and the dialogs, driven as a person would: a branch is
 * created from the menu of a row and deleted from the menu of its label; the question before
 * losing work and the error after a failure show up as dialogs. */
async function checkMenusAndDialogs(check: Check): Promise<void> {
	const { repo, data } = app().state();
	if (repo === null || data === null) return;
	const branch = 'gg-selftest-ui-' + Date.now().toString(36);
	const row = data.commits.findIndex((c) => c.hash !== '*' && c.stash === null);
	if (row < 0) return;
	const rowEl = () => document.querySelector(`.gg-row[aria-rowindex="${row + 1}"]`);
	const menuItem = (id: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.gg-menu .gg-item')).find((b) => b.textContent?.trim() === t(('menu.' + id) as never));
	const press = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

	// The row's menu: Create Branch… → the dialog → the name typed → Enter.
	rowEl()?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
	check(await settles(() => document.querySelector('.gg-menu') !== null), 'the context menu opens on a row');
	check(menuItem('createBranch') !== undefined && menuItem('copyHash') !== undefined, 'the menu lists the commit actions');
	menuItem('createBranch')?.click();
	check(await settles(() => document.querySelector('.gg-box input[type=text]') !== null), 'the Create Branch dialog opens');
	const input = document.querySelector<HTMLInputElement>('.gg-box input[type=text]');
	if (input) {
		input.value = branch;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		press(input, 'Enter');
	}
	check(await settles(() => app().state().data?.commits.some((c) => c.heads.includes(branch)) === true, 20000), 'the branch appears in the graph after the dialog');
	check(document.querySelector('.gg-box') === null, 'the dialog closed');

	// The label's menu: Delete… → the dialog → Enter.
	const label = Array.from(document.querySelectorAll('.gg-ref-head')).find((e) => e.textContent === branch);
	check(label !== undefined, 'the branch has a label');
	label?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
	check(await settles(() => menuItem('deleteBranch') !== undefined), 'the label\'s menu offers Delete');
	menuItem('deleteBranch')?.click();
	check(await settles(() => document.querySelector('.gg-box') !== null), 'the Delete Branch dialog opens');
	const box = document.querySelector('.gg-box');
	if (box) press(box, 'Enter');
	check(await settles(() => app().state().data?.commits.some((c) => c.heads.includes(branch)) === false, 20000), 'the branch is gone after the dialog');

	// A failure shows the error dialog: a branch that exists cannot be created again.
	const existing = data.commits.flatMap((c) => c.heads)[0];
	if (existing !== undefined) {
		void app().operate({ kind: 'createBranch', branch: existing, commit: (data.commits[row] as Commit).hash, checkout: false, force: false });
		check(await settles(() => app().state().ops.error !== null), 'the failure shows up');
		check(await settles(() => document.querySelector('.gg-errortext')?.textContent?.includes('already exists') === true), 'the error dialog shows git\'s message');
		const close = Array.from(document.querySelectorAll<HTMLButtonElement>('.gg-ok')).find((b) => b.textContent === t('dialog.close'));
		close?.click();
		check(await settles(() => app().state().ops.error === null), 'Close takes the error away');
	}
	// Esc closes an open menu.
	rowEl()?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
	await settles(() => document.querySelector('.gg-menu') !== null);
	press(document.body, 'Escape');
	check(await settles(() => document.querySelector('.gg-menu') === null), 'Esc closes the menu');
}

/** 5, 6, 7: operations through repo_op. A branch of the test's own is created, given a commit
 * (a revert), force-moved - which asks first, then runs once confirmed - and deleted; a fetch
 * from the repository itself streams git's words; a fetch that cannot connect is cancelled.
 * Everything made is removed again. */
async function checkOps(check: Check): Promise<void> {
	const { repo, data } = app().state();
	if (repo === null || data === null) return;
	const branch = 'gg-selftest-' + Date.now().toString(36);
	const head = data.commits.find((c) => c.hash !== '*' && c.stash === null)?.hash;
	if (head === undefined) return;
	const run = (request: OpRequest, confirmed = false) => repoOp(repo, request, { confirmed }).result;
	// Only the sidebar's repositories are served: another path is refused before git runs,
	// for reads, operations, the engine and the working tree's files alike.
	const other = repo.replace(/\/?$/, '/..');
	const refusal = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return errorText(e); } };
	for (const [what, p] of [
		['read', operationState(other)],
		['operation', repoOp(other, { kind: 'deleteBranch', branch: 'gg-selftest-none', force: false, deleteOnRemotes: [] }).result],
		['engine', invoke('engine_request', { repo: other, request: '{"method":"close"}' })],
		['file', invoke('worktree_file', { repo: other, path: 'README.md' })],
		['open file', invoke('open_repo_file', { repo: other, path: 'README.md' })],
		['reveal', invoke('reveal_repo', { repo: other })],
		['terminal', invoke('open_terminal', { repo: other })]
	] as [string, Promise<unknown>][]) {
		const said = await refusal(p);
		check(said.includes('is not in the sidebar'), 'a repository not in the sidebar is refused (' + what + '): ' + said);
	}
	const engineMethod = await refusal(invoke('engine_request', { repo, request: '{"method":"submodules"}' }));
	check(engineMethod.includes('not available'), 'a page only reads what a diff window needs of the engine: ' + engineMethod);
	try {
		check((await run({ kind: 'createBranch', branch, commit: head, checkout: true, force: false })).kind === 'done', 'create and check out the branch');
		const revert = await run({ kind: 'revert', commit: head, parentIndex: 0 });
		check(revert.kind === 'done', 'revert HEAD on the branch: ' + JSON.stringify(revert));
		const info = await loadRepoInfo(repo, { showRemoteBranches: false, showRemoteHeads: false, hideRemotes: [], showStashes: false });
		check(info.branches.includes(branch) && info.head === branch, 'the branch is listed and checked out');
		check((await run({ kind: 'checkoutBranch', branch: info.branches.find((b) => b !== branch) ?? 'main', remoteBranch: null, pullAfterwards: null })).kind === 'done', 'back to the original branch');
		const move: OpRequest = { kind: 'createBranch', branch, commit: head, checkout: false, force: true };
		const asked = await run(move);
		check(asked.kind === 'needsConfirmation' && asked.reasons.length === 1 && asked.reasons[0]?.kind === 'branchMoveDropsCommits' && asked.reasons[0].count === 1,
			'force-moving the branch asks about its commit: ' + JSON.stringify(asked));
		// Through the window: the question is a dialog with the reason; Continue runs it.
		const moving = app().operate(move);
		check(await settles(() => app().state().ops.question !== null), 'the question shows as a dialog');
		const reason = document.querySelector('.gg-reasons li')?.textContent ?? '';
		check(/1 commit\(s\) of gg-selftest-.* will be on no other branch/.test(reason), 'the dialog words the reason: ' + reason);
		(Array.from(document.querySelectorAll<HTMLButtonElement>('.gg-ok')).find((b) => b.textContent === t('dialog.continue')))?.click();
		check(await moving, 'confirmed in the dialog, it runs');
		await log(`ops: branch ${branch} created, reverted, moved with confirmation`);

		// Progress: a fetch from the repository itself says "From …" on stderr.
		const lines: string[] = [];
		const fetch = repoOp(repo, { kind: 'addRemote', name: branch, url: repo, pushUrl: null, fetch: true }, { onProgress: (p) => { if (p.kind === 'output') lines.push(p.text); } });
		check((await fetch.result).kind === 'done', 'add a remote and fetch it');
		check(lines.some((l) => l.includes('From ')), 'the fetch streamed its output: ' + JSON.stringify(lines));
		check((await run({ kind: 'deleteRemote', name: branch })).kind === 'done', 'remove the remote');

		// Cancel: a fetch from an address that never answers (TEST-NET-1 is black-holed) is
		// killed. Without a route out, git fails at once instead: then there is nothing to cancel.
		const hanging = repoOp(repo, { kind: 'addRemote', name: branch + '-x', url: 'http://192.0.2.1/x.git', pushUrl: null, fetch: true });
		await pause(500);
		const started = performance.now();
		const inFlight = await hanging.cancel();
		const outcome = await hanging.result;
		if (inFlight) check(outcome.kind === 'failed' && outcome.message === 'Cancelled.' && performance.now() - started < 5000, 'cancelled promptly: ' + JSON.stringify(outcome));
		else await log('cancel: skipped, the fetch ended by itself at once (' + JSON.stringify(outcome) + ')');
		await run({ kind: 'deleteRemote', name: branch + '-x' });
	} finally {
		const gone = await run({ kind: 'deleteBranch', branch, force: true, deleteOnRemotes: [] });
		check(gone.kind === 'done', 'the branch is deleted again: ' + JSON.stringify(gone));
		await app().load(300);
	}
}

/** 12, 18: the sidebar: the repositories of the folder, switching between them, collapsing,
 * groups, removing and adding back, a new window, a folder dropped on the window. */
async function checkSidebar(check: Check): Promise<void> {
	const s = app().state();
	const repos = s.sidebar.repos;
	check(repos.length >= 1 && s.repo !== null && repos.includes(s.repo), 'the shown repository is in the sidebar: ' + JSON.stringify(repos));
	check(document.querySelectorAll('.gg-sidebar .gg-repo').length === repos.length, 'the sidebar lists every repository');
	check(document.querySelector('.gg-sidebar .gg-repo.current')?.getAttribute('data-repo') === s.repo, 'the shown one is marked');
	const first = s.repo as string;
	// Collapse and expand.
	app().saveSidebar({ ...s.sidebar, collapsed: true });
	check(await settles(() => document.querySelector('.gg-sidebar') === null && document.querySelector('.gg-expand') !== null), 'collapsed: no sidebar, an expand button');
	(document.querySelector('.gg-expand') as HTMLButtonElement | null)?.click();
	check(await settles(() => document.querySelector('.gg-sidebar') !== null), 'expanded again');
	if (repos.length >= 2) {
		const other = repos.find((r) => r !== first) as string;
		// Switch to another repository and back.
		await app().show(other);
		check(app().state().repo === other && app().state().data !== null, 'the other repository is shown');
		check(document.querySelector('.gg-sidebar .gg-repo.current')?.getAttribute('data-repo') === other, 'the sidebar follows');
		// A group: made, the other repository moved in, renamed, folded, deleted.
		const sb = () => app().state().sidebar;
		app().saveSidebar({ ...sb(), groups: ['work'] });
		check(await settles(() => document.querySelectorAll('.gg-sidebar .gg-group').length === 2), 'a new group shows as a section');
		app().saveSidebar({ ...sb(), groupOf: { [other]: 'work' } });
		check(await settles(() => document.querySelector('.gg-sidebar .gg-section[data-group="work"] .gg-repo') !== null), 'the repository is in the group');
		app().saveSidebar({ ...sb(), groups: ['job'], groupOf: { [other]: 'job' }, foldedGroups: ['job'] });
		check(await settles(() => document.querySelector('.gg-sidebar .gg-group.folded .gg-count')?.textContent === '1'), 'renamed and folded: the count shows');
		app().saveSidebar({ ...sb(), groups: [], groupOf: {}, foldedGroups: [] });
		check(await settles(() => document.querySelectorAll('.gg-sidebar .gg-group').length === 1), 'the group is gone, its repository back in default');
		// Remove the shown one: the first takes over; add it back.
		await app().removeRepos([other]);
		check(app().state().repo === first && !app().state().sidebar.repos.includes(other), 'removing the shown repository shows another');
		await app().addAndShow([other]);
		check(app().state().repo === other && app().state().sidebar.repos.includes(other), 'added back and shown');
		await app().show(first);
	}
	// A folder dropped on the window (the event Tauri sends) adds it.
	const dropped = app().state().sidebar.repos[0] as string;
	await app().removeRepos([dropped]);
	await emit('tauri://drag-drop', { type: 'drop', paths: [dropped], position: { x: 10, y: 10 } });
	const added = await settles(() => app().state().sidebar.repos.includes(dropped) && app().state().repo === dropped, 15000);
	check(added, 'a dropped folder is added and shown');
	if (!added) await app().addAndShow([dropped]);
	// A new window on the shown repository, then closed.
	const before = (await getAllWindows()).length;
	await invoke('open_new_window', { repo: app().state().repo });
	check(await settles(async () => (await getAllWindows()).length === before + 1), 'a new window opens');
	const extra = (await getAllWindows()).find((w) => w.label !== getCurrentWindow().label && w.label.startsWith('repo-'));
	await extra?.close();
	check(await settles(async () => (await getAllWindows()).length === before), 'and closes');
	await log(`sidebar: ${repos.length} repositories, groups and switching checked`);
}

/** 8 (and 20, for a repository on another machine): git's questions. A fetch from an address
 * that wants a name and a password (GG_SELFTEST_HTTP: tests/basic_auth_server.py, which logs
 * what it gets and refuses it) brings the dialog up twice - the name in clear, the password
 * masked - and the fetch fails, refused. Cancelled in the dialog, it fails too. Cancelled as an
 * operation while the question is up, the dialog is taken down. */
async function checkAskpass(check: Check, config: Record<string, unknown>, repo: string): Promise<void> {
	const url = config['httpUrl'];
	if (typeof url !== 'string') { await log('askpass: skipped (GG_SELFTEST_HTTP not set)'); return; }
	const where = repo.startsWith('ssh://') ? 'over there' : 'here';
	const input = () => document.querySelector<HTMLInputElement>('.gg-askpass input');
	const prompt = () => document.querySelector('.gg-askpass .gg-prompt')?.textContent ?? '';
	const answer = (text: string) => { const el = input(); if (!el) return; el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); el.form?.requestSubmit(); };
	const asked = () => settles(() => input() !== null, 30000);
	const name = 'gg-selftest-' + Date.now().toString(36);
	const fetch = (): OpRequest => ({ kind: 'fetch', remote: name, prune: false, pruneTags: false });
	try {
		check((await repoOp(repo, { kind: 'addRemote', name, url, pushUrl: null, fetch: false }).result).kind === 'done', 'a remote at the address is added ' + where);
		// Answered: the name in clear, the password masked; refused by the server.
		const first = repoOp(repo, fetch());
		check(await asked(), 'the question comes up ' + where);
		check(input()?.type === 'text' && /username/i.test(prompt()), 'the name is asked in clear: ' + prompt());
		answer('gg-selftest');
		check(await settles(() => input()?.type === 'password'), 'then the password, masked: ' + prompt());
		answer('secret');
		const refused = await first.result;
		check(refused.kind === 'failed' && /403/.test(refused.message), 'refused by the server, the fetch fails: ' + JSON.stringify(refused));
		check(await settles(() => input() === null), 'no question is left');
		// Cancelled in the dialog.
		const second = repoOp(repo, fetch());
		check(await asked(), 'asked again');
		document.querySelector<HTMLButtonElement>('.gg-askpass button[type=button]')?.click();
		const cancelled = await second.result;
		check(cancelled.kind === 'failed', 'cancelled in the dialog, the fetch fails: ' + JSON.stringify(cancelled));
		// Cancelled as an operation while the question is up: the dialog goes away.
		const third = repoOp(repo, fetch());
		check(await asked(), 'asked a third time');
		await third.cancel();
		check(await settles(() => input() === null), 'the dialog is taken down once git is gone');
		await third.result;
		await log('askpass ' + where + ': answered, cancelled in the dialog, taken down with git');
	} finally {
		await repoOp(repo, { kind: 'deleteRemote', name }).result;
	}
}

/** 10, 11: a Markdown document and an image of the test's own in the working tree: the
 * uncommitted row lists them; the document's file view renders its preview - a table, coloured
 * code, maths, the image beside it, a Mermaid diagram, a PlantUML one (through the stand-in for
 * java, or the jar given), a <script> as text - and the two panes scroll together; the image
 * opens as an image. Both are removed again. */
async function checkPreview(check: Check, config: Record<string, unknown>): Promise<void> {
	const repo = app().state().repo;
	if (repo === null) return;
	const dir = 'gg-selftest';
	const doc = '# Self-test\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst answer = 42;\n```\n\n$E = mc^2$\n\n![a pixel](pic.png)\n\n![from the web](http://127.0.0.1:9/gg-selftest.png)\n\n```mermaid\ngraph TD; A-->B;\n```\n\n```plantuml\nA -> B\n```\n\n<script>alert(1)</script>\n\n'
		+ Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of the self-test document, long enough for both panes to scroll.\n`).join('\n');
	const jar = config['plantumlJava'] === true ? repo + '/' + dir + '/plantuml.jar' : typeof config['plantumlJar'] === 'string' ? config['plantumlJar'] : null;
	const write = (path: string, contents: number[]) => invoke('selftest_write', { repo, path: dir + '/' + path, contents });
	await write('doc.md', Array.from(new TextEncoder().encode(doc)));
	await write('pic.png', bytesOf(PNG_1X1));
	if (config['plantumlJava'] === true) await write('plantuml.jar', [0]); // the stand-in for java needs a jar to be named
	if (jar !== null) await invoke('settings_set', { key: 'plantuml.jar', value: jar });
	try {
		await app().load(300);
		const data = app().state().data;
		const row = data?.commits.findIndex((c) => c.hash === UNCOMMITTED) ?? -1;
		check(row >= 0, 'the uncommitted row shows up with the new files');
		if (row < 0) return;
		app().closeDetails(); // selecting the selected row again would close them instead
		app().selectRow(row);
		await detailsReady();
		const d = app().state().details;
		const files = d?.kind === 'commit' ? d.details.files : [];
		const md = files.find((f) => f.newPath === dir + '/doc.md'), png = files.find((f) => f.newPath === dir + '/pic.png');
		check(md !== undefined && png !== undefined, 'the uncommitted details list both files: ' + JSON.stringify(files.map((f) => f.newPath)));
		if (md === undefined || png === undefined) return;
		const buttonFor = (path: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.gg-details .gg-file')).find((b) => b.title === path);
		const shown = await reportOf(fileSpec(repo, WORKTREE, md.newPath).title,
			() => buttonFor(md.newPath)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
		checkReport(check, shown, ['file']);
		const p = shown.result.preview;
		check(p !== undefined && p.shown && !p.error, 'the preview is shown: ' + JSON.stringify(p));
		if (p !== undefined && p.shown && !p.error) {
			check((p.blocks ?? 0) > 5, 'the blocks carry their source lines: ' + p.blocks);
			check((p.coloured ?? 0) > 0, 'the code is coloured');
			check(p.katex === 1, 'the maths is typeset: ' + p.katex);
			check(p.images === 1, 'the image of the repository is shown: ' + p.images);
			check(p.remoteWaiting === 1 && p.remoteLoaded === 0, 'an image from the web waits: ' + JSON.stringify(p));
			check(p.remoteAsked === 1, 'asked for, it loads: ' + p.remoteAsked);
			// Port 9 refuses: the app's curl tried it (the window may call fetch_image).
			check(/connect/i.test(p.remoteAnswer ?? ''), 'the app fetches it: ' + p.remoteAnswer);
			check(p.mermaid === 1, 'the Mermaid diagram is drawn: ' + p.mermaid);
			if (jar !== null) check(p.plantuml === 1, 'the PlantUML diagram is drawn: ' + p.plantuml + ' ' + JSON.stringify(p.notes));
			else check(p.notes?.length === 1, 'without a jar, the PlantUML block says so: ' + JSON.stringify(p.notes));
			check(p.scripts === 0, 'a <script> stays text');
			check(p.synced !== false, 'the panes scroll together: ' + p.synced);
		}
		await log('preview ' + JSON.stringify(p));
		const image = await reportOf(diffSpec(repo, UNCOMMITTED, UNCOMMITTED, png.oldPath, png.newPath, png.status).title, () => buttonFor(png.newPath)?.click());
		checkReport(check, image, ['image']);
		check(JSON.stringify(image.result.dimensions) === '["1x1"]', 'the image is decoded: ' + JSON.stringify(image.result));
		await log('image ' + JSON.stringify(image.result));
	} finally {
		if (jar !== null) await invoke('settings_set', { key: 'plantuml.jar', value: null });
		app().closeDetails();
		check(await app().operate({ kind: 'cleanUntracked', directories: true }), 'the files are removed again');
		check(await settles(async () => (await getAllWindows()).length === 1), 'the diff windows closed');
	}
}

/** 19: the appearance. The accent colour resolves and the text on it is white; View >
 * Appearance (light, dark) reaches the page and a diff window's Monaco; Increase Contrast has
 * colours of its own. */
async function checkTheme(check: Check): Promise<void> {
	// In front: a bundled app whose window is covered (by the terminal that started the test)
	// has its page frozen by WebKit when the appearance changes, until it is brought forward.
	await getCurrentWindow().setFocus().catch(() => {});
	const root = document.documentElement;
	const token = (name: string) => getComputedStyle(root).getPropertyValue(name).trim();
	const probe = document.createElement('button');
	probe.style.cssText = 'background: var(--gg-button-background); color: var(--gg-button-foreground); position: fixed; left: -100px';
	document.body.appendChild(probe);
	const { backgroundColor, color } = getComputedStyle(probe);
	probe.remove();
	check(/^rgb\(/.test(backgroundColor) && backgroundColor !== 'rgb(0, 0, 0)', 'AccentColor resolves to a colour: ' + backgroundColor);
	check(color === 'rgb(255, 255, 255)', 'the text on the accent is white: ' + color);
	const theme = (window as unknown as { __ggTheme: { force: (o: { dark?: boolean; contrast?: boolean } | null) => void } }).__ggTheme;
	const wasDark = root.classList.contains('gg-dark');
	const foreground = token('--gg-foreground');
	const other = wasDark ? 'light' : 'dark';
	await invoke('set_appearance', { appearance: other });
	check(await settles(() => root.classList.contains('gg-dark') === !wasDark), 'View > Appearance > ' + other + ' reaches the page');
	check(token('--gg-foreground') !== foreground, 'the colours follow');
	await log('theme: ' + other + ' applied');
	// A diff window drawn now has Monaco's theme for it.
	const { repo, data } = app().state();
	const commits = data?.commits.filter((c) => c.hash !== UNCOMMITTED && c.stash === null) ?? [];
	if (repo !== null && commits.length > 2) {
		const spec = compareSpec(repo, (commits[2] as Commit).hash, (commits[0] as Commit).hash);
		const report = await reportOf(spec.title, () => { void invoke('open_diff_window', { spec: JSON.stringify(spec), title: spec.title }); });
		check(report.theme === (wasDark ? 'vs' : 'vs-dark'), 'the diff window\'s Monaco theme follows: ' + report.theme);
		await log('theme: the diff window reported ' + report.theme);
	}
	// Increase Contrast cannot be switched for one app: forced in the page.
	const border = token('--gg-panel-border');
	theme.force({ contrast: true });
	check(root.classList.contains('gg-contrast') && token('--gg-panel-border') !== border, 'Increase Contrast: the class and colours of its own');
	theme.force(null);
	await log('theme: contrast checked, back to system');
	await invoke('set_appearance', { appearance: 'system' });
	await log('theme: system applied');
	check(await settles(() => root.classList.contains('gg-dark') === wasDark), 'back to the system\'s appearance');
	check(await settles(async () => (await getAllWindows()).length === 1), 'the diff window closed: ' + (await getAllWindows()).map((w) => w.label).join(', '));
	await log(`theme: accent ${backgroundColor}, ${other} and contrast checked`);
}

/** 20: the same repository as one on another machine, through the stand-in for ssh
 * (GG_REMOTE_SSH, scripts/selftest.sh): added, shown through the helper, read, refused an
 * archive, asked git's questions there, disconnected (dimmed, requests fail), reconnected by
 * showing it, removed. */
async function checkRemote(check: Check, config: Record<string, unknown>): Promise<void> {
	const local = app().state().repo;
	if (local === null) return;
	const name = 'ssh://selftest@localhost' + local;
	await app().addAndShow([name]);
	const s = app().state();
	check(s.repo === name && s.data !== null && s.data.commits.length > 0, 'the remote repository is shown through the helper: ' + s.error);
	check(document.querySelector('.gg-sidebar .gg-repo.current .gg-hint')?.textContent === 'selftest@localhost', 'the sidebar shows the machine');
	app().selectRow(s.data?.commits.findIndex((c) => c.hash !== '*' && c.stash === null) ?? 0);
	await detailsReady();
	check(app().state().details?.kind === 'commit', 'details come from the helper');
	const archive = await repoOp(name, { kind: 'createArchive', reference: 'HEAD', path: '/tmp/x.zip' }).result;
	check(archive.kind === 'failed' && archive.message.includes('another machine'), 'an archive is refused over there: ' + JSON.stringify(archive));
	const branch = 'gg-selftest-remote-' + Date.now().toString(36);
	check((await repoOp(name, { kind: 'createBranch', branch, commit: 'HEAD', checkout: false, force: false }).result).kind === 'done', 'a branch is created over there');
	check((await repoOp(name, { kind: 'deleteBranch', branch, force: true, deleteOnRemotes: [] }).result).kind === 'done', 'and deleted');
	await checkAskpass(check, config, name);
	// Disconnected: dimmed, and a request fails; shown again: connected again.
	await invoke('remote_disconnect', { repo: name });
	let failed = false;
	await loadRepoInfo(name, { showRemoteBranches: false, showRemoteHeads: false, hideRemotes: [], showStashes: false }).catch(() => { failed = true; });
	check(failed, 'a request after disconnecting fails');
	check(await app().show(name), 'showing it connects again');
	await app().removeRepos([name]);
	check(!app().state().sidebar.repos.includes(name) && app().state().repo === local, 'removed; the local one is shown again');
	await log('remote: ' + name + ' added, read, disconnected, reconnected, removed');
}

export async function selfTest(config: Record<string, unknown>): Promise<void> {
	const failures: string[] = [];
	const check: Check = (ok, what) => { if (!ok) failures.push(what); };
	try {
		await getCurrentWindow().setFocus().catch(() => {});
		await checkGraph(check);
		await checkLoadsInFlight(check);
		await checkDetails(check);
		await checkOps(check);
		if (app().state().repo !== null) await checkAskpass(check, config, app().state().repo as string);
		await checkMenusAndDialogs(check);
		await checkSidebar(check);
		if (config['remote'] === true) await checkRemote(check, config);
		await checkPanelsAndMore(check);
		await checkSettings(check);
		await checkPreview(check, config);
		await checkTheme(check);
		// Last, with everything drawn: the policy holds and refused nothing else.
		let evaluated = false;
		try { evaluated = new Function('return true')() === true; } catch { /* as it should */ }
		check(!evaluated, 'the content security policy refuses eval');
		await pause(100);
		const refused = cspViolations.filter((v) => !v.endsWith(': eval'));
		check(refused.length === 0, 'refused by the content security policy: ' + JSON.stringify(refused));
	} catch (e) {
		failures.push(errorText(e));
	}
	await log(failures.length === 0 ? 'PASS' : 'FAIL ' + failures.join(' | '));
}
