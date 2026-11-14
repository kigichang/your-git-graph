<script lang="ts">
	// The repository's worktrees: the list, adding one (a dialog), removing one, pruning.
	import { worktrees as readWorktrees, log, type Worktree } from '../api/client';
	import { errorText } from '../errors';
	import { t } from '../i18n';
	import { shortHash } from '../names';

	let { repo, onAdd, onRemove, onPrune, onOpen, onClose, version = 0 }: {
		repo: string; onAdd: () => void; onRemove: (w: Worktree) => void; onPrune: () => void; onOpen: (path: string) => void; onClose: () => void;
		/** Bumped by the window after an operation: load again. */
		version?: number;
	} = $props();

	let worktrees = $state.raw<Worktree[]>([]);
	let error = $state('');

	async function load() {
		try {
			worktrees = await readWorktrees(repo);
			error = '';
		} catch (e) {
			error = errorText(e);
			void log('worktrees: ' + error);
		}
	}
	$effect(() => { void repo; void version; void load(); });
</script>

<section class="gg-panel" aria-label={t('worktree.title')}>
	<div class="gg-panel-head">
		<h2>{t('worktree.title')}</h2>
		<button onclick={onAdd}>{t('worktree.add')}</button>
		<button onclick={onPrune}>{t('worktree.prune')}</button>
		<span class="gg-spacer"></span>
		<button class="gg-close" title={t('details.close')} onclick={onClose}>✕</button>
	</div>
	{#if error}<p class="gg-error">{error}</p>
	{:else if worktrees.length === 0}<p class="gg-muted">{t('worktree.empty')}</p>
	{:else}
		<div class="gg-rows">
			{#each worktrees as w (w.path)}
				<div class="gg-row">
					<span class="gg-path" title={w.path}>{w.path}</span>
					<span class="gg-branch">{w.branch ?? shortHash(w.hash)}</span>
					<span class="gg-tags">
						{#if w.isMain}<span class="gg-tag">{t('worktree.main')}</span>{/if}
						{#if w.detached}<span class="gg-tag">{t('worktree.detached')}</span>{/if}
						{#if w.locked}<span class="gg-tag">{t('worktree.locked')}</span>{/if}
						{#if w.prunable}<span class="gg-tag">{t('worktree.prunable')}</span>{/if}
					</span>
					{#if !w.isMain}
						<button onclick={() => onOpen(w.path)}>{t('worktree.open')}</button>
						<button class="gg-danger" onclick={() => onRemove(w)}>{t('worktree.remove')}</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.gg-panel { flex: none; display: flex; flex-direction: column; max-height: 45%; min-height: 120px; border-top: 1px solid var(--gg-panel-border); background: var(--gg-editor-background); }
	.gg-panel-head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--gg-panel-border); }
	h2 { margin: 0 8px 0 0; font-size: 13px; font-weight: 600; }
	.gg-spacer { flex: 1; }
	button { font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer; border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground); }
	.gg-close { border: none; background: none; color: var(--gg-descriptionForeground); }
	.gg-danger { color: var(--gg-errorForeground); }
	.gg-rows { overflow: auto; display: flex; flex-direction: column; padding: 4px 0; }
	.gg-row { display: flex; gap: 12px; align-items: center; padding: 4px 14px; white-space: nowrap; }
	.gg-row:hover { background: var(--gg-list-hoverBackground); }
	.gg-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--gg-editor-font-family); font-size: 12px; }
	.gg-branch { color: var(--gg-charts-green); }
	.gg-tags { display: flex; gap: 4px; }
	.gg-tag { font-size: 11px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--gg-panel-border); color: var(--gg-descriptionForeground); }
	.gg-muted, .gg-error { margin: 0; padding: 10px 14px; }
	.gg-muted { color: var(--gg-descriptionForeground); }
	.gg-error { color: var(--gg-errorForeground); }
</style>
