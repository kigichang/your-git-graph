// Finding commits among the loaded ones: which rows match the text (subject, author, hash,
// the labels), as text or as a regular expression. Pure; tested in find.test.ts.
import type { Commit } from './api/client';

export type FindOptions = { caseSensitive: boolean; regex: boolean };

/** The matcher for `query`, or null when it is empty or not a valid regular expression. */
export function matcherFor(query: string, options: FindOptions): ((text: string) => boolean) | null {
	if (query === '') return null;
	if (options.regex) {
		try {
			const re = new RegExp(query, options.caseSensitive ? '' : 'i');
			return (text) => re.test(text);
		} catch {
			return null;
		}
	}
	const needle = options.caseSensitive ? query : query.toLowerCase();
	return (text) => (options.caseSensitive ? text : text.toLowerCase()).includes(needle);
}

/** What of a commit the search looks at. */
export function searchableText(commit: Commit): string {
	return [commit.message, commit.author, commit.email, commit.hash, ...commit.heads, ...commit.remotes.map((r) => r.name), ...commit.tags.map((t) => t.name), commit.stash?.selector ?? ''].join('\n');
}

/** The rows of `commits` that match. */
export function findRows(commits: Commit[], query: string, options: FindOptions): number[] {
	const matches = matcherFor(query, options);
	if (matches === null) return [];
	const out: number[] = [];
	for (let i = 0; i < commits.length; i++) if (matches(searchableText(commits[i] as Commit))) out.push(i);
	return out;
}

/** The index in `rows` of the match to go to from `current`: the next (or previous) one after
 * the selected row `from`, wrapping around; -1 without matches. */
export function stepMatch(rows: number[], from: number, forward: boolean): number {
	if (rows.length === 0) return -1;
	if (forward) {
		const i = rows.findIndex((r) => r > from);
		return i === -1 ? 0 : i;
	}
	for (let i = rows.length - 1; i >= 0; i--) if ((rows[i] as number) < from) return i;
	return rows.length - 1;
}
