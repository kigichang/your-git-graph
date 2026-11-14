import { test, expect } from 'vitest';
import { isRemote, parseRemote, invalidRemote, absolutePath, remoteId, invalidShare } from './remote';

test('a remote repository is told from a local one, and taken apart', () => {
	expect(isRemote('/Users/me/repo')).toBe(false);
	expect(isRemote(null)).toBe(false);
	expect(parseRemote('/a/ssh://h/p')).toBe(null);
	expect(parseRemote('ssh://me@build:2222/srv/git/app')).toEqual({ host: 'ssh://me@build:2222', authority: 'me@build:2222', path: '/srv/git/app' });
});

test('what was typed is checked before anything reaches ssh', () => {
	const ok = (destination: string, port = '') => invalidRemote({ destination, port });
	for (const fine of ['host', 'me@host', 'me@build.example.com', 'my_alias', '10.0.0.5']) expect(ok(fine), fine).toBe(null);
	expect(ok('host', '2222')).toBe(null);
	for (const bad of ['', '-oProxyCommand=x', 'me@-host', '-me@host', 'a b', 'me@', 'h;id', '$(id)', 'me@ho/st']) expect(ok(bad), bad).not.toBe(null);
	for (const port of ['0', '65536', 'x', '-1', '22a']) expect(ok('host', port), port).not.toBe(null);
});

test('a typed path becomes absolute, from the home directory unless it starts with /', () => {
	const at = (path: string) => absolutePath(path, '/home/me');
	expect(at('/srv/repo/')).toBe('/srv/repo');
	expect(at('~/work/repo')).toBe('/home/me/work/repo');
	expect(at('work/repo')).toBe('/home/me/work/repo');
	expect(at('~')).toBe('/home/me');
	expect(at('')).toBe('/home/me');
	expect(at(' /srv ')).toBe('/srv');
	expect(at('/')).toBe('/');
	expect(remoteId('me@host', '', '/srv/repo')).toBe('ssh://me@host/srv/repo');
	expect(remoteId('host', '022', '/r')).toBe('ssh://host:22/r');
});

test('the address of a network share', () => {
	for (const fine of ['smb://nas/projects', 'smb://me@nas.local/projects/sub', 'smb://me@10.0.0.2:1445/My%20Share']) expect(invalidShare(fine), fine).toBe(null);
	for (const bad of ['nas/projects', 'afp://nas/x', 'smb://', 'smb://nas', 'smb://nas/', 'smb:///share', 'smb://nas/my share']) expect(invalidShare(bad), bad).not.toBe(null);
});
