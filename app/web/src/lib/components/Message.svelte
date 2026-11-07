<script lang="ts">
	// A commit message with its light markup (`commits.markdown`, lib/marks.ts): text nodes and
	// <code>/<strong>/<em> only, never HTML from the message.
	import { marks } from '../marks';

	let { text, markdown = true }: { text: string; markdown?: boolean } = $props();
	const spans = $derived(marks(text, markdown));
</script>

{#each spans as span, i (i)}{#if span.mark === 'code'}<code class="gg-code">{span.text}</code>{:else if span.mark === 'strong'}<strong>{span.text}</strong>{:else if span.mark === 'em'}<em>{span.text}</em>{:else}{span.text}{/if}{/each}

<style>
	.gg-code { font-family: var(--gg-editor-font-family); font-size: 0.92em; padding: 0 3px; border-radius: 3px; background: var(--gg-textCodeBlock-background); }
</style>
