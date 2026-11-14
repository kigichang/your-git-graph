<script lang="ts">
	// A dropdown of things to tick: all of them (the empty choice), or any number; a box to
	// narrow the list. The branch filter and the author filter.
	let { kind, items, selected, allLabel, placeholder, severalLabel, display = (i: string) => i, muted = () => false, onChange }: {
		/** Which filter it is (its class: gg-branch-filter, gg-author-filter). */
		kind: 'branch' | 'author';
		items: string[]; selected: string[] | null; allLabel: string; placeholder: string;
		/** The button's text when several are ticked, with `{count}`. */
		severalLabel: (count: number) => string;
		display?: (item: string) => string;
		muted?: (item: string) => boolean;
		onChange: (selected: string[] | null) => void;
	} = $props();

	let open = $state(false);
	let button: HTMLButtonElement;
	/** Where the list opens: under the button, fixed to the window (the toolbar clips what overflows it). */
	let at = $state({ left: 0, top: 0 });

	function toggleOpen() {
		if (!open) {
			const r = button.getBoundingClientRect();
			at = { left: r.left, top: r.bottom + 4 };
		}
		open = !open;
	}
	let filter = $state('');
	const shown = $derived(filter === '' ? items : items.filter((b) => display(b).toLowerCase().includes(filter.toLowerCase())));
	const label = $derived(selected === null ? allLabel : selected.length === 1 ? display(selected[0] as string) : severalLabel(selected.length));

	function toggle(item: string) {
		const now = selected ?? [];
		const next = now.includes(item) ? now.filter((b) => b !== item) : [...now, item];
		onChange(next.length === 0 ? null : next);
	}

	function onWindowClick(e: MouseEvent) {
		if (open && !(e.target as Element).closest('.gg-multi-filter')) open = false;
	}
</script>

<svelte:window onclick={onWindowClick} onresize={() => { open = false; }} onkeydown={(e) => { if (e.key === 'Escape' && open) { open = false; e.stopPropagation(); } }} />

<div class="gg-multi-filter gg-{kind}-filter">
	<button class="gg-current" bind:this={button} onclick={toggleOpen}>{label} ▾</button>
	{#if open}
		<div class="gg-menu" style:left="{at.left}px" style:top="{at.top}px">
			<input class="gg-filter" {placeholder} bind:value={filter} />
			<label class="gg-item"><input type="checkbox" checked={selected === null} onchange={() => onChange(null)} /> {allLabel}</label>
			{#each shown as item (item)}
				<label class="gg-item" class:gg-muted={muted(item)}><input type="checkbox" checked={selected?.includes(item) ?? false} onchange={() => toggle(item)} /> {display(item)}</label>
			{/each}
		</div>
	{/if}
</div>

<style>
	.gg-multi-filter { position: relative; }
	.gg-current {
		font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		border: 1px solid var(--gg-dropdown-border); background: var(--gg-dropdown-background); color: var(--gg-dropdown-foreground);
	}
	.gg-menu {
		position: fixed; z-index: 50; min-width: 240px; max-height: 60vh; overflow: auto;
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
	.gg-muted { color: var(--gg-descriptionForeground); }
</style>
