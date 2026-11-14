// The dialogs of the operations: what each asks (its fields, with defaults from the settings)
// and the request it builds from the answers. Pure; tested in dialogs.test.ts. The window
// renders a spec with FormDialog.svelte.
import type { OpRequest, Details } from './api/client';
import type { Settings } from './settings.svelte';
import { t, type Key } from './i18n';
import { shortHash } from './names';
import type { MenuAction, MenuTarget } from './menus';

export type Field =
	| { kind: 'text'; id: string; label: string; value: string; placeholder?: string; refName?: boolean }
	| { kind: 'textarea'; id: string; label: string; value: string }
	| { kind: 'checkbox'; id: string; label: string; value: boolean }
	| { kind: 'select'; id: string; label: string; value: string; options: { value: string; label: string }[] }
	| { kind: 'radio'; id: string; label: string; value: string; options: { value: string; label: string }[] }
	| { kind: 'info'; text: string };

export type Values = Record<string, string | boolean>;

export type DialogSpec<T = OpRequest> = {
	title: string;
	/** The primary button. */
	action: string;
	danger?: boolean;
	fields: Field[];
	/** The request (or whatever the dialog is for) from the answers, or what is wrong with them. */
	build: (values: Values) => T | { error: string };
};

export type DialogContext = {
	settings: Settings;
	remotes: string[];
	/** The checked-out branch, if any. */
	currentBranch: string | null;
	/** The details of the target commit, when loaded (its message, for editing). */
	details: Details | null;
};

/** A dialog default from the settings (`dialogs.<dialog>.<field>`), else `fallback`. */
export function dialogDefault<T extends string | boolean>(settings: Settings, key: string, fallback: T): T {
	const v = (settings.dialogs as Record<string, unknown>)[key];
	return (typeof v === typeof fallback ? v : fallback) as T;
}

const str = (v: Values, id: string) => (typeof v[id] === 'string' ? (v[id] as string) : '');
const bool = (v: Values, id: string) => v[id] === true;
const trimmed = (v: Values, id: string) => str(v, id).trim();

function remoteOptions(remotes: string[], none: string): { value: string; label: string }[] {
	return [{ value: '', label: none }, ...remotes.map((r) => ({ value: r, label: r }))];
}

/** Which parents a merge commit can be picked or reverted against. */
function parentOptions(commit: { parents: string[] }): { value: string; label: string }[] {
	return commit.parents.map((p, i) => ({ value: String(i + 1), label: `${i + 1}: ${shortHash(p)}` }));
}

