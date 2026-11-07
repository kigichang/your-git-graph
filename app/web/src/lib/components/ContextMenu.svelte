<script lang="ts">
	// A menu at the pointer: items the window acts on by id. Closes on a choice, a click
	// elsewhere, or Esc; stays inside the window.
	import type { MenuItem, MenuAction } from '../menus';

	let { items, x, y, onPick, onClose }: { items: MenuItem[]; x: number; y: number; onPick: (id: MenuAction) => void; onClose: () => void } = $props();

	let menu: HTMLDivElement | undefined = $state();
	let left = $state(0), top = $state(0);

	$effect(() => {
		if (!menu) return;
		const { width, height } = menu.getBoundingClientRect();
		left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
		top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
	});

	function onWindowPointer(e: PointerEvent) {
		if (menu && !menu.contains(e.target as Node)) onClose();
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') { onClose(); e.stopPropagation(); }
	}
</script>

<svelte:window onpointerdown={onWindowPointer} onkeydown={onKey} onblur={onClose} />

<div class="gg-menu" bind:this={menu} style:left="{left}px" style:top="{top}px" role="menu">
	{#each items as entry, i (i)}
		{#if 'separator' in entry}
			<div class="gg-sep"></div>
		{:else}
			<button class="gg-item" class:danger={entry.danger} disabled={entry.disabled} role="menuitem" onclick={() => { if (!entry.disabled) onPick(entry.id); }}>{entry.label}</button>
		{/if}
	{/each}
</div>

<style>
	.gg-menu {
		position: fixed; z-index: 1000; min-width: 200px; padding: 4px; border-radius: 8px;
		background: var(--gg-menu-background); color: var(--gg-menu-foreground);
		border: 1px solid var(--gg-menu-border); box-shadow: 0 8px 30px var(--gg-widget-shadow);
		display: flex; flex-direction: column;
	}
	.gg-item {
		font: inherit; text-align: left; padding: 4px 24px 4px 12px; border-radius: 5px; border: 1px solid transparent;
		background: none; color: inherit; cursor: pointer; white-space: nowrap;
	}
	.gg-item:hover:not(:disabled) { background: var(--gg-menu-selectionBackground); color: var(--gg-menu-selectionForeground); border-color: var(--gg-menu-selectionBorder); }
	.gg-item:disabled { color: var(--gg-descriptionForeground); cursor: default; opacity: 0.6; }
	.gg-item.danger:not(:disabled) { color: var(--gg-errorForeground); }
	.gg-item.danger:hover:not(:disabled) { color: var(--gg-menu-selectionForeground); }
	.gg-sep { height: 1px; margin: 4px 8px; background: var(--gg-menu-separatorBackground); }
</style>
