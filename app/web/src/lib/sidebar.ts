// The repository sidebar's pure helpers: names, the list and its groups, ahead/behind badges.
// The list is shared by every window (state.json "sidebar"). Tested in sidebar.test.ts.
import { parseRemote } from './remote';

const AVATAR_COLOURS = ['#1a9e8f', '#e0773a', '#7b61ff', '#d64f73', '#3d8bfd', '#b8860b', '#3a9a52', '#a05cd6'];

export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;

/** The letter and colour of a repository's avatar: the first letter or digit of its name, a
 * colour that stays the same for the same name. */
export function avatarOf(path: string): { letter: string; colour: string } {
	const name = baseName(path);
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
	const letter = (name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
	return { letter, colour: AVATAR_COLOURS[hash % AVATAR_COLOURS.length] as string };
}

/** What each repository is called in the list: its folder name, with a hint: the machine of a
 * repository reached over ssh, else where names collide the folder it is in. */
export function labelsOf(repos: string[]): Record<string, { name: string; hint: string | null }> {
	const count = new Map<string, number>();
	for (const repo of repos) count.set(baseName(repo), (count.get(baseName(repo)) || 0) + 1);
	return Object.fromEntries(repos.map((repo) => {
		const name = baseName(repo);
		const remote = parseRemote(repo);
		if (remote !== null) return [repo, { name, hint: remote.authority }];
		return [repo, { name, hint: (count.get(name) ?? 0) > 1 ? baseName(repo.slice(0, repo.length - name.length)) : null }];
	}));
}

/** `list` with `repos` added at the end (those not in it yet). */
export const addRepos = (list: string[], repos: string[]): string[] => list.concat(repos.filter((repo, i) => !list.includes(repo) && repos.indexOf(repo) === i));

/** `list` with `repo` moved to just before `before` (null: to the end). */
export function moveRepo(list: string[], repo: string, before: string | null): string[] {
	if (!list.includes(repo) || repo === before) return list;
	const rest = list.filter((r) => r !== repo);
	const at = before === null ? -1 : rest.indexOf(before);
	return at === -1 ? rest.concat(repo) : [...rest.slice(0, at), repo, ...rest.slice(at)];
}

/** `list` without `repos`, and what to show next when `current` was one of those removed: the
 * one that took its place (the first left after it), else the last one before; null when nothing
 * is left. */
export function removeRepos(list: string[], repos: string[], current: string | null): { list: string[]; show: string | null } {
	const next = list.filter((r) => !repos.includes(r));
	if (current === null || !repos.includes(current)) return { list: next, show: current };
	const after = list.slice(list.indexOf(current) + 1).find((r) => !repos.includes(r));
	return { list: next, show: after ?? next.at(-1) ?? null };
}

/* Groups: the sidebar's repositories in named groups, those in none under "default". Kept as
 * the names in order (`groups`) and each repository's group (`groupOf`, absent: default); the
 * order within a group is the order of the list. */

/** The name the group of ungrouped repositories shows (not a name a group can take). */
export const DEFAULT_GROUP = 'default';

export type GroupOf = Record<string, string>;

/** The sections of the sidebar: { group: null (default) | name, repos }, default first. */
export function groupsOf(repos: string[], groups: string[], groupOf: GroupOf): { group: string | null; repos: string[] }[] {
	const of = (repo: string) => { const g = groupOf[repo]; return g !== undefined && groups.includes(g) ? g : null; };
	return [null, ...groups].map((group) => ({ group, repos: repos.filter((repo) => of(repo) === group) }));
}

/** The group `repo` is in (null: default; also when `repo` is null). */
export function groupOfRepo(groups: string[], groupOf: GroupOf, repo: string | null): string | null {
	const g = repo === null ? undefined : groupOf[repo];
	return g !== undefined && groups.includes(g) ? g : null;
}

/** `list` with `repos` added at the end (those not in it yet), the new ones in `group` (null:
 * default); those already in the list stay where they are. */
export function addReposTo(list: string[], groupOf: GroupOf, repos: string[], group: string | null): { list: string[]; groupOf: GroupOf } {
	const added = addRepos(list, repos).slice(list.length);
	const next = { ...groupOf };
	for (const repo of added) if (group === null) delete next[repo]; else next[repo] = group;
	return { list: list.concat(added), groupOf: next };
}

/** `repo` dropped into `group` (null: default) just before `before` (null: at its end). */
export function moveToGroup(list: string[], groupOf: GroupOf, repo: string, group: string | null, before: string | null): { list: string[]; groupOf: GroupOf } {
	const next = { ...groupOf };
	if (group === null) delete next[repo]; else next[repo] = group;
	return { list: moveRepo(list, repo, before), groupOf: next };
}

/** `repos` (in the order they are to keep) dropped into `group` just before `before` (not one
 * of them; null: at the group's end). */
export function moveManyToGroup(list: string[], groupOf: GroupOf, repos: string[], group: string | null, before: string | null): { list: string[]; groupOf: GroupOf } {
	return repos.reduce((moved, repo) => moveToGroup(moved.list, moved.groupOf, repo, group, before), { list, groupOf });
}

/** What is wrong with `name` for a group (`current`: the one being renamed), or null. */
export function invalidGroupName(name: string, groups: string[], current: string | null): string | null {
	if (name === '') return 'Enter a name for the group.';
	if (name.toLowerCase() === DEFAULT_GROUP) return '"' + DEFAULT_GROUP + '" is the group of the repositories in no group.';
	return name !== current && groups.includes(name) ? 'There is a group with this name already.' : null;
}

export function renameGroup(groups: string[], groupOf: GroupOf, from: string, to: string): { groups: string[]; groupOf: GroupOf } {
	return {
		groups: groups.map((g) => (g === from ? to : g)),
		groupOf: Object.fromEntries(Object.entries(groupOf).map(([repo, g]) => [repo, g === from ? to : g]))
	};
}

/** Without the group `name`: its repositories are in no group again. */
export function removeGroup(groups: string[], groupOf: GroupOf, name: string): { groups: string[]; groupOf: GroupOf } {
	return { groups: groups.filter((g) => g !== name), groupOf: Object.fromEntries(Object.entries(groupOf).filter(([, g]) => g !== name)) };
}

/** The badge after a repository's name: ↑ahead ↓behind, nothing when in step. */
export function badgeOf(status: { ahead?: number | null; behind?: number | null } | null | undefined): string {
	if (!status) return '';
	return [(status.ahead ?? 0) > 0 ? '↑' + status.ahead : '', (status.behind ?? 0) > 0 ? '↓' + status.behind : ''].filter((s) => s !== '').join(' ');
}

/** The sidebar as state.json keeps it. */
export type SidebarState = { repos: string[]; collapsed: boolean; groups: string[]; groupOf: GroupOf; foldedGroups: string[] };

export const EMPTY_SIDEBAR: SidebarState = { repos: [], collapsed: false, groups: [], groupOf: {}, foldedGroups: [] };

/** A saved sidebar value made whole (older versions lack the group fields). */
export function sidebarFrom(value: unknown): SidebarState {
	const v = (value ?? {}) as Partial<SidebarState>;
	const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
	return {
		repos: strings(v.repos), collapsed: v.collapsed === true, groups: strings(v.groups),
		groupOf: typeof v.groupOf === 'object' && v.groupOf !== null ? Object.fromEntries(Object.entries(v.groupOf).filter(([, g]) => typeof g === 'string')) as GroupOf : {},
		foldedGroups: strings(v.foldedGroups)
	};
}
