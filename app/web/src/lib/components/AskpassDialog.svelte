<script lang="ts">
	// The questions git and ssh ask (Rust: askpass.rs): each arrives as an `askpass` event of
	// this window and is shown one at a time; the answer goes back with askpass_reply, null
	// for Cancel. A question git stopped waiting for is taken down.
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { log } from '../api/client';
	import { t } from '../i18n';

	type Prompt = { id: number; prompt: string };
	let queue = $state<Prompt[]>([]);
	let current = $state<Prompt | null>(null);
	let answer = $state('');
	let input: HTMLInputElement | undefined = $state();

	/** Prompts whose answer must not be shown while typing. */
	const SECRET = /password|passphrase|\bpin\b|token|secret/i;
	const secret = $derived(current !== null && SECRET.test(current.prompt));

	function showNext() {
		if (current !== null || queue.length === 0) return;
		current = queue[0] as Prompt;
		queue = queue.slice(1);
		answer = '';
		setTimeout(() => input?.focus(), 0);
	}

	function finish(reply: string | null) {
		if (current === null) return;
		const id = current.id;
		current = null;
		invoke('askpass_reply', { id, answer: reply }).catch((e) => log('askpass_reply failed: ' + e));
		showNext();
	}

	onMount(() => {
		const stop = getCurrentWindow().listen<{ type: 'request' | 'close'; id: number; prompt?: string }>('askpass', ({ payload }) => {
			if (payload.type === 'request') {
				void log('askpass: prompt ' + payload.id);
				queue = [...queue, { id: payload.id, prompt: payload.prompt ?? '' }];
				showNext();
			} else {
				queue = queue.filter((q) => q.id !== payload.id);
				if (current?.id === payload.id) { current = null; showNext(); }
				void log('askpass: prompt ' + payload.id + ' closed');
			}
		});
		return () => { void stop.then((unlisten) => unlisten()); };
	});

	function onKey(e: KeyboardEvent) {
		e.stopPropagation(); // not the graph's shortcuts
		if (e.key === 'Escape') { e.preventDefault(); finish(null); }
	}
</script>

{#if current}
	<div class="gg-backdrop" role="dialog" aria-modal="true" aria-label={t('askpass.title')}>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<form class="gg-box gg-askpass" autocomplete="off" onsubmit={(e) => { e.preventDefault(); finish(answer); }} onkeydown={onKey}>
			<h2>{t('askpass.title')}</h2>
			<label class="gg-prompt" for="gg-askpass-input">{current.prompt.trim()}</label>
			<input id="gg-askpass-input" bind:this={input} bind:value={answer} type={secret ? 'password' : 'text'} autocapitalize="off" autocorrect="off" spellcheck="false" />
			<div class="gg-buttons">
				<button type="button" onclick={() => finish(null)}>{t('dialog.cancel')}</button>
				<button type="submit" class="gg-ok">{t('dialog.ok')}</button>
			</div>
		</form>
	</div>
{/if}

<style>
	.gg-backdrop { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.35); }
	.gg-box {
		width: min(440px, calc(100vw - 32px)); box-sizing: border-box; padding: 18px 20px 16px; border-radius: 12px;
		display: flex; flex-direction: column; gap: 10px;
		background: var(--gg-editorWidget-background); color: var(--gg-editorWidget-foreground);
		border: 1px solid var(--gg-editorWidget-border); box-shadow: 0 12px 40px var(--gg-widget-shadow);
	}
	h2 { margin: 0; font-size: 14px; font-weight: 600; }
	.gg-prompt { white-space: pre-wrap; overflow-wrap: break-word; }
	input {
		font: inherit; padding: 6px 8px; border-radius: 6px; outline: none;
		background: var(--gg-input-background); color: var(--gg-input-foreground); border: 1px solid var(--gg-input-border);
	}
	input:focus { border-color: var(--gg-focusBorder); }
	.gg-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
	button {
		font: inherit; padding: 4px 14px; border-radius: 6px; cursor: pointer;
		border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground);
	}
	.gg-ok { background: var(--gg-button-background); color: var(--gg-button-foreground); border-color: transparent; }
</style>
