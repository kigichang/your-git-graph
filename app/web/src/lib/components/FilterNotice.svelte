<script lang="ts">
	// Below the graph: the uncommitted changes were not read, because this repository's own
	// configuration runs a program on its files when they are (Rust: gg_backend::filters). The
	// person may allow it for this repository until the app quits.
	import { t } from '../i18n';

	let { names, onAllow }: { names: string[]; onAllow: () => void } = $props();
</script>

<div class="gg-filter-notice" role="status">
	<span class="gg-filter-why" title={names.join('\n')}>{t('filters.notice', { names: names.join(', ') })}</span>
	<button onclick={onAllow}>{t('filters.allow')}</button>
</div>

<style>
	.gg-filter-notice {
		flex: none; display: flex; align-items: center; gap: 12px; padding: 5px 10px;
		border-top: 1px solid var(--gg-panel-border); background: var(--gg-inputValidation-warningBackground); color: var(--gg-inputValidation-warningForeground);
	}
	.gg-filter-why { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	button {
		flex: none; font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer;
		border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground);
	}
</style>
