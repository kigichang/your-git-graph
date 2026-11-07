<script lang="ts">
	// The branch dropdown: Show All, or any number of branches ticked; a box to narrow the list.
	let { branches, selected, onChange }: {
		branches: string[]; selected: string[] | null; onChange: (selected: string[] | null) => void;
	} = $props();

	let open = $state(false);
	let filter = $state('');
	/** The names as the engine has them (`remotes/origin/x`), shown as the graph labels them
	 * (`origin/x`); a remote's HEAD is a pointer to another branch, not one to pick. */
	const shownName = (b: string) => b.replace(/^remotes\//, '');
	const listed = $derived(branches.filter((b) => !/^remotes\/[^/]+\/HEAD$/.test(b)));
	const shown = $derived(filter === '' ? listed : listed.filter((b) => shownName(b).toLowerCase().includes(filter.toLowerCase())));
	const label = $derived(selected === null ? 'Show All' : selected.length === 1 ? shownName(selected[0] as string) : selected.length + ' branches');

	function toggle(branch: string) {
		const now = selected ?? [];
		const next = now.includes(branch) ? now.filter((b) => b !== branch) : [...now, branch];
		onChange(next.length === 0 ? null : next);
	}

	function onWindowClick(e: MouseEvent) {
		if (open && !(e.target as Element).closest('.gg-branch-filter')) open = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => { if (e.key === 'Escape' && open) { open = false; e.stopPropagation(); } }} />

<div class="gg-branch-filter">
	<button class="gg-current" onclick={() => { open = !open; }} title="Branches">{label} ▾</button>
	{#if open}
		<div class="gg-menu">
			<input class="gg-filter" placeholder="Filter branches" bind:value={filter} />
			<label class="gg-item"><input type="checkbox" checked={selected === null} onchange={() => onChange(null)} /> Show All</label>
			{#each shown as branch (branch)}
				<label class="gg-item" class:gg-remote={branch.startsWith('remotes/')}><input type="checkbox" checked={selected?.includes(branch) ?? false} onchange={() => toggle(branch)} /> {shownName(branch)}</label>
			{/each}
		</div>
	{/if}
</div>

<style>
	.gg-branch-filter { position: relative; }
	.gg-current {
		font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		border: 1px solid var(--gg-dropdown-border); background: var(--gg-dropdown-background); color: var(--gg-dropdown-foreground);
	}
	.gg-menu {
		position: absolute; top: calc(100% + 4px); left: 0; z-index: 50; min-width: 240px; max-height: 60vh; overflow: auto;
		display: flex; flex-direction: column; padding: 6px; border-radius: 8px;
		background: var(--gg-dropdown-background); border: 1px solid var(--gg-dropdown-border); box-shadow: 0 8px 30px var(--gg-widget-shadow);
	}
	.gg-filter {
		font: inherit; margin: 0 0 6px; padding: 4px 8px; border-radius: 5px; outline: none;
		background: var(--gg-input-background); color: var(--gg-input-foreground); border: 1px solid var(--gg-input-border);
	}
	.gg-filter:focus { border-color: var(--gg-focusBorder); }
	.gg-item { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; white-space: nowrap; cursor: pointer; }
	.gg-item:hover { background: var(--gg-list-hoverBackground); }
	.gg-remote { color: var(--gg-descriptionForeground); }
</style>
