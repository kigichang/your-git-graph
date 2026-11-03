/* The repository sidebar's pure helpers (app/ui/host/sidebar.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarOf, labelsOf, addRepos, removeRepo, moveRepo, parseAheadBehind, badgeOf, baseName } from '../ui/host/sidebar.js';

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
