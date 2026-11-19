// A repository's shared settings as a file in it (.your-git-graph.json): what is exported
// from the repository's state, and what is taken back from the file. Pure; tested in
// repoconfig.test.ts. The file is for committing: everyone who clones gets the same view.
export const REPO_CONFIG_FILE = '.your-git-graph.json';

/** What the app keeps per repository (state.json "repo:<repo>"). */
export type RepoState = {
	hiddenRemotes: string[];
	showRemoteBranches: boolean;
	firstParentOnly: boolean;
	order: 'date' | 'author-date' | 'topo' | null;
	branches: string[] | null;
	authors: string[] | null;
	/** When the repository's file was last taken in (its `exportedAt`). */
	lastImportAt: number;
};

export const DEFAULT_REPO_STATE: RepoState = { hiddenRemotes: [], showRemoteBranches: true, firstParentOnly: false, order: null, branches: null, authors: null, lastImportAt: 0 };

export function repoStateFrom(value: unknown): RepoState {
	const v = (value ?? {}) as Partial<Record<keyof RepoState, unknown>>;
	const strings = (x: unknown): string[] | null => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : null);
	return {
		hiddenRemotes: strings(v.hiddenRemotes) ?? [],
		showRemoteBranches: v.showRemoteBranches !== false,
		firstParentOnly: v.firstParentOnly === true,
		order: v.order === 'date' || v.order === 'author-date' || v.order === 'topo' ? v.order : null,
		branches: strings(v.branches),
		authors: strings(v.authors),
		lastImportAt: typeof v.lastImportAt === 'number' ? v.lastImportAt : 0
	};
}

/** The text of the file to write: the settings worth sharing, and when. */
export function exportRepoConfig(state: RepoState, now: number): string {
	const out = { version: 1, hiddenRemotes: state.hiddenRemotes, showRemoteBranches: state.showRemoteBranches, firstParentOnly: state.firstParentOnly, order: state.order, exportedAt: now };
	return JSON.stringify(out, null, 2) + '\n';
}

/** A file's `exportedAt` may be this far ahead of this Mac's clock (another machine's clock). */
const CLOCK_SLACK = 24 * 60 * 60;
/** The remotes a file may hide, and how long a remote's name may be. */
const MAX_HIDDEN = 100, MAX_NAME = 200;

/** The state after taking the file in, when it is newer than the last import; `null` when
 * there is nothing to take (not the file's format, not newer, dated later than `now` - seconds
 * - which would keep every later file from being taken). Unknown or invalid fields are left
 * alone. The file comes with the repository: what it says is its author's, and is bounded. */
export function importRepoConfig(state: RepoState, text: string, now: number): RepoState | null {
	let file: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
		file = parsed as Record<string, unknown>;
	} catch {
		return null;
	}
	const at = file['exportedAt'];
	if (file['version'] !== 1 || typeof at !== 'number' || !Number.isFinite(at) || at <= state.lastImportAt || at > now + CLOCK_SLACK) return null;
	const next = { ...state, lastImportAt: at };
	if (Array.isArray(file['hiddenRemotes'])) {
		next.hiddenRemotes = file['hiddenRemotes'].filter((s): s is string => typeof s === 'string' && s !== '' && s.length <= MAX_NAME).slice(0, MAX_HIDDEN);
	}
	if (typeof file['showRemoteBranches'] === 'boolean') next.showRemoteBranches = file['showRemoteBranches'];
	if (typeof file['firstParentOnly'] === 'boolean') next.firstParentOnly = file['firstParentOnly'];
	if (file['order'] === 'date' || file['order'] === 'author-date' || file['order'] === 'topo' || file['order'] === null) next.order = file['order'] as RepoState['order'];
	return next;
}
