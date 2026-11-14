// What the context menu offers for what was right-clicked. Pure: the items are ids the window
// acts on (App.svelte); tested in menus.test.ts.
import type { Commit, FileChange } from './api/client';
import { t, type Key } from './i18n';

export type MenuTarget =
	| { kind: 'commit'; commit: Commit; isHead: boolean }
	| { kind: 'uncommitted'; commit: Commit }
	| { kind: 'branch'; name: string; commit: Commit; current: boolean }
	/** `name` as shown (`origin/x`); `remote` null when the remote is not one of the repository's. */
	| { kind: 'remoteBranch'; name: string; remote: string | null; commit: Commit }
	| { kind: 'tag'; name: string; annotated: boolean; commit: Commit }
	| { kind: 'stash'; selector: string; commit: Commit }
	| { kind: 'file'; change: FileChange }
	| { kind: 'background' };

export type MenuItem = { id: MenuAction; label: string; danger?: boolean; disabled?: boolean } | { separator: true };

export type MenuAction =
	| 'createBranch' | 'checkoutCommit' | 'cherryPick' | 'revert' | 'mergeInto' | 'rebaseOnto' | 'resetTo' | 'addTag' | 'createArchive'
	| 'dropCommit' | 'editMessage' | 'fixup' | 'squash' | 'undoLastCommit' | 'compare' | 'copyHash' | 'copySubject'
	| 'checkoutBranch' | 'renameBranch' | 'deleteBranch' | 'push' | 'copyName'
	| 'checkoutRemoteBranch' | 'fetchIntoLocal' | 'pull' | 'deleteRemoteBranch'
	| 'viewTag' | 'deleteTag' | 'pushTag'
	| 'applyStash' | 'popStash' | 'dropStash' | 'branchFromStash'
	| 'stash' | 'cleanUntracked' | 'resetUncommitted'
	| 'openTerminal' | 'revealFinder' | 'refresh' | 'fetch'
	| 'viewFile' | 'openFile' | 'copyPath' | 'resetFile' | 'diffWithWorking';

export type MenuContext = {
	/** Whether a row other than the target is selected (to compare with). */
	hasSelection: boolean;
	/** On another machine: no Finder, no opening files. */
	remote: boolean;
	/** Whether something is staged (fixup and squash need it). */
	staged: boolean;
};

const item = (id: MenuAction, opts: { danger?: boolean; disabled?: boolean } = {}): MenuItem => ({ id, label: t(('menu.' + id) as Key), ...opts });
const SEP: MenuItem = { separator: true };

export function menuFor(target: MenuTarget, ctx: MenuContext): MenuItem[] {
	switch (target.kind) {
		case 'commit':
			return [
				item('createBranch'), item('checkoutCommit'), item('cherryPick'), item('revert'), SEP,
				item('mergeInto'), item('rebaseOnto'), item('resetTo', { danger: true }), SEP,
				item('addTag'), item('createArchive', { disabled: ctx.remote }), SEP,
				...(target.isHead ? [item('undoLastCommit', { danger: true })] : []),
				item('dropCommit', { danger: true }), item('editMessage'),
				item('fixup', { disabled: !ctx.staged }), item('squash', { disabled: !ctx.staged }), SEP,
				item('compare', { disabled: !ctx.hasSelection }), item('copyHash'), item('copySubject')
			];
		case 'uncommitted':
			return [item('stash'), item('cleanUntracked', { danger: true }), item('resetUncommitted', { danger: true }), SEP, item('openTerminal'), item('compare', { disabled: !ctx.hasSelection })];
		case 'branch':
			return [
				item('checkoutBranch', { disabled: target.current }), item('renameBranch'), item('deleteBranch', { danger: true, disabled: target.current }), SEP,
				item('mergeInto', { disabled: target.current }), item('rebaseOnto', { disabled: target.current }), item('push'), SEP,
				item('copyName')
			];
		case 'remoteBranch':
			return [
				item('checkoutRemoteBranch'), item('fetchIntoLocal', { disabled: target.remote === null }), item('pull', { disabled: target.remote === null }), SEP,
				item('mergeInto'), item('rebaseOnto'), item('deleteRemoteBranch', { danger: true, disabled: target.remote === null }), SEP,
				item('copyName')
			];
		case 'tag':
			return [item('viewTag'), item('pushTag'), item('deleteTag', { danger: true }), item('createArchive', { disabled: ctx.remote }), SEP, item('copyName')];
		case 'stash':
			return [item('applyStash'), item('popStash'), item('dropStash', { danger: true }), item('branchFromStash'), SEP, item('copyName')];
		case 'file':
			return [
				item('viewFile', { disabled: target.change.status === 'D' }), item('openFile', { disabled: ctx.remote || target.change.status === 'D' }),
				item('diffWithWorking', { disabled: target.change.status === 'D' }), SEP,
				item('resetFile', { danger: true, disabled: target.change.status === 'U' }), SEP, item('copyPath')
			];
		case 'background':
			return [item('refresh'), item('fetch'), SEP, item('openTerminal'), item('revealFinder', { disabled: ctx.remote })];
	}
}

