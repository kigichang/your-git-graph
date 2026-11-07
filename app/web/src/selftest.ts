// The built-in end-to-end check (GG_SELFTEST=1, scripts/selftest.sh): drives the app the way a
// person would and reports `selftest: PASS` or `selftest: FAIL …` on stderr (host_log). It grows
// with the milestones (docs/spec/99-acceptance.md); for now it opens the three kinds of diff
// window on a commit of the repository given on the command line and checks what each drew.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getAllWindows } from '@tauri-apps/api/window';
import { engineAnswer, errorText } from './lib/errors';
import { compareSpec, diffSpec, fileSpec, type ChangeType, type DiffSpec } from './lib/diffspec';

const log = (line: string) => invoke('host_log', { line: 'selftest: ' + line }).catch(() => {});

type FileChange = { oldFilePath: string; newFilePath: string; type: ChangeType };
type DiffReport = {
	mode: string; title: string; result: { kind: string; error?: string; files?: number };
	workerProblems: string[]; theme: string | null; escape: { findFirst: boolean | null; closes: boolean };
};

async function engine<T>(repo: string, method: string, params?: unknown): Promise<T> {
	return engineAnswer<T>(await invoke<string>('engine_request', { repo, request: JSON.stringify({ method, params }) }));
}

/** The first repository under what was given: the folder itself, or one found in it. */
async function repositoryOf(folder: string): Promise<string> {
	try {
		await engine(folder, 'loadRepoInfo', { showRemoteBranches: false, showRemoteHeads: false, hideRemotes: [], showChangeRefs: false, showStashes: false });
		return folder;
	} catch (_) {
		const found = await invoke<string[]>('scan_repos', { folder });
		if (found.length === 0) throw new Error('no repository in ' + folder);
		return found[0] as string;
	}
}

/** A commit whose details list a file that is added or modified. */
async function someChange(repo: string): Promise<{ hash: string; change: FileChange }> {
	const { commits } = await engine<{ commits: { hash: string }[] }>(repo, 'loadCommits', { maxCommits: 50, showTags: false, showRemoteBranches: false, showRemoteHeads: false, hideRemotes: [], showUncommittedChanges: false });
	for (const { hash } of commits) {
		const details = await engine<{ fileChanges: FileChange[] }>(repo, 'loadCommitDetails', { hash });
		const change = details.fileChanges.find((c) => c.type === 'M' || c.type === 'A');
		if (change !== undefined) return { hash, change };
	}
	throw new Error('no commit with an added or modified file among the first 50');
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settles(cond: () => Promise<boolean> | boolean, ms = 10000): Promise<boolean> {
	for (const end = performance.now() + ms; performance.now() < end; await pause(100)) if (await cond()) return true;
	return cond();
}

/** Open a diff window and wait for its report (diff/main.js emits one under GG_SELFTEST). */
async function openAndReport(spec: DiffSpec): Promise<DiffReport> {
	const report = new Promise<DiffReport>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no report from the diff window "' + spec.title + '" within 30 s')), 30000);
		void listen<DiffReport>('diff-selftest', (event) => {
			if (event.payload.title !== spec.title) return;
			clearTimeout(timer);
			resolve(event.payload);
		}).then((unlisten) => report.finally(unlisten).catch(() => {}));
	});
	await invoke('open_diff_window', { spec: JSON.stringify(spec), title: spec.title });
	return report;
}

type AppHandle = {
	state: () => { repo: string | null; data: { commits: { hash: string }[]; layout: { nodeLane: number[]; lanes: number }; more: boolean } | null; error: string; firstPaintMs: number | null };
	load: (max: number) => Promise<void>;
	table: () => { stats: () => { rows: number; rendered: number; paints: number }; scrollTo: (top: number) => void } | undefined;
};
const app = (): AppHandle => (window as unknown as { __gg: { app: AppHandle } }).__gg.app;

/** The graph the window drew for the repository it opened: rows, their layout, the canvas. */
async function checkGraph(check: (ok: boolean, what: string) => void): Promise<void> {
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
	// The same page again, warm (the number Stage 1's figure was measured as).
	const again = performance.now();
	await app().load(300);
	await log(`graph: warm reload of 300 in ${(performance.now() - again).toFixed(0)} ms`);
	// A large repository: everything at once, and scrolling through it (the M1 gate).
	if (s.data.more) {
		const started = performance.now();
		await app().load(100000);
		const all = app().state().data;
		const loadMs = performance.now() - started;
		if (all !== null && all.commits.length > 5000 && table) {
			await log(`bench: ${all.commits.length} commits loaded in ${loadMs.toFixed(0)} ms (${JSON.stringify((all as unknown as { timing: unknown }).timing)})`);
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
		}
	}
}

export async function selfTest(_config: Record<string, unknown>): Promise<void> {
	const failures: string[] = [];
	const check = (ok: boolean, what: string) => { if (!ok) failures.push(what); };
	try {
		const folders = await invoke<string[]>('initial_repo');
		if (folders.length === 0) throw new Error('give the repository on the command line');
		const repo = await repositoryOf(folders[0] as string);
		await log('repository ' + repo);
		await checkGraph(check);
		const { hash, change } = await someChange(repo);
		const specs: DiffSpec[] = [
			diffSpec(repo, hash, hash, change.oldFilePath, change.newFilePath, change.type),
			fileSpec(repo, hash, change.newFilePath),
			compareSpec(repo, hash, hash)
		];
		for (const spec of specs) {
			const report = await openAndReport(spec);
			await log(spec.mode + ' ' + JSON.stringify(report.result));
			check(report.result.kind !== 'error' && report.result.kind !== 'missing', spec.mode + ': ' + (report.result.error ?? report.result.kind));
			check(report.workerProblems.length === 0, spec.mode + ': Monaco worker problems ' + JSON.stringify(report.workerProblems));
			check(report.escape.closes, spec.mode + ': Esc does not close the window');
			check(report.escape.findFirst !== false, spec.mode + ': Esc with the find widget open closed more than the widget');
			if (spec.mode === 'compare') check((report.result.files ?? 0) >= 1, 'compare: no files listed');
			if (spec.mode === 'diff') check(report.result.kind === 'text' || report.result.kind === 'image' || report.result.kind === 'binary', 'diff: drew ' + report.result.kind);
			if (spec.mode === 'file') check(report.result.kind === 'file' || report.result.kind === 'image' || report.result.kind === 'binary', 'file: drew ' + report.result.kind);
		}
		// Each window closed itself with Esc: only this one is left.
		const closed = await settles(async () => (await getAllWindows()).length === 1);
		check(closed, 'diff windows still open: ' + (await getAllWindows()).map((w) => w.label).join(', '));
	} catch (e) {
		failures.push(errorText(e));
	}
	await log(failures.length === 0 ? 'PASS' : 'FAIL ' + failures.join(' | '));
}
