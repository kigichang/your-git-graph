import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRemote, parseRemote, hostOf, pathOf, withPath, invalidRemote, absolutePath, remoteId, invalidShare } from '../ui/host/remote.js';

test('a remote repository is told from a local one, and taken apart', () => {
	assert.equal(isRemote('/Users/me/repo'), false);
	assert.equal(isRemote(null), false);
	assert.equal(parseRemote('/a/ssh://h/p'), null);
	assert.deepEqual(parseRemote('ssh://me@build:2222/srv/git/app'), { host: 'ssh://me@build:2222', authority: 'me@build:2222', path: '/srv/git/app' });
	assert.equal(hostOf('ssh://nas/volume1/x'), 'ssh://nas');
	assert.equal(hostOf('/local'), null);
	assert.equal(pathOf('ssh://nas/volume1/a b'), '/volume1/a b');
	assert.equal(pathOf('/local/repo'), '/local/repo');
	assert.equal(withPath('ssh://me@nas/any/where', '/srv/repo'), 'ssh://me@nas/srv/repo');
});

test('what was typed is checked before anything reaches ssh', () => {
	const ok = (destination, port = '') => invalidRemote({ destination, port });
	for (const fine of ['host', 'me@host', 'me@build.example.com', 'my_alias', '10.0.0.5']) assert.equal(ok(fine), null, fine);
	assert.equal(ok('host', '2222'), null);
	for (const bad of ['', '-oProxyCommand=x', 'me@-host', '-me@host', 'a b', 'me@', 'h;id', '$(id)', 'me@ho/st']) assert.notEqual(ok(bad), null, bad);
	for (const port of ['0', '65536', 'x', '-1', '22a']) assert.notEqual(ok('host', port), null, port);
});

test('a typed path becomes absolute, from the home directory unless it starts with /', () => {
	const at = (path) => absolutePath(path, '/home/me');
	assert.equal(at('/srv/repo/'), '/srv/repo');
	assert.equal(at('~/work/repo'), '/home/me/work/repo');
	assert.equal(at('work/repo'), '/home/me/work/repo');
	assert.equal(at('~'), '/home/me');
	assert.equal(at(''), '/home/me');
	assert.equal(at(' /srv '), '/srv');
	assert.equal(at('/'), '/');
	assert.equal(remoteId('me@host', '', '/srv/repo'), 'ssh://me@host/srv/repo');
	assert.equal(remoteId('host', '022', '/r'), 'ssh://host:22/r');
});

test('the address of a network share', () => {
	for (const fine of ['smb://nas/projects', 'smb://me@nas.local/projects/sub', 'smb://me@10.0.0.2:1445/My%20Share']) assert.equal(invalidShare(fine), null, fine);
	for (const bad of ['nas/projects', 'afp://nas/x', 'smb://', 'smb://nas', 'smb://nas/', 'smb:///share', 'smb://nas/my share']) assert.notEqual(invalidShare(bad), null, bad);
});
