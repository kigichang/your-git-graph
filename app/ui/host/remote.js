/* Repositories on another machine, reached over ssh (Rust: src-tauri/src/remote.rs). Such a
 * repository is named ssh://[user@]host[:port]/absolute/path wherever a local one is named by
 * its path; Rust routes by that name, so the host passes it along like any path. These are the
 * few places that must tell the two apart. Pure; tested in tests/remote.test.mjs. */

const SCHEME = 'ssh://';
const NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/; // never a leading "-" (ssh would take it for an option)

export const isRemote = (repo) => typeof repo === 'string' && repo.startsWith(SCHEME);

/** { host: 'ssh://[user@]host[:port]', authority, path } of a remote repository, else null. */
export function parseRemote(repo) {
	const m = isRemote(repo) ? /^ssh:\/\/([^/]+)(\/.*)$/.exec(repo) : null;
	return m === null ? null : { host: SCHEME + m[1], authority: m[1], path: m[2] };
}

/** The machine of a remote repository (the prefix its repositories share), else null. */
export const hostOf = (repo) => { const r = parseRemote(repo); return r === null ? null : r.host; };

/** The path of a repository on its own machine. */
export const pathOf = (repo) => { const r = parseRemote(repo); return r === null ? repo : r.path; };

/** The repository at `path` on the machine of the remote repository `repo`. */
export const withPath = (repo, path) => parseRemote(repo).host + path;

/** What is wrong with what was typed for a remote repository, or null. `destination` is what
 * ssh takes: [user@]host, or a Host of ~/.ssh/config. */
export function invalidRemote({ destination, port }) {
	const at = destination.lastIndexOf('@');
	const [user, host] = at === -1 ? [null, destination] : [destination.slice(0, at), destination.slice(at + 1)];
	if (!NAME.test(host)) return host === '' ? 'Enter the host to connect to.' : 'The host may only contain letters, digits, ".", "_" and "-".';
	if (user !== null && !NAME.test(user)) return 'The user name may only contain letters, digits, ".", "_" and "-".';
	if (port !== '' && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return 'The port is a number from 1 to 65535.';
	return null;
}

/** `path` as typed, on a machine whose home directory is `home`: absolute. Like ssh and scp,
 * a relative path (and ~) starts from the home directory. */
export function absolutePath(path, home) {
	const typed = path.trim();
	const full = typed.startsWith('/') ? typed : home + '/' + typed.replace(/^~\/?/, '');
	return full.replace(/\/+$/, '') || '/';
}

/** The name of the repository at the absolute `path` reached with `destination` and `port`. */
export const remoteId = (destination, port, path) => SCHEME + destination + (port === '' ? '' : ':' + Number(port)) + path;

/** What is wrong with the address typed for a network share (smb://[user@]server/share), or
 * null. Rust checks again before mounting (system.rs). */
export function invalidShare(url) {
	if (!url.startsWith('smb://')) return 'The address of a share starts with smb://';
	if (/\s/.test(url)) return 'The address of a share contains no spaces (write %20).';
	return /^smb:\/\/[^/]+\/[^/]/.test(url) ? null : 'The address of a share is smb://server/share';
}
