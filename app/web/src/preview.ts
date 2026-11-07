// GG_PREVIEW=<scene>[,<scene>…][,contrast] (scripts/preview.sh): bring the window to a given
// state and report `preview: <scenes>` on stderr, for a screenshot. Scenes, in order:
//   graph     the graph as loaded (always the case)
//   details   the details of the third row (a merge commit, on git/git)
//   compare   the first row compared with the fourth
//   branches  the branch dropdown open
import { log } from './lib/api/client';

type AppHandle = {
	state: () => { data: { commits: unknown[] } | null; error: string; details: { kind: string } | null };
	selectRow: (row: number) => void;
	compareRows: (a: number, b: number) => void;
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
		}
	}
	await pause(400); // the last paint
	await log('preview: ' + scenes + (app().state().error ? ' (error: ' + app().state().error + ')' : ''));
}
