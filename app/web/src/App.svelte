<script lang="ts">
	// Stage 2 scaffold: the window shows the folders it was asked to open. The graph, the
	// sidebar and everything else arrive with the milestones of docs/spec/.
	import { invoke } from '@tauri-apps/api/core';

	let folders = $state<string[]>([]);
	invoke<string[]>('initial_repo').then((list) => { folders = list; }, () => {});
</script>

<main>
	<h1>Your Git Graph</h1>
	{#if folders.length === 0}
		<p class="muted">No repository open.</p>
	{:else}
		<ul>
			{#each folders as folder (folder)}<li>{folder}</li>{/each}
		</ul>
	{/if}
</main>

<style>
	main {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		height: 100vh; gap: 12px;
	}
	h1 { font-size: 18px; font-weight: 600; margin: 0; }
	.muted { color: var(--gg-descriptionForeground); }
	ul { list-style: none; margin: 0; padding: 0; font-family: var(--gg-editor-font-family); font-size: 12px; }
</style>
