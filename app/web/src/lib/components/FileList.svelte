<script lang="ts">
	// The files of a commit, as a tree of folders or a flat list. A click opens the change
	// (a diff window); ⌘-click the file as the change leaves it.
	import { buildTree, folderPaths, countsText, type TreeNode } from '../filetree';
	import type { FileChange } from '../api/client';

	let { files, view = 'tree', compact = true, onOpen }: {
		files: FileChange[]; view?: 'tree' | 'list'; compact?: boolean;
		onOpen: (change: FileChange, fileOnly: boolean) => void;
	} = $props();

	const tree = $derived(buildTree(files, compact));
	let folded = $state(new Set<string>());
	$effect(() => { void folderPaths(tree); folded = new Set(); }); // a new list: everything open

	const toggle = (path: string) => { const next = new Set(folded); if (next.has(path)) next.delete(path); else next.add(path); folded = next; };
	const open = (e: MouseEvent, change: FileChange) => { e.preventDefault(); onOpen(change, e.metaKey); };
	const title = (c: FileChange) => (c.status === 'R' ? c.oldPath + ' → ' + c.newPath : c.newPath);
</script>

{#snippet file(change: FileChange, name: string, depth: number)}
	<button class="gg-file" style:padding-left="{8 + depth * 14}px" title={title(change)} onclick={(e) => open(e, change)}>
		<span class="gg-status gg-status-{change.status}">{change.status}</span>
		<span class="gg-name">{name}</span>
		<span class="gg-counts">{countsText(change)}</span>
	</button>
{/snippet}

{#snippet nodes(list: TreeNode[], depth: number)}
	{#each list as node (node.path)}
		{#if node.kind === 'folder'}
			<button class="gg-folder" class:folded={folded.has(node.path)} style:padding-left="{8 + depth * 14}px" onclick={() => toggle(node.path)}>
				<span class="gg-twisty"></span><span class="gg-name">{node.name}</span>
			</button>
			{#if !folded.has(node.path)}{@render nodes(node.children, depth + 1)}{/if}
		{:else}
			{@render file(node.change, node.name, depth)}
		{/if}
	{/each}
{/snippet}

<div class="gg-files" role="tree">
	{#if view === 'tree'}
		{@render nodes(tree, 0)}
	{:else}
		{#each files as change (change.newPath)}{@render file(change, change.newPath, 0)}{/each}
	{/if}
</div>

<style>
	.gg-files { display: flex; flex-direction: column; min-width: 0; }
	.gg-file, .gg-folder {
		display: flex; align-items: center; gap: 6px; height: 22px; padding-right: 8px;
		font: inherit; color: inherit; background: none; border: none; text-align: left; cursor: pointer; white-space: nowrap;
	}
	.gg-file:hover, .gg-folder:hover { background: var(--gg-list-hoverBackground); }
	.gg-name { overflow: hidden; text-overflow: ellipsis; }
	.gg-twisty { width: 10px; flex: none; }
	.gg-twisty::before { content: '▾'; font-size: 10px; color: var(--gg-descriptionForeground); }
	.gg-folder.folded .gg-twisty::before { content: '▸'; }
	.gg-status { flex: none; width: 1ch; font-family: var(--gg-editor-font-family); font-weight: 600; font-size: 12px; }
	.gg-status-A, .gg-status-U { color: var(--gg-gitDecoration-addedResourceForeground); }
	.gg-status-M { color: var(--gg-gitDecoration-modifiedResourceForeground); }
	.gg-status-D { color: var(--gg-gitDecoration-deletedResourceForeground); }
	.gg-status-R { color: var(--gg-gitDecoration-renamedResourceForeground); }
	.gg-counts { margin-left: auto; padding-left: 12px; font-size: 11px; color: var(--gg-descriptionForeground); font-family: var(--gg-editor-font-family); }
</style>