export function dialogFor(action: MenuAction, target: MenuTarget, ctx: DialogContext): DialogSpec | null {
	const s = ctx.settings;
	const d = <T extends string | boolean>(key: string, fallback: T) => dialogDefault(s, key, fallback);
	const commit = 'commit' in target ? target.commit : null;
	const hash = commit?.hash ?? '';
	const name = target.kind === 'commit' || target.kind === 'uncommitted' ? shortHash(hash) : 'name' in target ? target.name : target.kind === 'stash' ? target.selector : '';
	const needName = (v: Values, id: string): string | null => (trimmed(v, id) === '' ? t('dialog.name') + '?' : null);

	switch (action) {
		case 'createBranch':
			return {
				title: t('dialog.createBranch.title'), action: t('dialog.createBranch.action'),
				fields: [
					{ kind: 'text', id: 'name', label: t('dialog.name'), value: '', refName: true },
					{ kind: 'checkbox', id: 'checkout', label: t('dialog.createBranch.checkout'), value: d('createBranch.checkout', false) }
				],
				build: (v) => needName(v, 'name') ? { error: needName(v, 'name') as string } : { kind: 'createBranch', branch: trimmed(v, 'name'), commit: hash, checkout: bool(v, 'checkout'), force: false }
			};
		case 'checkoutRemoteBranch': {
			if (target.kind !== 'remoteBranch') return null;
			const local = target.remote !== null && target.name.startsWith(target.remote + '/') ? target.name.slice(target.remote.length + 1) : target.name.split('/').slice(1).join('/');
			return {
				title: t('dialog.checkoutRemote.title', { name: target.name }), action: t('dialog.checkoutRemote.action'),
				fields: [{ kind: 'text', id: 'name', label: t('dialog.checkoutRemote.localName'), value: local, refName: true }],
				build: (v) => needName(v, 'name') ? { error: needName(v, 'name') as string } : { kind: 'checkoutBranch', branch: trimmed(v, 'name'), remoteBranch: target.name, pullAfterwards: null }
			};
		}
		case 'renameBranch':
			if (target.kind !== 'branch') return null;
			return {
				title: t('dialog.renameBranch.title', { name }), action: t('dialog.renameBranch.action'),
				fields: [{ kind: 'text', id: 'name', label: t('dialog.name'), value: target.name, refName: true }],
				build: (v) => needName(v, 'name') ? { error: needName(v, 'name') as string } : { kind: 'renameBranch', oldName: target.name, newName: trimmed(v, 'name') }
			};
		case 'deleteBranch':
			if (target.kind !== 'branch') return null;
			return {
				title: t('dialog.deleteBranch.title', { name }), action: t('dialog.deleteBranch.action'), danger: true,
				fields: [
					{ kind: 'checkbox', id: 'force', label: t('dialog.deleteBranch.force'), value: d('deleteBranch.force', false) },
					{ kind: 'select', id: 'remote', label: t('dialog.deleteBranch.remote'), value: '', options: remoteOptions(ctx.remotes, t('dialog.none')) }
				],
				build: (v) => ({ kind: 'deleteBranch', branch: target.name, force: bool(v, 'force'), deleteOnRemotes: str(v, 'remote') === '' ? [] : [str(v, 'remote')] })
			};
		case 'deleteRemoteBranch': {
			if (target.kind !== 'remoteBranch' || target.remote === null) return null;
			const remote = target.remote, branch = target.name.slice(remote.length + 1);
			return {
				title: t('dialog.deleteRemoteBranch.title', { name: branch, remote }), action: t('dialog.deleteBranch.action'), danger: true,
				fields: [{ kind: 'info', text: t('dialog.deleteRemoteBranch.info') }],
				build: () => ({ kind: 'deleteRemoteBranch', remote, branch })
			};
		}
		case 'push':
			if (target.kind !== 'branch') return null;
			return {
				title: t('dialog.push.title', { name }), action: t('dialog.push.action'),
				fields: [
					{ kind: 'select', id: 'remote', label: t('dialog.remote'), value: ctx.remotes[0] ?? '', options: ctx.remotes.map((r) => ({ value: r, label: r })) },
					{ kind: 'checkbox', id: 'setUpstream', label: t('dialog.push.setUpstream'), value: true },
					{ kind: 'radio', id: 'mode', label: t('dialog.push.mode'), value: 'normal', options: [
						{ value: 'normal', label: t('dialog.push.normal') }, { value: 'force-with-lease', label: t('dialog.push.forceWithLease') }, { value: 'force', label: t('dialog.push.force') }
					] }
				],
				build: (v) => str(v, 'remote') === '' ? { error: t('dialog.remote') + '?' }
					: { kind: 'push', branch: target.name, remotes: [str(v, 'remote')], setUpstream: bool(v, 'setUpstream'), mode: str(v, 'mode') as 'normal' | 'force' | 'force-with-lease' }
			};
		case 'fetch':
			return {
				title: t('dialog.fetch.title'), action: t('dialog.fetch.action'),
				fields: [
					{ kind: 'select', id: 'remote', label: t('dialog.remote'), value: '', options: remoteOptions(ctx.remotes, t('dialog.all')) },
					{ kind: 'checkbox', id: 'prune', label: t('dialog.fetch.prune'), value: d('fetch.prune', s.repository.fetchAndPrune) },
					{ kind: 'checkbox', id: 'pruneTags', label: t('dialog.fetch.pruneTags'), value: d('fetch.pruneTags', s.repository.fetchAndPruneTags) }
				],
				build: (v) => ({ kind: 'fetch', remote: str(v, 'remote') === '' ? null : str(v, 'remote'), prune: bool(v, 'prune'), pruneTags: bool(v, 'pruneTags') })
			};
		case 'fetchIntoLocal': {
			if (target.kind !== 'remoteBranch' || target.remote === null) return null;
			const remote = target.remote, remoteBranch = target.name.slice(remote.length + 1);
			return {
				title: t('dialog.fetchIntoLocal.title', { remote: target.name, local: remoteBranch }), action: t('dialog.fetchIntoLocal.action'),
				fields: [
					{ kind: 'text', id: 'local', label: t('dialog.checkoutRemote.localName'), value: remoteBranch, refName: true },
					{ kind: 'checkbox', id: 'force', label: t('dialog.fetchIntoLocal.force'), value: d('fetchIntoLocalBranch.force', false) }
				],
				build: (v) => needName(v, 'local') ? { error: needName(v, 'local') as string } : { kind: 'fetchIntoLocalBranch', remote, remoteBranch, localBranch: trimmed(v, 'local'), force: bool(v, 'force') }
			};
		}
		case 'pull': {
			if (target.kind !== 'remoteBranch' || target.remote === null) return null;
			const remote = target.remote, branch = target.name.slice(remote.length + 1);
			return {
				title: t('dialog.pull.title', { name: target.name }), action: t('dialog.pull.action'),
				fields: [
					{ kind: 'checkbox', id: 'noFastForward', label: t('dialog.pull.noFastForward'), value: d('pull.noFastForward', false) },
					{ kind: 'checkbox', id: 'squash', label: t('dialog.pull.squash'), value: d('pull.squash', false) }
				],
				build: (v) => ({ kind: 'pull', remote, branch, noFastForward: bool(v, 'noFastForward'), squash: bool(v, 'squash') })
			};
		}
		case 'mergeInto': {
			const what = target.kind === 'branch' || target.kind === 'remoteBranch' ? target.name : hash;
			return {
				title: t('dialog.merge.title', { name }), action: t('dialog.merge.action'),
				fields: [
					{ kind: 'checkbox', id: 'noFastForward', label: t('dialog.merge.noFastForward'), value: d('merge.noFastForward', false) },
					{ kind: 'checkbox', id: 'squash', label: t('dialog.merge.squash'), value: d('merge.squash', false) },
					{ kind: 'checkbox', id: 'noCommit', label: t('dialog.merge.noCommit'), value: d('merge.noCommit', false) }
				],
				build: (v) => ({ kind: 'merge', target: what, noFastForward: bool(v, 'noFastForward'), squash: bool(v, 'squash'), noCommit: bool(v, 'noCommit') })
			};
		}
		case 'rebaseOnto': {
			const what = target.kind === 'branch' || target.kind === 'remoteBranch' ? target.name : hash;
			return {
				title: t('dialog.rebase.title', { name }), action: t('dialog.rebase.action'),
				fields: [
					{ kind: 'checkbox', id: 'ignoreDate', label: t('dialog.rebase.ignoreDate'), value: d('rebase.ignoreDate', false) },
					{ kind: 'checkbox', id: 'autosquash', label: t('dialog.rebase.autosquash'), value: d('rebase.autosquash', false) },
					{ kind: 'checkbox', id: 'interactive', label: t('dialog.rebase.interactive'), value: d('rebase.interactive', false) }
				],
				build: (v) => ({ kind: 'rebase', onto: what, ignoreDate: bool(v, 'ignoreDate'), autosquash: bool(v, 'autosquash'), interactive: bool(v, 'interactive') })
			};
		}
		case 'cherryPick':
			if (commit === null) return null;
			return {
				title: t('dialog.cherryPick.title', { name }), action: t('dialog.cherryPick.action'),
				fields: [
					...(commit.parents.length > 1 ? [{ kind: 'select', id: 'parent', label: t('dialog.cherryPick.parent'), value: '1', options: parentOptions(commit) } as Field] : []),
					{ kind: 'checkbox', id: 'recordOrigin', label: t('dialog.cherryPick.recordOrigin'), value: d('cherryPick.recordOrigin', false) },
					{ kind: 'checkbox', id: 'noCommit', label: t('dialog.cherryPick.noCommit'), value: d('cherryPick.noCommit', false) }
				],
				build: (v) => ({ kind: 'cherryPick', commit: hash, parentIndex: commit.parents.length > 1 ? Number(str(v, 'parent')) || 1 : 0, recordOrigin: bool(v, 'recordOrigin'), noCommit: bool(v, 'noCommit') })
			};
		case 'revert':
			if (commit === null) return null;
			return {
				title: t('dialog.revert.title', { name }), action: t('dialog.revert.action'),
				fields: commit.parents.length > 1 ? [{ kind: 'select', id: 'parent', label: t('dialog.revert.parent'), value: '1', options: parentOptions(commit) }] : [],
				build: (v) => ({ kind: 'revert', commit: hash, parentIndex: commit.parents.length > 1 ? Number(str(v, 'parent')) || 1 : 0 })
			};
		case 'resetTo':
			return {
				title: t('dialog.reset.title', { name }), action: t('dialog.reset.action'), danger: true,
				fields: [{ kind: 'radio', id: 'mode', label: t('dialog.reset.mode'), value: d('reset.mode', 'mixed'), options: [
					{ value: 'soft', label: t('dialog.reset.soft') }, { value: 'mixed', label: t('dialog.reset.mixed') }, { value: 'hard', label: t('dialog.reset.hard') }
				] }],
				build: (v) => ({ kind: 'reset', commit: hash, mode: str(v, 'mode') as 'soft' | 'mixed' | 'hard' })
			};
		case 'resetUncommitted':
			return {
				title: t('dialog.resetUncommitted.title'), action: t('dialog.reset.action'), danger: true,
				fields: [{ kind: 'radio', id: 'mode', label: t('dialog.reset.mode'), value: d('resetUncommitted.mode', 'mixed'), options: [
					{ value: 'mixed', label: t('dialog.resetUncommitted.mixed') }, { value: 'hard', label: t('dialog.resetUncommitted.hard') }
				] }],
				build: (v) => ({ kind: 'reset', commit: 'HEAD', mode: str(v, 'mode') as 'mixed' | 'hard' })
			};
		case 'undoLastCommit':
			return { title: t('dialog.undoLastCommit.title'), action: t('dialog.undoLastCommit.action'), danger: true, fields: [{ kind: 'info', text: t('dialog.undoLastCommit.info') }], build: () => ({ kind: 'undoLastCommit' }) };
		case 'dropCommit':
			return { title: t('dialog.dropCommit.title', { name }), action: t('dialog.dropCommit.action'), danger: true, fields: [{ kind: 'info', text: t('dialog.dropCommit.info') }], build: () => ({ kind: 'dropCommit', commit: hash }) };
		case 'editMessage': {
			const details = ctx.details;
			return {
				title: t('dialog.editMessage.title', { name }), action: t('dialog.editMessage.action'),
				fields: [
					{ kind: 'textarea', id: 'message', label: t('dialog.message'), value: details?.body ?? commit?.message ?? '' },
					{ kind: 'text', id: 'authorName', label: t('dialog.editMessage.authorName'), value: details?.author ?? '' },
					{ kind: 'text', id: 'authorEmail', label: t('dialog.editMessage.authorEmail'), value: details?.authorEmail ?? '' }
				],
				build: (v) => {
					if (trimmed(v, 'message') === '') return { error: t('dialog.message') + '?' };
					const authorName = trimmed(v, 'authorName'), authorEmail = trimmed(v, 'authorEmail');
					const changed = details !== null && (authorName !== details.author || authorEmail !== details.authorEmail);
					return { kind: 'editCommitMessage', commit: hash, message: str(v, 'message').replace(/\s+$/, ''), author: changed && authorName !== '' && authorEmail !== '' ? { name: authorName, email: authorEmail } : null };
				}
			};
		}
		case 'addTag':
			return {
				title: t('dialog.addTag.title', { name }), action: t('dialog.addTag.action'),
				fields: [
					{ kind: 'text', id: 'name', label: t('dialog.name'), value: '', refName: true },
					{ kind: 'radio', id: 'kind', label: t('dialog.addTag.kind'), value: d('addTag.type', 'annotated'), options: [{ value: 'annotated', label: t('dialog.addTag.annotated') }, { value: 'lightweight', label: t('dialog.addTag.lightweight') }] },
					{ kind: 'textarea', id: 'message', label: t('dialog.message'), value: '' },
					{ kind: 'select', id: 'pushTo', label: t('dialog.addTag.pushTo'), value: d('addTag.pushToRemote', false) ? (ctx.remotes[0] ?? '') : '', options: remoteOptions(ctx.remotes, t('dialog.none')) }
				],
				build: (v) => needName(v, 'name') ? { error: needName(v, 'name') as string }
					: { kind: 'addTag', tag: trimmed(v, 'name'), commit: hash, tagKind: str(v, 'kind') === 'lightweight' ? 'lightweight' : 'annotated', message: str(v, 'message'), force: false, pushTo: str(v, 'pushTo') === '' ? null : str(v, 'pushTo') }
			};
		case 'deleteTag':
			if (target.kind !== 'tag') return null;
			return {
				title: t('dialog.deleteTag.title', { name }), action: t('dialog.deleteTag.action'), danger: true,
				fields: [{ kind: 'select', id: 'remote', label: t('dialog.deleteTag.remote'), value: '', options: remoteOptions(ctx.remotes, t('dialog.none')) }],
				build: (v) => ({ kind: 'deleteTag', tag: target.name, deleteOnRemote: str(v, 'remote') === '' ? null : str(v, 'remote') })
			};
		case 'pushTag':
			if (target.kind !== 'tag') return null;
			return {
				title: t('dialog.pushTag.title', { name }), action: t('dialog.pushTag.action'),
				fields: [{ kind: 'select', id: 'remote', label: t('dialog.remote'), value: ctx.remotes[0] ?? '', options: ctx.remotes.map((r) => ({ value: r, label: r })) }],
				build: (v) => str(v, 'remote') === '' ? { error: t('dialog.remote') + '?' } : { kind: 'pushTag', tag: target.name, commit: hash, remotes: [str(v, 'remote')] }
			};
		case 'stash':
			return {
				title: t('dialog.stash.title'), action: t('dialog.stash.action'),
				fields: [
					{ kind: 'text', id: 'message', label: t('dialog.message'), value: '' },
					{ kind: 'checkbox', id: 'untracked', label: t('dialog.stash.includeUntracked'), value: d('stash.includeUntracked', false) }
				],
				build: (v) => ({ kind: 'stashPush', message: trimmed(v, 'message'), includeUntracked: bool(v, 'untracked') })
			};
		case 'applyStash':
			if (target.kind !== 'stash') return null;
			return {
				title: t('dialog.applyStash.title', { name }), action: t('dialog.applyStash.action'),
				fields: [{ kind: 'checkbox', id: 'index', label: t('dialog.applyStash.reinstateIndex'), value: d('applyStash.reinstateIndex', false) }],
				build: (v) => ({ kind: 'stashApply', selector: target.selector, reinstateIndex: bool(v, 'index') })
			};
		case 'popStash':
			if (target.kind !== 'stash') return null;
			return {
				title: t('dialog.popStash.title', { name }), action: t('dialog.popStash.action'),
				fields: [{ kind: 'checkbox', id: 'index', label: t('dialog.applyStash.reinstateIndex'), value: d('popStash.reinstateIndex', false) }],
				build: (v) => ({ kind: 'stashPop', selector: target.selector, reinstateIndex: bool(v, 'index') })
			};
		case 'dropStash':
			if (target.kind !== 'stash') return null;
			return { title: t('dialog.dropStash.title', { name }), action: t('dialog.dropStash.action'), danger: true, fields: [{ kind: 'info', text: t('dialog.dropStash.info') }], build: () => ({ kind: 'stashDrop', selector: target.selector }) };
		case 'branchFromStash':
			if (target.kind !== 'stash') return null;
			return {
				title: t('dialog.branchFromStash.title', { name }), action: t('dialog.branchFromStash.action'),
				fields: [{ kind: 'text', id: 'name', label: t('dialog.name'), value: '', refName: true }],
				build: (v) => needName(v, 'name') ? { error: needName(v, 'name') as string } : { kind: 'branchFromStash', branch: trimmed(v, 'name'), selector: target.selector }
			};
		case 'cleanUntracked':
			return {
				title: t('dialog.cleanUntracked.title'), action: t('dialog.cleanUntracked.action'), danger: true,
				fields: [{ kind: 'info', text: t('dialog.cleanUntracked.info') }, { kind: 'checkbox', id: 'directories', label: t('dialog.cleanUntracked.directories'), value: true }],
				build: (v) => ({ kind: 'cleanUntracked', directories: bool(v, 'directories') })
			};
		default:
			return null;
	}
}

