<script lang="ts">
	// Below the graph: the operation git left in progress (a merge, a rebase, …), its
	// conflicting files, and the way to continue or abort it.
	import type { OperationKind } from '../api/client';
	import { t } from '../i18n';

	let { operation, progress, conflicted, onContinue, onAbort }: {
		operation: OperationKind; progress: { step: number; total: number } | null; conflicted: string[];
		onContinue: () => void; onAbort: () => void;
	} = $props();

	const names = { merge: 'status.merge', rebase: 'status.rebase', 'cherry-pick': 'status.cherryPick', revert: 'status.revert' } as const;
</script>

<div class="gg-statusbar" role="status">
	<span class="gg-what">{t('status.inProgress', { operation: t(names[operation]) })}{#if progress} ({progress.step}/{progress.total}){/if}</span>
	{#if conflicted.length > 0}<span class="gg-conflicts" title={conflicted.join('\n')}>{t('status.conflicts', { count: conflicted.length })}</span>{/if}
	<span class="gg-spacer"></span>
	<button onclick={onContinue}>{t('status.continue')}</button>
	<button class="gg-abort" onclick={onAbort}>{t('status.abort')}</button>
</div>

<style>
	.gg-statusbar {
		flex: none; display: flex; align-items: center; gap: 12px; padding: 5px 10px;
		border-top: 1px solid var(--gg-panel-border); background: var(--gg-inputValidation-warningBackground); color: var(--gg-inputValidation-warningForeground);
	}
	.gg-what { font-weight: 600; }
	.gg-conflicts { color: var(--gg-errorForeground); }
	.gg-spacer { flex: 1; }
	button {
		font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer;
		border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground);
	}
	.gg-abort { color: var(--gg-errorForeground); }
</style>
