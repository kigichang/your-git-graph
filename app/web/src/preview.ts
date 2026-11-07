// GG_PREVIEW=<scene>[,<scene>…][,contrast] (scripts/preview.sh): bring the window to a given
// state and report `preview: <scenes>` on stderr, for a screenshot. The scenes arrive with the
// milestones; so far there is only the graph itself.
import { log } from './lib/api/client';

type AppHandle = { state: () => { data: unknown; error: string } };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runPreview(scenes: string): Promise<void> {
	const app = () => (window as unknown as { __gg: { app: AppHandle } }).__gg.app;
	for (let i = 0; i < 300 && app().state().data === null && app().state().error === ''; i++) await pause(100);
	await pause(300); // the first paint
	await log('preview: ' + scenes + (app().state().error ? ' (error: ' + app().state().error + ')' : ''));
}
