// GG_PREVIEW=<scene>[,<scene>…][,contrast] (scripts/preview.sh): bring the window to a given
// state and report `preview: <scenes>` on stderr, for a screenshot. Scenes, in order:
//   graph      the graph as loaded (always the case)
//   details    the details of the third row (a merge commit, on git/git)
//   inline     the same, shown inline below the row
//   compare    the first row compared with the fourth
//   branches   the branch dropdown open
//   authors    the author dropdown open
//   menu       the context menu of the third row
//   dialog     the Create Branch dialog for the third row
//   error      the error dialog (a branch that exists, created again)
//   settings   the settings drawer
//   find       the find widget with "fix" typed
//   reflog     the reflog panel
//   worktrees  the worktree panel
//   addmenu    the sidebar's ＋ menu
//   addremote  the Add SSH Repository dialog
//   addserver  the Connect to Server dialog
//   diff       the diff window of the first file of the third row (a second window)
//   markdown   the file window of the repository's README.md with its preview (a second window)
//   resize     the window at 900 × 620, as a person would drag it
//   zh         the interface in Traditional Chinese
import { invoke } from '@tauri-apps/api/core';
import { log, openDiffWindow } from './lib/api/client';
import { fileSpec, WORKTREE } from './lib/diffspec';
import { t } from './lib/i18n';
import type { MenuTarget } from './lib/menus';

type AppHandle = {
	state: () => { repo: string | null; data: { commits: { hash: string; parents: string[]; heads: string[] }[] } | null; error: string; details: { kind: string } | null; ops: { error: unknown } };
	selectRow: (row: number) => void;
	compareRows: (a: number, b: number) => void;
	action: (action: string, target: MenuTarget) => Promise<void>;
	operate: (request: unknown) => Promise<boolean>;
	openSettings: () => Promise<void>;
	openFind: () => void;
	onFindChange: (next: { query: string; caseSensitive: boolean; regex: boolean }) => void;
	showPanel: (p: 'reflog' | 'worktrees' | null) => void;
	addRemote: () => void;
	connectServer: () => void;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const app = () => (window as unknown as { __gg: { app: AppHandle } }).__gg.app;
async function until(cond: () => boolean, ms = 30000) {
	for (const end = performance.now() + ms; performance.now() < end && !cond(); ) await pause(100);
}
const click = (selector: string) => (document.querySelector(selector) as HTMLElement | null)?.click();

export async function runPreview(scenes: string): Promise<void> {
	await until(() => app().state().data !== null || app().state().error !== '');
	const rows = app().state().data?.commits.length ?? 0;
	const third = () => app().state().data?.commits[2];
	for (const scene of scenes.split(',')) {
		if ((scene === 'details' || scene === 'inline') && rows > 2) {
			if (scene === 'inline') await invoke('settings_set', { key: 'details.location', value: 'inline' });
			await pause(200); // the setting reaches the window
			app().selectRow(2);
			await until(() => app().state().details?.kind !== 'loading');
		} else if (scene === 'compare' && rows > 3) {
			app().compareRows(0, 3);
			await until(() => app().state().details?.kind !== 'loading');
		} else if (scene === 'branches') {
			click('.gg-branch-filter .gg-current');
		} else if (scene === 'authors') {
			click('.gg-multi-filter:not(.gg-branch-filter) .gg-current');
		} else if (scene === 'menu' && rows > 2) {
			const row = document.querySelector('.gg-row[aria-rowindex="3"]');
			row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 160 }));
			await until(() => document.querySelector('.gg-menu') !== null);
		} else if (scene === 'dialog' && rows > 2) {
			const commit = third();
			if (commit) await app().action('createBranch', { kind: 'commit', commit: commit as never, isHead: false });
			await until(() => document.querySelector('.gg-box') !== null);
		} else if (scene === 'error' && rows > 2) {
			const commit = third();
			const existing = app().state().data?.commits.flatMap((c) => c.heads)[0];
			if (commit && existing !== undefined) void app().operate({ kind: 'createBranch', branch: existing, commit: commit.hash, checkout: false, force: false });
			await until(() => app().state().ops.error !== null);
		} else if (scene === 'settings') {
			await app().openSettings();
			await until(() => document.querySelector('.gg-settings') !== null);
		} else if (scene === 'find') {
			app().openFind();
			await until(() => document.querySelector('.gg-find') !== null);
			app().onFindChange({ query: 'fix', caseSensitive: false, regex: false });
		} else if (scene === 'reflog' || scene === 'worktrees') {
			app().showPanel(scene);
			await until(() => document.querySelector('.gg-panel .gg-row') !== null);
		} else if (scene === 'addmenu') {
			click(`.gg-sidebar button[title="${t('sidebar.add')}"]`);
			await until(() => document.querySelector('.gg-menu') !== null);
		} else if (scene === 'addremote') {
			app().addRemote();
			await until(() => document.querySelector('.gg-box') !== null);
		} else if (scene === 'addserver') {
			app().connectServer();
			await until(() => document.querySelector('.gg-box') !== null);
		} else if (scene === 'diff' && rows > 2) {
			app().selectRow(2);
			await until(() => app().state().details?.kind !== 'loading');
			await until(() => document.querySelector('.gg-details .gg-file') !== null, 5000);
			click('.gg-details .gg-file');
			await pause(2500); // the window, Monaco, the first paint
		} else if (scene === 'markdown') {
			const repo = app().state().repo;
			const exists = repo === null ? false : await invoke<{ exists: boolean }>('worktree_file', { repo, path: 'README.md' }).then((f) => f.exists, () => false);
			if (repo !== null && exists) {
				await openDiffWindow(fileSpec(repo, WORKTREE, 'README.md'));
				await pause(4000); // the window, Monaco, the preview's bundles
			} else await log('preview: no README.md in the working tree');
		} else if (scene === 'resize') {
			await invoke('preview_resize', { width: 900, height: 620 });
		} else if (scene === 'zh') {
			await invoke('settings_set', { key: 'language', value: 'zh-TW' });
			await until(() => document.querySelector('.gg-sidebar .gg-title')?.textContent === '儲存庫' || document.querySelector('.gg-toolbar .gg-button')?.textContent === '擷取');
		}
	}
	await pause(400); // the last paint
	await log('preview: ' + scenes + (app().state().error ? ' (error: ' + app().state().error + ')' : ''));
}
