<script lang="ts">
	// The files of a commit, as a flat list or a tree of folders: an icon, the name in the colour
	// of its status, the lines added and removed. A click opens the change (a diff window);
	// ⌘-click the file as the change leaves it.
	import { buildTree, flatFiles, folderPaths, lineCounts, type TreeNode } from '../filetree';
	import type { FileChange } from '../api/client';

	let { files, view = 'list', compact = true, onOpen, onMenu }: {
		files: FileChange[]; view?: 'tree' | 'list'; compact?: boolean;
		onOpen: (change: FileChange, fileOnly: boolean) => void;
		onMenu?: (e: MouseEvent, change: FileChange) => void;
	} = $props();

	const tree = $derived(buildTree(files, compact));
	let folded = $state(new Set<string>());
	$effect(() => { void folderPaths(tree); folded = new Set(); }); // a new list: everything open

	const toggle = (path: string) => { const next = new Set(folded); if (next.has(path)) next.delete(path); else next.add(path); folded = next; };
	const open = (e: MouseEvent, change: FileChange) => { e.preventDefault(); onOpen(change, e.metaKey); };
	const title = (c: FileChange) => (c.status === 'R' ? c.oldPath + ' → ' + c.newPath : c.newPath);
</script>

{#snippet file(change: FileChange, name: string, depth: number)}
	{@const counts = lineCounts(change)}
	<button class="gg-file" style:padding-left="{8 + depth * 14}px" title={title(change)} aria-label="{change.status} {name}{counts ? ` +${counts.added} -${counts.removed}` : ''}" onclick={(e) => open(e, change)}
		oncontextmenu={(e) => { if (onMenu) { e.preventDefault(); onMenu(e, change); } }}>
		<svg class="gg-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M3 1h6.5L13 4.5V15H3V1Zm2 6v1h6V7H5Zm0 2.5v1h6v-1H5ZM5 12v1h4v-1H5Z" /></svg>
		<span class="gg-name gg-status-{change.status}">{name}</span>
		{#if counts}<span class="gg-counts">( <span class="gg-added">+{counts.added}</span> | <span class="gg-removed">-{counts.removed}</span> )</span>{/if}
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
		{#each flatFiles(files) as change (change.newPath)}{@render file(change, change.newPath, 0)}{/each}
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
	.gg-icon { flex: none; width: 14px; height: 14px; fill: var(--gg-descriptionForeground); }
	.gg-status-A, .gg-status-U { color: var(--gg-gitDecoration-addedResourceForeground); }
	.gg-status-M { color: var(--gg-gitDecoration-modifiedResourceForeground); }
	.gg-status-D { color: var(--gg-gitDecoration-deletedResourceForeground); }
	.gg-status-R { color: var(--gg-gitDecoration-renamedResourceForeground); }
	.gg-counts { flex: none; padding-left: 4px; }
	.gg-added { color: var(--gg-gitDecoration-addedResourceForeground); }
	.gg-removed { color: var(--gg-gitDecoration-deletedResourceForeground); }
</style>
