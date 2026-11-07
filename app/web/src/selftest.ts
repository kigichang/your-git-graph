// The built-in end-to-end check (GG_SELFTEST=1, scripts/selftest.sh): drives the app the way a
// person would and reports `selftest: PASS` or `selftest: FAIL …` on stderr (host_log). What it
// covers is listed in docs/spec/99-acceptance.md; it grows with the milestones.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getAllWindows } from '@tauri-apps/api/window';
import { errorText } from './lib/errors';
import { compareSpec, diffSpec, fileSpec, revisions, type DiffSpec } from './lib/diffspec';
import type { Commit, CommitsResponse, Details, FileChange, RepoInfo } from './lib/api/client';

const log = (line: string) => invoke('host_log', { line: 'selftest: ' + line }).catch(() => {});

type DetailsView =
	| { kind: 'loading' } | { kind: 'error'; message: string }
	| { kind: 'commit'; details: Details; stash: string | null }
	| { kind: 'compare'; from: string; to: string; files: FileChange[] }
	| { kind: 'tag'; name: string; details: { annotated: boolean; message: string } };
type AppHandle = {
	state: () => { repo: string | null; data: CommitsResponse | null; info: RepoInfo | null; error: string; firstPaintMs: number | null; details: DetailsView | null; branches: string[] | null };
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

export async function selfTest(_config: Record<string, unknown>): Promise<void> {
	const failures: string[] = [];
	const check: Check = (ok, what) => { if (!ok) failures.push(what); };
	try {
		await checkGraph(check);
		await checkDetails(check);
	} catch (e) {
		failures.push(errorText(e));
	}
	await log(failures.length === 0 ? 'PASS' : 'FAIL ' + failures.join(' | '));
}
