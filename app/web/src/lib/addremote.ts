// The dialogs that add a repository on another machine or on a share (what they ask and
// check; the connecting is the window's), and the group-name dialogs. Pure.
import type { DialogSpec } from './dialogs';
import { absolutePath, invalidRemote, invalidShare, remoteId } from './remote';
import { invalidGroupName } from './sidebar';
import { t } from './i18n';

export type RemoteAnswer = { destination: string; port: string; path: string };

export function addRemoteDialog(): DialogSpec<RemoteAnswer> {
	return {
		title: t('addRemote.title'), action: t('addRemote.action'),
		fields: [
			{ kind: 'text', id: 'destination', label: t('addRemote.destination'), value: '', placeholder: 'me@build.example.com' },
			{ kind: 'text', id: 'port', label: t('addRemote.port'), value: '' },
			{ kind: 'text', id: 'path', label: t('addRemote.path'), value: '', placeholder: 'work/repo' }
		],
		build: (v) => {
			const destination = String(v['destination'] ?? '').trim(), port = String(v['port'] ?? '').trim(), path = String(v['path'] ?? '').trim();
			const bad = invalidRemote({ destination, port });
			if (bad !== null) return { error: bad };
			if (path === '') return { error: t('addRemote.path') + '?' };
			return { destination, port, path };
		}
	};
}

/** The repository's name once the machine's home directory is known (a relative path starts
 * there); `null` when the path is absolute and no home is needed. */
export function remoteName(answer: RemoteAnswer, home: string | null): string | null {
	if (!answer.path.startsWith('/') && home === null) return null;
	return remoteId(answer.destination, answer.port, absolutePath(answer.path, home ?? ''));
}

/** The name of "some repository on that machine", to connect before the path is known. */
export const remoteRoot = (answer: RemoteAnswer): string => remoteId(answer.destination, answer.port, '/');

export function connectServerDialog(): DialogSpec<{ url: string }> {
	return {
		title: t('addServer.title'), action: t('addServer.action'),
		fields: [{ kind: 'text', id: 'url', label: t('addServer.url'), value: 'smb://', placeholder: 'smb://nas/projects' }],
		build: (v) => {
			const url = String(v['url'] ?? '').trim();
			const bad = invalidShare(url);
			return bad === null ? { url } : { error: bad };
		}
	};
}

export function groupNameDialog(groups: string[], current: string | null): DialogSpec<{ name: string }> {
	return {
		title: current === null ? t('sidebar.newGroupTitle') : t('sidebar.renameGroupTitle', { group: current }),
		action: current === null ? t('sidebar.create') : t('sidebar.rename'),
		fields: [{ kind: 'text', id: 'name', label: t('sidebar.groupName'), value: current ?? '' }],
		build: (v) => {
			const name = String(v['name'] ?? '').trim();
			const bad = invalidGroupName(name, groups, current);
			return bad === null ? { name } : { error: bad };
		}
	};
}
