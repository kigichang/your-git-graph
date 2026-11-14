<script lang="ts">
	// The bar above the graph: the repository, the branch and author filters, remote branches
	// on or off, first parent only, and the buttons: fetch, refresh, find, reflog, worktrees,
	// settings; a status line.
	import MultiFilter from './MultiFilter.svelte';
	import { t } from '../i18n';
	import { baseName } from '../names';

	let { repo, branches, selected, authors, selectedAuthors, showRemoteBranches, firstParentOnly, status, sidebarCollapsed = false,
		onBranches, onAuthors, onShowRemoteBranches, onFirstParent, onRefresh, onFetch, onFind, onReflog, onWorktrees, onSettings, onExpandSidebar }: {
		repo: string; branches: string[]; selected: string[] | null; authors: string[]; selectedAuthors: string[] | null;
		showRemoteBranches: boolean; firstParentOnly: boolean; status: string; sidebarCollapsed?: boolean;
		onBranches: (selected: string[] | null) => void; onAuthors: (selected: string[] | null) => void;
		onShowRemoteBranches: (on: boolean) => void; onFirstParent: (on: boolean) => void;
		onRefresh: () => void; onFetch: () => void; onFind: () => void; onReflog: () => void; onWorktrees: () => void; onSettings: () => void; onExpandSidebar?: () => void;
	} = $props();

	const name = $derived(baseName(repo));
	/** The names as the engine has them (`remotes/origin/x`), shown as the graph labels them
	 * (`origin/x`); a remote's HEAD is a pointer to another branch, not one to pick. */
	const shownBranch = (b: string) => b.replace(/^remotes\//, '');
	const listedBranches = $derived(branches.filter((b) => !/^remotes\/[^/]+\/HEAD$/.test(b)));
</script>

<div class="gg-toolbar">
	{#if sidebarCollapsed}<button class="gg-button gg-expand" onclick={onExpandSidebar} title={t('sidebar.expand')}>☰</button>{/if}
	<span class="gg-repo" title={repo}>{name}</span>
	<MultiFilter kind="branch" items={listedBranches} {selected} allLabel={t('toolbar.showAll')} placeholder={t('toolbar.filterBranches')} severalLabel={(n) => t('toolbar.branches', { count: n })}
		display={shownBranch} muted={(b) => b.startsWith('remotes/')} onChange={onBranches} />
	<MultiFilter kind="author" items={authors} selected={selectedAuthors} allLabel={t('toolbar.allAuthors')} placeholder={t('toolbar.filterAuthors')} severalLabel={(n) => t('toolbar.authors', { count: n })} onChange={onAuthors} />
	<label class="gg-check" title={t('toolbar.remoteBranches')}><input type="checkbox" checked={showRemoteBranches} onchange={(e) => onShowRemoteBranches((e.target as HTMLInputElement).checked)} /> {t('toolbar.remoteBranches')}</label>
	<label class="gg-check" title={t('toolbar.firstParent')}><input type="checkbox" checked={firstParentOnly} onchange={(e) => onFirstParent((e.target as HTMLInputElement).checked)} /> {t('toolbar.firstParent')}</label>
	<button class="gg-button" onclick={onFetch} title="⌘⇧F">{t('toolbar.fetch')}</button>
	<button class="gg-button" onclick={onRefresh} title="⌘R">{t('toolbar.refresh')}</button>
	<button class="gg-button" onclick={onFind} title="⌘F">{t('toolbar.find')}</button>
	<button class="gg-button" onclick={onReflog}>{t('toolbar.reflog')}</button>
	<button class="gg-button" onclick={onWorktrees}>{t('toolbar.worktrees')}</button>
	<button class="gg-button" onclick={onSettings} title="⌘,">{t('toolbar.settings')}</button>
	<span class="gg-status" title={status}>{status}</span>
</div>

<style>
	.gg-toolbar {
		flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
		border-bottom: 1px solid var(--gg-panel-border); background: var(--gg-editorWidget-background); white-space: nowrap; overflow: hidden;
	}
	.gg-repo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; max-width: 200px; flex: none; }
	.gg-check { display: flex; align-items: center; gap: 4px; flex: none; }
	.gg-button {
		font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer; flex: none;
		border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground);
	}
	.gg-status { margin-left: auto; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--gg-descriptionForeground); min-width: 0; }
</style>
