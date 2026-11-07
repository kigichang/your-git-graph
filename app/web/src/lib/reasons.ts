// The reasons an operation asks first, as sentences.
import type { Reason } from './api/client';
import { t } from './i18n';

export function reasonText(reason: Reason): string {
	switch (reason.kind) {
		case 'detachedCommits': return t('reason.detachedCommits', { count: reason.count });
		case 'resetDropsCommits': return t('reason.resetDropsCommits', { count: reason.count, branch: reason.branch });
		case 'uncommittedDiscarded': return t('reason.uncommittedDiscarded', { count: reason.count });
		case 'branchMoveDropsCommits': return t('reason.branchMoveDropsCommits', { count: reason.count, branch: reason.branch });
		case 'forcePushDropsCommits': return t('reason.forcePushDropsCommits', { count: reason.count, remoteBranch: reason.remoteBranch, branch: reason.branch });
		case 'tagCommitNotOnRemote': return t('reason.tagCommitNotOnRemote', { remotes: reason.remotes.join(', ') });
	}
}
