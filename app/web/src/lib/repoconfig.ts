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

/** The state after taking the file in, when it is newer than the last import; `null` when
 * there is nothing to take (not the file's format, not newer). Unknown or invalid fields are
 * left alone. */
export function importRepoConfig(state: RepoState, text: string): RepoState | null {
	let file: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
		file = parsed as Record<string, unknown>;
	} catch {
		return null;
	}
	if (file['version'] !== 1 || typeof file['exportedAt'] !== 'number' || file['exportedAt'] <= state.lastImportAt) return null;
	const next = { ...state, lastImportAt: file['exportedAt'] };
	if (Array.isArray(file['hiddenRemotes'])) next.hiddenRemotes = file['hiddenRemotes'].filter((s): s is string => typeof s === 'string');
	if (typeof file['showRemoteBranches'] === 'boolean') next.showRemoteBranches = file['showRemoteBranches'];
	if (typeof file['firstParentOnly'] === 'boolean') next.firstParentOnly = file['firstParentOnly'];
	if (file['order'] === 'date' || file['order'] === 'author-date' || file['order'] === 'topo' || file['order'] === null) next.order = file['order'] as RepoState['order'];
	return next;
}
