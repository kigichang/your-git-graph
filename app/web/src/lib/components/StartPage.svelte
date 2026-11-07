<script lang="ts">
	// What a window shows with no repository: the ways to open one, and the recent ones.
	import { t } from '../i18n';
	import { baseName } from '../sidebar';

	let { recent, error = '', onOpen, onAddLocal, onAddRemote, onConnectServer }: {
		recent: string[]; error?: string; onOpen: (repo: string) => void; onAddLocal: () => void; onAddRemote: () => void; onConnectServer: () => void;
	} = $props();
</script>

<div class="gg-start">
	<h1>Your Git Graph</h1>
	{#if error}<p class="gg-error">{error}</p>{/if}
	<div class="gg-actions">
		<button class="gg-ok" onclick={onAddLocal}>{t('start.open')}</button>
		<button onclick={onAddRemote}>{t('sidebar.addRemote')}</button>
		<button onclick={onConnectServer}>{t('sidebar.addServer')}</button>
	</div>
	{#if recent.length > 0}
		<div class="gg-recent">
			<h3>{t('start.recent')}</h3>
			<ul>
				{#each recent as repo (repo)}
					<li><button class="gg-item" onclick={() => onOpen(repo)}><span class="gg-name">{baseName(repo)}</span><span class="gg-where">{repo}</span></button></li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	.gg-start { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 14px; padding: 24px; }
	h1 { font-size: 18px; font-weight: 600; margin: 0; }
	.gg-error { margin: 0; color: var(--gg-errorForeground); max-width: 80vw; white-space: pre-wrap; text-align: center; }
	.gg-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
	button {
		font: inherit; padding: 5px 14px; border-radius: 6px; cursor: pointer;
		border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground);
	}
	.gg-ok { background: var(--gg-button-background); color: var(--gg-button-foreground); border-color: transparent; }
	.gg-recent { width: min(520px, calc(100vw - 32px)); }
	h3 { font-size: 12px; font-weight: 600; color: var(--gg-descriptionForeground); margin: 16px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; }
	ul { list-style: none; margin: 0; padding: 0; }
	.gg-item { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; padding: 6px 10px; border: none; background: none; }
	.gg-item:hover { background: var(--gg-list-hoverBackground); }
	.gg-where { font-size: 11px; color: var(--gg-descriptionForeground); }
</style>
