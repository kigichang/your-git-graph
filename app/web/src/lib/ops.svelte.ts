// Running an operation from the window: the state the dialogs show (what is running, its
// output, the question it asks, the error it ended in) and `runOperation`, which drives it.
import { repoOp, log, type OpRequest, type OpProgress, type Reason } from './api/client';
import { isStreamed, labelOf } from './dialogs';
import { errorText } from './errors';

type Running = { label: string; cancel: () => Promise<boolean>; streamed: boolean };
type Question = { reasons: Reason[]; answer: (go: boolean) => void };

export const ops = $state({
	running: null as Running | null,
	/** git's output while an operation runs, and after one that streamed until closed. */
	output: [] as { stderr: boolean; text: string }[],
	/** The progress window stays until closed: what it shows ended with. */
	finished: null as { label: string; error: string | null } | null,
	question: null as Question | null,
	error: null as { message: string; step: string | null } | null,
	/** When the last operation ended (the file watcher's echo of it is ignored for a moment). */
	lastEndedAt: 0
});

export const closeProgress = () => { ops.finished = null; ops.output = []; };
export const closeError = () => { ops.error = null; };

/** Do `request` to `repo`. Asks (and asks again confirmed) when the operation says so; shows
 * the error when it fails. Resolves to whether it was done. */
export async function runOperation(repo: string, request: OpRequest): Promise<boolean> {
	if (ops.running !== null) return false;
	const streamed = isStreamed(request);
	const label = labelOf(request);
	ops.output = [];
	ops.finished = null;
	let confirmed = false;
	try {
		for (;;) {
			const op = repoOp(repo, request, {
				confirmed,
				onProgress: (p: OpProgress) => {
					if (p.kind === 'output') ops.output = [...ops.output, { stderr: p.stderr, text: p.text }];
					else ops.output = [...ops.output, { stderr: false, text: `[${p.index + 1}/${p.total}] ${p.label}\n` }];
				}
			});
			ops.running = { label, cancel: op.cancel, streamed };
			const result = await op.result;
			ops.running = null;
			if (result.kind === 'needsConfirmation') {
				const go = await new Promise<boolean>((answer) => { ops.question = { reasons: result.reasons, answer }; });
				ops.question = null;
				if (!go) return false;
				confirmed = true;
				continue;
			}
			if (result.kind === 'failed') {
				void log(`op ${request.kind} failed: ${result.message}`);
				if (streamed && ops.output.length > 0) ops.finished = { label, error: result.message };
				else ops.error = { message: result.message, step: result.step };
				return false;
			}
			if (streamed) ops.finished = { label, error: null };
			return true;
		}
	} catch (e) {
		ops.running = null;
		ops.error = { message: errorText(e), step: null };
		return false;
	} finally {
		ops.lastEndedAt = performance.now();
	}
}
