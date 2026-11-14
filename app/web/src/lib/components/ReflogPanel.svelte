<script lang="ts">
	// The reflog of a reference (HEAD by default): its entries, loaded 50 at a time; a click
	// selects the commit in the graph when it is loaded.
	import { reflog as readReflog, log, type ReflogEntry } from '../api/client';
	import { formatDate } from '../dates';
	import { errorText } from '../errors';
	import { t } from '../i18n';

	let { repo, references, onShow, onClose }: { repo: string; references: string[]; onShow: (hash: string) => boolean; onClose: () => void } = $props();

	let reference = $state('HEAD');
	let entries = $state.raw<ReflogEntry[]>([]);
	let more = $state(false);
	let limit = $state(50);
	let error = $state('');
	let note = $state('');

	async function load() {
		try {
			const answer = await readReflog(repo, reference, limit);
			entries = answer.entries;
			more = answer.more;
			error = '';
		} catch (e) {
			error = errorText(e);
			entries = [];
			void log('reflog: ' + error);
		}
	}
	$effect(() => { void reference; void limit; void load(); });

	function show(entry: ReflogEntry) {
		note = onShow(entry.hash) ? '' : t('reflog.notLoaded');
	}
</script>

<section class="gg-panel" aria-label={t('reflog.title')}>
	<div class="gg-panel-head">
		<h2>{t('reflog.title')}</h2>
		<label class="gg-ref">{t('reflog.ref')}
			<select bind:value={reference}>
				<option value="HEAD">HEAD</option>
				{#each references as r (r)}<option value={r}>{r}</option>{/each}
			</select>
		</label>
		<span class="gg-note">{note}</span>
		<button class="gg-close" title={t('details.close')} onclick={onClose}>✕</button>
	</div>
	{#if error}<p class="gg-error">{error}</p>
	{:else if entries.length === 0}<p class="gg-muted">{t('reflog.empty')}</p>
	{:else}
		<div class="gg-rows">
			{#each entries as entry (entry.selector)}
				<button class="gg-row" class:dangling={entry.dangling} onclick={() => show(entry)} title={entry.hash}>
					<span class="gg-sel">{entry.selector}</span>
					<span class="gg-hash">{entry.abbrev}</span>
					<span class="gg-date">{formatDate(entry.date)}</span>
					<span class="gg-msg">{entry.message}</span>
					{#if entry.dangling}<span class="gg-tag">{t('reflog.dangling')}</span>{/if}
				</button>
			{/each}
		</div>
		{#if more}<div class="gg-foot"><button onclick={() => { limit += 100; }}>{t('reflog.loadMore')}</button></div>{/if}
	{/if}
</section>

<style>
	.gg-panel { flex: none; display: flex; flex-direction: column; max-height: 45%; min-height: 160px; border-top: 1px solid var(--gg-panel-border); background: var(--gg-editor-background); }
	.gg-panel-head { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--gg-panel-border); }
	h2 { margin: 0; font-size: 13px; font-weight: 600; }
	.gg-ref { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--gg-descriptionForeground); }
	select { font: inherit; padding: 2px 6px; border-radius: 5px; background: var(--gg-dropdown-background); color: var(--gg-dropdown-foreground); border: 1px solid var(--gg-dropdown-border); }
	.gg-note { flex: 1; font-size: 12px; color: var(--gg-descriptionForeground); }
	.gg-close { font: inherit; border: none; background: none; color: var(--gg-descriptionForeground); cursor: pointer; }
	.gg-rows { overflow: auto; display: flex; flex-direction: column; padding: 4px 0; }
	.gg-row { display: flex; gap: 12px; align-items: baseline; padding: 3px 14px; font: inherit; color: inherit; text-align: left; background: none; border: none; cursor: pointer; white-space: nowrap; }
	.gg-row:hover { background: var(--gg-list-hoverBackground); }
	.gg-row.dangling { color: var(--gg-descriptionForeground); }
	.gg-sel, .gg-hash { font-family: var(--gg-editor-font-family); font-size: 12px; }
	.gg-sel { width: 90px; flex: none; }
	.gg-date { color: var(--gg-descriptionForeground); font-size: 12px; flex: none; }
	.gg-msg { overflow: hidden; text-overflow: ellipsis; }
	.gg-tag { font-size: 11px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--gg-panel-border); }
	.gg-foot { padding: 6px 14px; }
	.gg-foot button { font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer; border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground); }
	.gg-muted, .gg-error { margin: 0; padding: 10px 14px; }
	.gg-muted { color: var(--gg-descriptionForeground); }
	.gg-error { color: var(--gg-errorForeground); }
</style>
