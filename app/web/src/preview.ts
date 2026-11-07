// GG_PREVIEW=<scene>[,<scene>…][,contrast] (scripts/preview.sh): bring the window to a given
// state and report `preview: <scenes>` on stderr, for a screenshot. Scenes, in order:
//   graph     the graph as loaded (always the case)
//   details   the details of the third row (a merge commit, on git/git)
//   compare   the first row compared with the fourth
//   branches  the branch dropdown open
//   menu      the context menu of the third row
//   dialog    the Create Branch dialog for the third row
import { log } from './lib/api/client';
import type { MenuTarget } from './lib/menus';

type AppHandle = {
	state: () => { data: { commits: { hash: string; parents: string[] }[] } | null; error: string; details: { kind: string } | null };
	selectRow: (row: number) => void;
	compareRows: (a: number, b: number) => void;
	action: (action: string, target: MenuTarget) => Promise<void>;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const app = () => (window as unknown as { __gg: { app: AppHandle } }).__gg.app;
async function until(cond: () => boolean, ms = 30000) {
	for (const end = performance.now() + ms; performance.now() < end && !cond(); ) await pause(100);
}

export async function runPreview(scenes: string): Promise<void> {
	await until(() => app().state().data !== null || app().state().error !== '');
	const rows = app().state().data?.commits.length ?? 0;
	for (const scene of scenes.split(',')) {
		if (scene === 'details' && rows > 2) {
			app().selectRow(2);
			await until(() => app().state().details?.kind !== 'loading');
		} else if (scene === 'compare' && rows > 3) {
			app().compareRows(0, 3);
			await until(() => app().state().details?.kind !== 'loading');
		} else if (scene === 'branches') {
			(document.querySelector('.gg-branch-filter button') as HTMLButtonElement | null)?.click();
		} else if (scene === 'menu' && rows > 2) {
			const row = document.querySelector('.gg-row[aria-rowindex="3"]');
			row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 160 }));
			await until(() => document.querySelector('.gg-menu') !== null);
		} else if (scene === 'dialog' && rows > 2) {
			const commit = app().state().data?.commits[2];
			if (commit) await app().action('createBranch', { kind: 'commit', commit: commit as never, isHead: false });
			await until(() => document.querySelector('.gg-box') !== null);
		}
	}
	await pause(400); // the last paint
	await log('preview: ' + scenes + (app().state().error ? ' (error: ' + app().state().error + ')' : ''));
}
