<script lang="ts">
	// Find among the loaded commits (⌘F): the text, case and regex switches, the count, and
	// Enter / ⇧Enter to step through the matches; Esc closes.
	import { onMount } from 'svelte';
	import { t } from '../i18n';

	let { query, caseSensitive, regex, count, index, onChange, onStep, onClose }: {
		query: string; caseSensitive: boolean; regex: boolean; count: number; index: number;
		onChange: (next: { query: string; caseSensitive: boolean; regex: boolean }) => void;
		onStep: (forward: boolean) => void;
		onClose: () => void;
	} = $props();

	let input: HTMLInputElement | undefined = $state();
	onMount(() => { input?.focus(); input?.select(); });
	export const focus = () => { input?.focus(); input?.select(); };

	function onKey(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Escape') { e.preventDefault(); onClose(); }
		else if (e.key === 'Enter') { e.preventDefault(); onStep(!e.shiftKey); }
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="gg-find" role="search" onkeydown={onKey}>
	<input bind:this={input} type="text" value={query} placeholder={t('find.placeholder')} oninput={(e) => onChange({ query: (e.target as HTMLInputElement).value, caseSensitive, regex })} />
	<button class="gg-toggle" class:on={caseSensitive} title={t('find.caseTitle')} onclick={() => onChange({ query, caseSensitive: !caseSensitive, regex })}>{t('find.case')}</button>
	<button class="gg-toggle" class:on={regex} title={t('find.regexTitle')} onclick={() => onChange({ query, caseSensitive, regex: !regex })}>{t('find.regex')}</button>
	<span class="gg-count" class:none={query !== '' && count === 0}>{query === '' ? '' : count === 0 ? t('find.none') : t('find.count', { index: index + 1, count })}</span>
	<button class="gg-step" title={t('find.prev')} disabled={count === 0} onclick={() => onStep(false)}>↑</button>
	<button class="gg-step" title={t('find.next')} disabled={count === 0} onclick={() => onStep(true)}>↓</button>
	<button class="gg-step" title={t('find.close')} onclick={onClose}>✕</button>
</div>

<style>
	.gg-find {
		position: absolute; top: 6px; right: 24px; z-index: 40; display: flex; align-items: center; gap: 4px; padding: 5px 8px; border-radius: 8px;
		background: var(--gg-editorWidget-background); border: 1px solid var(--gg-editorWidget-border); box-shadow: 0 6px 20px var(--gg-widget-shadow);
	}
	input {
		font: inherit; width: 220px; padding: 3px 8px; border-radius: 5px; outline: none;
		background: var(--gg-input-background); color: var(--gg-input-foreground); border: 1px solid var(--gg-input-border);
	}
	input:focus { border-color: var(--gg-focusBorder); }
	button { font: inherit; padding: 2px 7px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; background: none; color: var(--gg-foreground); }
	button:hover:not(:disabled) { background: var(--gg-list-hoverBackground); }
	button:disabled { opacity: 0.5; cursor: default; }
	.gg-toggle { font-family: var(--gg-editor-font-family); font-size: 11px; }
	.gg-toggle.on { background: var(--gg-inputOption-activeBackground); border-color: var(--gg-inputOption-activeBorder); }
	.gg-count { min-width: 90px; text-align: center; font-size: 12px; color: var(--gg-descriptionForeground); }
	.gg-count.none { color: var(--gg-errorForeground); }
</style>
