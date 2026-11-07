<script lang="ts">
	// The bar above the graph: the repository, the branch filter, remote branches on or off,
	// refresh, and a status line.
	import BranchFilter from './BranchFilter.svelte';

	let { repo, branches, selected, showRemoteBranches, status, sidebarCollapsed = false, onBranches, onShowRemoteBranches, onRefresh, onFetch, onExpandSidebar }: {
		repo: string; branches: string[]; selected: string[] | null; showRemoteBranches: boolean; status: string; sidebarCollapsed?: boolean;
		onBranches: (selected: string[] | null) => void; onShowRemoteBranches: (on: boolean) => void; onRefresh: () => void; onFetch: () => void; onExpandSidebar?: () => void;
	} = $props();

	const name = $derived(repo.replace(/\/+$/, '').split('/').pop() ?? repo);
</script>

<div class="gg-toolbar">
	{#if sidebarCollapsed}<button class="gg-button gg-expand" onclick={onExpandSidebar} title="Show Sidebar (⌃⌘S)">☰</button>{/if}
	<span class="gg-repo" title={repo}>{name}</span>
	<BranchFilter {branches} {selected} onChange={onBranches} />
	<label class="gg-check"><input type="checkbox" checked={showRemoteBranches} onchange={(e) => onShowRemoteBranches((e.target as HTMLInputElement).checked)} /> Remote branches</label>
	<button class="gg-button" onclick={onFetch} title="Fetch from Remotes (⌘⇧F)">Fetch</button>
	<button class="gg-button" onclick={onRefresh} title="Refresh (⌘R)">Refresh</button>
	<span class="gg-status" title={status}>{status}</span>
</div>

<style>
	.gg-toolbar {
		flex: none; display: flex; align-items: center; gap: 10px; padding: 6px 10px;
		border-bottom: 1px solid var(--gg-panel-border); background: var(--gg-editorWidget-background); white-space: nowrap;
	}
	.gg-repo { font-weight: 600; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
	.gg-check { display: flex; align-items: center; gap: 4px; }
	.gg-button {
		font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer;
		border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground);
	}
	.gg-status { margin-left: auto; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--gg-descriptionForeground); }
</style>
