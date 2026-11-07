<script lang="ts">
	// What an operation shows while and after it runs (lib/ops.svelte.ts): the question it
	// asks before losing work, its streamed output with Cancel, and the error it ended in.
	import { ops, closeProgress, closeError } from '../ops.svelte';
	import { reasonText } from '../reasons';
	import { t } from '../i18n';

	let outputBox: HTMLPreElement | undefined = $state();
	$effect(() => { void ops.output.length; if (outputBox) outputBox.scrollTop = outputBox.scrollHeight; });

	const showProgress = $derived((ops.running !== null && ops.running.streamed) || ops.finished !== null);

	function onKey(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (ops.question) { ops.question.answer(false); e.stopPropagation(); }
		else if (ops.error) { closeError(); e.stopPropagation(); }
		else if (ops.finished) { closeProgress(); e.stopPropagation(); }
	}
</script>

<svelte:window onkeydown={onKey} />

{#if ops.question}
	<div class="gg-backdrop" role="alertdialog" aria-modal="true">
		<div class="gg-box">
			<h2>{t('dialog.dataLoss.title')}</h2>
			<ul class="gg-reasons">
				{#each ops.question.reasons as reason, i (i)}<li>{reasonText(reason)}</li>{/each}
			</ul>
			<p class="gg-hint">{t('dialog.dataLoss.hint')}</p>
			<div class="gg-buttons">
				<button onclick={() => ops.question?.answer(false)}>{t('dialog.cancel')}</button>
				<button class="gg-ok danger" onclick={() => ops.question?.answer(true)}>{t('dialog.continue')}</button>
			</div>
		</div>
	</div>
{/if}

{#if showProgress}
	<div class="gg-backdrop" role="dialog" aria-modal="true">
		<div class="gg-box gg-progress">
			<h2>{ops.running ? ops.running.label + '…' : ops.finished?.label + ' · ' + (ops.finished?.error ? t('dialog.error.title') : t('dialog.progress.done'))}</h2>
			<pre class="gg-output" bind:this={outputBox}>{#each ops.output as line, i (i)}<span class:stderr={line.stderr}>{line.text}</span>{/each}</pre>
			{#if ops.finished?.error}<p class="gg-error">{ops.finished.error}</p>{/if}
			<div class="gg-buttons">
				{#if ops.running}
					<button onclick={() => ops.running?.cancel()}>{t('dialog.cancel')}</button>
				{:else}
					<button class="gg-ok" onclick={closeProgress}>{t('dialog.close')}</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

{#if ops.error}
	<div class="gg-backdrop" role="alertdialog" aria-modal="true">
		<div class="gg-box">
			<h2>{t('dialog.error.title')}</h2>
			{#if ops.error.step}<p class="gg-hint">{t('dialog.error.step', { step: ops.error.step })}</p>{/if}
			<pre class="gg-errortext">{ops.error.message}</pre>
			<div class="gg-buttons"><button class="gg-ok" onclick={closeError}>{t('dialog.close')}</button></div>
		</div>
	</div>
{/if}

<style>
	.gg-backdrop { position: fixed; inset: 0; z-index: 950; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.35); }
	.gg-box {
		width: min(520px, calc(100vw - 32px)); box-sizing: border-box; padding: 18px 20px 16px; border-radius: 12px;
		display: flex; flex-direction: column; gap: 10px;
		background: var(--gg-editorWidget-background); color: var(--gg-editorWidget-foreground);
		border: 1px solid var(--gg-editorWidget-border); box-shadow: 0 12px 40px var(--gg-widget-shadow);
	}
	.gg-progress { width: min(640px, calc(100vw - 32px)); }
	h2 { margin: 0; font-size: 14px; font-weight: 600; }
	.gg-reasons { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
	.gg-hint { margin: 0; font-size: 12px; color: var(--gg-descriptionForeground); }
	.gg-output, .gg-errortext {
		margin: 0; padding: 8px 10px; border-radius: 6px; max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: break-word;
		font-family: var(--gg-editor-font-family); font-size: 12px; background: var(--gg-textCodeBlock-background); user-select: text; -webkit-user-select: text;
	}
	.gg-output { min-height: 80px; }
	.stderr { color: var(--gg-descriptionForeground); }
	.gg-error { margin: 0; color: var(--gg-errorForeground); white-space: pre-wrap; }
	.gg-buttons { display: flex; justify-content: flex-end; gap: 8px; }
	button {
		font: inherit; padding: 4px 14px; border-radius: 6px; cursor: pointer;
		border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground);
	}
	.gg-ok { background: var(--gg-button-background); color: var(--gg-button-foreground); border-color: transparent; }
	.gg-ok.danger { background: var(--gg-errorForeground); }
</style>