/** The reset-file confirmation (the revision comes from the details shown). */
export function resetFileDialog(path: string, revision: string): DialogSpec {
	return { title: t('dialog.resetFile.title', { name: path }), action: t('dialog.resetFile.action'), danger: true, fields: [{ kind: 'info', text: t('dialog.resetFile.info') }], build: () => ({ kind: 'resetFile', commit: revision, path }) };
}

/** Spaces typed into a reference name, as the settings say: dropped, a hyphen or an underscore. */
export function substituteSpaces(settings: Settings, value: string): string {
	const how: string = dialogDefault(settings, 'general.spaceSubstitution', 'none');
	return how === 'hyphen' ? value.replace(/\s+/g, '-') : how === 'underscore' ? value.replace(/\s+/g, '_') : value;
}

/** Which operations stream their output (a progress window while they run). */
export function isStreamed(request: OpRequest): boolean {
	return ['fetch', 'fetchIntoLocalBranch', 'pull', 'push', 'pushTag', 'addRemote', 'deleteRemoteBranch'].includes(request.kind)
		|| (request.kind === 'addTag' && request.pushTo !== null) || (request.kind === 'deleteTag' && request.deleteOnRemote !== null)
		|| (request.kind === 'deleteBranch' && request.deleteOnRemotes.length > 0);
}

/** A name for an operation in progress (the progress window's title). */
export function labelOf(request: OpRequest): string {
	return (({ fetch: 'dialog.fetch.action', pull: 'dialog.pull.action', push: 'dialog.push.action', merge: 'dialog.merge.action', rebase: 'dialog.rebase.action' } as Record<string, Key>)[request.kind]
		? t(({ fetch: 'dialog.fetch.action', pull: 'dialog.pull.action', push: 'dialog.push.action', merge: 'dialog.merge.action', rebase: 'dialog.rebase.action' } as Record<string, Key>)[request.kind] as Key)
		: request.kind);
}
