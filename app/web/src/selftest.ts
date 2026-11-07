// The built-in end-to-end check (GG_SELFTEST=1, scripts/selftest.sh): drives the app the way a
// person would and reports `selftest: PASS` or `selftest: FAIL …` on stderr (host_log). What it
// covers is listed in docs/spec/99-acceptance.md; it grows with the milestones.
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { errorText } from './lib/errors';
import { compareSpec, diffSpec, fileSpec, revisions, type DiffSpec } from './lib/diffspec';
import { loadRepoInfo, repoOp, type Commit, type CommitsResponse, type Details, type FileChange, type OpRequest, type RepoInfo } from './lib/api/client';
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
	addAndShow: (paths: string[]) => Promise<void>;
	removeRepos: (repos: string[]) => Promise<void>;
	saveSidebar: (next: SidebarState) => void;
	load: (max: number) => Promise<void>;
	table: () => { stats: () => { rows: number; rendered: number; paints: number; selected: number }; scrollTo: (top: number) => void } | undefined;
	setBranches: (b: string[] | null) => Promise<void>;
	selectRow: (row: number) => void;
	compareRows: (a: number, b: number) => void;
	showTag: (name: string) => void;
	closeDetails: () => void;
};
const app = (): AppHandle => (window as unknown as { __gg: { app: AppHandle } }).__gg.app;

type DiffReport = {
	mode: string; title: string; result: { kind: string; error?: string; files?: number };
	workerProblems: string[]; theme: string | null; escape: { findFirst: boolean | null; closes: boolean };
};

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
	check(report.escape.closes, what + ': Esc does not close the window');
	check(report.escape.findFirst !== false, what + ': Esc with the find widget open closed more than the widget');
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
	const closed = await settles(async () => (await getAllWindows()).length === 1);
	check(closed, 'diff windows still open: ' + (await getAllWindows()).map((w) => w.label).join(', '));
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

/** 20: the same repository as one on another machine, through the stand-in for ssh
 * (GG_REMOTE_SSH, scripts/selftest.sh): added, shown through the helper, read, refused an
 * archive, disconnected (dimmed, requests fail), reconnected by showing it, removed. */
async function checkRemote(check: Check): Promise<void> {
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
		await checkGraph(check);
		await checkDetails(check);
		await checkOps(check);
		await checkMenusAndDialogs(check);
		await checkSidebar(check);
		if (config['remote'] === true) await checkRemote(check);
		await checkSettings(check);
	} catch (e) {
		failures.push(errorText(e));
	}
	await log(failures.length === 0 ? 'PASS' : 'FAIL ' + failures.join(' | '));
}
