import { test, expect } from 'vitest';
import { avatarOf, labelsOf, addRepos, addReposTo, groupOfRepo, removeRepos, moveRepo, badgeOf, baseName, groupsOf, moveToGroup, moveManyToGroup, invalidGroupName, renameGroup, removeGroup, sidebarFrom } from './sidebar';

test('avatars: the first letter or digit, a colour that stays with the name', () => {
	expect(avatarOf('/r/git-graph').letter).toBe('G');
	expect(avatarOf('/r/.dotfiles').letter).toBe('D');
	expect(avatarOf('/r/2048').letter).toBe('2');
	expect(avatarOf('/r/中文專案').letter).toBe('中');
	expect(avatarOf('/a/same').colour).toBe(avatarOf('/b/same').colour);
	expect(avatarOf('/r/x').colour).toMatch(/^#[0-9a-f]{6}$/);
	expect(baseName('/r/repo/')).toBe('repo');
});

test('labels: the folder name, with where it is only when names collide; the machine for ssh', () => {
	expect(labelsOf(['/a/app', '/b/app', '/c/tool', 'ssh://me@nas/srv/app'])).toEqual({
		'/a/app': { name: 'app', hint: 'a' },
		'/b/app': { name: 'app', hint: 'b' },
		'/c/tool': { name: 'tool', hint: null },
		'ssh://me@nas/srv/app': { name: 'app', hint: 'me@nas' }
	});
});

test('adding keeps the order and never doubles', () => {
	expect(addRepos(['/a', '/b'], ['/b', '/c', '/c', '/d'])).toEqual(['/a', '/b', '/c', '/d']);
	expect(addRepos([], [])).toEqual([]);
});

test('added repositories join the group of the one shown, default when it is in none', () => {
	const groups = ['work'];
	const groupOf = { '/a': 'work', '/b': 'gone' };
	expect(groupOfRepo(groups, groupOf, '/a')).toBe('work');
	expect(groupOfRepo(groups, groupOf, '/b')).toBe(null);
	expect(groupOfRepo(groups, groupOf, '/c')).toBe(null);
	expect(groupOfRepo(groups, groupOf, null)).toBe(null);
	expect(addReposTo(['/a', '/c'], { '/a': 'work' }, ['/c', '/d', '/d'], 'work')).toEqual({ list: ['/a', '/c', '/d'], groupOf: { '/a': 'work', '/d': 'work' } });
	expect(addReposTo(['/a'], { '/a': 'work' }, ['/a', '/d'], null)).toEqual({ list: ['/a', '/d'], groupOf: { '/a': 'work' } });
});

test('removing the shown repository shows the one that took its place, else the one before', () => {
	expect(removeRepos(['/a', '/b', '/c'], ['/b'], '/b')).toEqual({ list: ['/a', '/c'], show: '/c' });
	expect(removeRepos(['/a', '/b', '/c'], ['/c'], '/c')).toEqual({ list: ['/a', '/b'], show: '/b' });
	expect(removeRepos(['/a'], ['/a'], '/a')).toEqual({ list: [], show: null });
	expect(removeRepos(['/a', '/b'], ['/a'], '/b')).toEqual({ list: ['/b'], show: '/b' });
	expect(removeRepos(['/a', '/b', '/c', '/d'], ['/b', '/c'], '/b')).toEqual({ list: ['/a', '/d'], show: '/d' });
	expect(removeRepos(['/a', '/b', '/c'], ['/c', '/a'], '/b')).toEqual({ list: ['/b'], show: '/b' });
	expect(removeRepos(['/a'], ['/a'], null)).toEqual({ list: [], show: null });
});

test('moving puts the repository just before another, or at the end', () => {
	expect(moveRepo(['/a', '/b', '/c'], '/c', '/a')).toEqual(['/c', '/a', '/b']);
	expect(moveRepo(['/a', '/b', '/c'], '/a', '/c')).toEqual(['/b', '/a', '/c']);
	expect(moveRepo(['/a', '/b', '/c'], '/a', null)).toEqual(['/b', '/c', '/a']);
	expect(moveRepo(['/a', '/b', '/c'], '/a', '/b')).toEqual(['/a', '/b', '/c']);
	expect(moveRepo(['/a', '/b'], '/x', '/a')).toEqual(['/a', '/b']);
	expect(moveRepo(['/a', '/b'], '/b', '/x')).toEqual(['/a', '/b']);
});

test('the badge', () => {
	expect(badgeOf({ ahead: 1, behind: 0 })).toBe('↑1');
	expect(badgeOf({ ahead: 0, behind: 4 })).toBe('↓4');
	expect(badgeOf({ ahead: 2, behind: 4 })).toBe('↑2 ↓4');
	expect(badgeOf({ ahead: 0, behind: 0 })).toBe('');
	expect(badgeOf(null)).toBe('');
	expect(badgeOf({ ahead: null, behind: null })).toBe('');
});

test('groups: sections, moving into and between them, renaming and removing', () => {
	const list = ['/a', '/b', '/c', '/d'];
	expect(groupsOf(list, ['work'], { '/b': 'work', '/d': 'gone' })).toEqual([{ group: null, repos: ['/a', '/c', '/d'] }, { group: 'work', repos: ['/b'] }]);
	const moved = moveToGroup(list, { '/b': 'work' }, '/a', 'work', '/b');
	expect(moved).toEqual({ list: ['/a', '/b', '/c', '/d'], groupOf: { '/a': 'work', '/b': 'work' } });
	expect(moveToGroup(list, { '/b': 'work' }, '/b', null, null)).toEqual({ list: ['/a', '/c', '/d', '/b'], groupOf: {} });
	const many = moveManyToGroup(list, {}, ['/a', '/c'], 'work', null);
	expect(many).toEqual({ list: ['/b', '/d', '/a', '/c'], groupOf: { '/a': 'work', '/c': 'work' } });
	expect(invalidGroupName('', [], null)).not.toBe(null);
	expect(invalidGroupName('Default', [], null)).not.toBe(null);
	expect(invalidGroupName('work', ['work'], null)).not.toBe(null);
	expect(invalidGroupName('work', ['work'], 'work')).toBe(null);
	expect(invalidGroupName('home', ['work'], null)).toBe(null);
	expect(renameGroup(['work', 'x'], { '/a': 'work', '/b': 'x' }, 'work', 'job')).toEqual({ groups: ['job', 'x'], groupOf: { '/a': 'job', '/b': 'x' } });
	expect(removeGroup(['work', 'x'], { '/a': 'work', '/b': 'x' }, 'work')).toEqual({ groups: ['x'], groupOf: { '/b': 'x' } });
});

test('a saved sidebar is made whole', () => {
	expect(sidebarFrom(undefined)).toEqual({ repos: [], collapsed: false, groups: [], groupOf: {}, foldedGroups: [] });
	expect(sidebarFrom({ repos: ['/a', 1], collapsed: true, groupOf: { '/a': 'w', '/b': 2 } })).toEqual({ repos: ['/a'], collapsed: true, groups: [], groupOf: { '/a': 'w' }, foldedGroups: [] });
});
