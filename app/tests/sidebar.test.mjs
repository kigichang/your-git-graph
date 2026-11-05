/* The repository sidebar's pure helpers (app/ui/host/sidebar.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarOf, labelsOf, addRepos, removeRepo, moveRepo, parseAheadBehind, badgeOf, baseName, groupsOf, moveToGroup, moveManyToGroup, invalidGroupName, renameGroup, removeGroup } from '../ui/host/sidebar.js';

test('avatars: the first letter or digit, a colour that stays with the name', () => {
	assert.equal(avatarOf('/r/git-graph').letter, 'G');
	assert.equal(avatarOf('/r/.dotfiles').letter, 'D');
	assert.equal(avatarOf('/r/2048').letter, '2');
	assert.equal(avatarOf('/r/中文專案').letter, '中');
	assert.equal(avatarOf('/a/same').colour, avatarOf('/b/same').colour);
	assert.match(avatarOf('/r/x').colour, /^#[0-9a-f]{6}$/);
	assert.equal(baseName('/r/repo/'), 'repo');
});

test('labels: the folder name, with where it is only when names collide', () => {
	assert.deepEqual(labelsOf(['/a/app', '/b/app', '/c/tool']), {
		'/a/app': { name: 'app', hint: 'a' },
		'/b/app': { name: 'app', hint: 'b' },
		'/c/tool': { name: 'tool', hint: null }
	});
});

test('adding keeps the order and never doubles', () => {
	assert.deepEqual(addRepos(['/a', '/b'], ['/b', '/c', '/c', '/d']), ['/a', '/b', '/c', '/d']);
	assert.deepEqual(addRepos([], []), []);
});

test('removing the shown repository shows the one that took its place, else the one before', () => {
	assert.deepEqual(removeRepo(['/a', '/b', '/c'], '/b', '/b'), { list: ['/a', '/c'], show: '/c' });
	assert.deepEqual(removeRepo(['/a', '/b', '/c'], '/c', '/c'), { list: ['/a', '/b'], show: '/b' });
	assert.deepEqual(removeRepo(['/a'], '/a', '/a'), { list: [], show: null });
	assert.deepEqual(removeRepo(['/a', '/b'], '/a', '/b'), { list: ['/b'], show: '/b' }, 'another one: the shown stays');
	assert.deepEqual(removeRepo(['/a'], '/x', '/a'), { list: ['/a'], show: '/a' });
});

test('moving puts the repository just before another, or at the end', () => {
	assert.deepEqual(moveRepo(['/a', '/b', '/c'], '/c', '/a'), ['/c', '/a', '/b']);
	assert.deepEqual(moveRepo(['/a', '/b', '/c'], '/a', '/c'), ['/b', '/a', '/c']);
	assert.deepEqual(moveRepo(['/a', '/b', '/c'], '/a', null), ['/b', '/c', '/a']);
	assert.deepEqual(moveRepo(['/a', '/b', '/c'], '/a', '/b'), ['/a', '/b', '/c'], 'before the next one: where it was');
	assert.deepEqual(moveRepo(['/a', '/b', '/c'], '/b', '/b'), ['/a', '/b', '/c']);
	assert.deepEqual(moveRepo(['/a', '/b'], '/x', '/a'), ['/a', '/b'], 'not in the list: unchanged');
	assert.deepEqual(moveRepo(['/a', '/b'], '/b', '/x'), ['/a', '/b'], 'before one not in the list: the end');
});

test('ahead/behind from rev-list --left-right --count, and its badge', () => {
	assert.deepEqual(parseAheadBehind('2\t3\n'), { behind: 2, ahead: 3 });
	assert.equal(parseAheadBehind(''), null);
	assert.equal(parseAheadBehind('fatal: no upstream'), null);
	assert.equal(badgeOf({ ahead: 1, behind: 0 }), '↑1');
	assert.equal(badgeOf({ ahead: 0, behind: 4 }), '↓4');
	assert.equal(badgeOf({ ahead: 2, behind: 4 }), '↑2 ↓4');
	assert.equal(badgeOf({ ahead: 0, behind: 0 }), '');
	assert.equal(badgeOf(null), '');
});

test('repositories are shown by group, those in none under default', () => {
	const repos = ['/a', '/b', '/c', '/d'];
	assert.deepEqual(groupsOf(repos, [], {}), [{ group: null, repos }]);
	const groupOf = { '/b': 'work', '/d': 'work', '/c': 'gone' };
	assert.deepEqual(groupsOf(repos, ['work', 'empty'], groupOf),
		[{ group: null, repos: ['/a', '/c'] }, { group: 'work', repos: ['/b', '/d'] }, { group: 'empty', repos: [] }], 'a group that no longer exists counts as none');
});

test('a repository is dropped into a group at a place, or back into default', () => {
	const repos = ['/a', '/b', '/c', '/d'], groupOf = { '/b': 'work', '/d': 'work' };
	const shown = (moved) => groupsOf(moved.list, ['work'], moved.groupOf).map((g) => g.repos);
	assert.deepEqual(shown(moveToGroup(repos, groupOf, '/a', 'work', '/d')), [['/c'], ['/b', '/a', '/d']]);
	assert.deepEqual(shown(moveToGroup(repos, groupOf, '/a', 'work', null)), [['/c'], ['/b', '/d', '/a']], 'at its end');
	assert.deepEqual(shown(moveToGroup(repos, groupOf, '/d', null, '/a')), [['/d', '/a', '/c'], ['/b']]);
	assert.deepEqual(shown(moveToGroup(repos, groupOf, '/c', null, '/a')), [['/c', '/a'], ['/b', '/d']], 'within its group');
	assert.deepEqual(moveToGroup(repos, groupOf, '/b', null, null).groupOf, { '/d': 'work' });
	assert.deepEqual(groupOf, { '/b': 'work', '/d': 'work' }, 'the argument is left alone');
});

test('groups are named, renamed and removed', () => {
	assert.notEqual(invalidGroupName('', [], undefined), null);
	assert.notEqual(invalidGroupName('Default', [], undefined), null, 'the name of the group of the ungrouped');
	assert.notEqual(invalidGroupName('work', ['work'], undefined), null);
	assert.notEqual(invalidGroupName('work', ['work', 'home'], 'home'), null);
	assert.equal(invalidGroupName('work', ['work'], 'work'), null, 'renamed to itself');
	assert.equal(invalidGroupName('home', ['work'], undefined), null);
	assert.deepEqual(renameGroup(['work', 'home'], { '/a': 'work', '/b': 'home' }, 'work', 'job'), { groups: ['job', 'home'], groupOf: { '/a': 'job', '/b': 'home' } });
	assert.deepEqual(removeGroup(['work', 'home'], { '/a': 'work', '/b': 'home' }, 'work'), { groups: ['home'], groupOf: { '/b': 'home' } });
});

test('several repositories are dropped into a group together, keeping their order', () => {
	const repos = ['/a', '/b', '/c', '/d', '/e'], groupOf = { '/d': 'work' };
	const shown = (moved) => groupsOf(moved.list, ['work'], moved.groupOf).map((g) => g.repos);
	assert.deepEqual(shown(moveManyToGroup(repos, groupOf, ['/a', '/c'], 'work', '/d')), [['/b', '/e'], ['/a', '/c', '/d']]);
	assert.deepEqual(shown(moveManyToGroup(repos, groupOf, ['/a', '/c'], 'work', null)), [['/b', '/e'], ['/d', '/a', '/c']]);
	assert.deepEqual(shown(moveManyToGroup(repos, groupOf, ['/b', '/d'], null, null)), [['/a', '/c', '/e', '/b', '/d'], []]);
	assert.deepEqual(shown(moveManyToGroup(repos, groupOf, ['/c'], 'work', null)), shown(moveToGroup(repos, groupOf, '/c', 'work', null)));
});
