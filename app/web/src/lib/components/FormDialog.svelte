<script lang="ts">
	// A dialog from a spec (lib/dialogs.ts): its fields, Cancel and the action. Enter submits,
	// Esc cancels; the first field gets the focus. Reference names get their spaces replaced
	// as the settings say.
	import { onMount } from 'svelte';
	import type { DialogSpec, Values } from '../dialogs';
	import { substituteSpaces } from '../dialogs';
	import { settings } from '../settings.svelte';
	import { t } from '../i18n';

	let { spec, onSubmit, onCancel }: { spec: DialogSpec; onSubmit: (values: Values) => void; onCancel: () => void } = $props();

	const initial = (): Values => {
		const v: Values = {};
		for (const f of spec.fields) if (f.kind !== 'info') v[f.id] = f.value;
		return v;
	};
	let values = $state<Values>(initial());
	let error = $state('');
	let box: HTMLElement | undefined = $state();

	onMount(() => { (box?.querySelector('input, textarea, select') as HTMLElement | null)?.focus(); });

	function submit() {
		const built = spec.build(values);
		if ('error' in built) { error = built.error; return; }
		onSubmit(values);
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') { onCancel(); e.stopPropagation(); }
		else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) { submit(); e.preventDefault(); }
	}
	const onRefName = (id: string, e: Event) => { values[id] = substituteSpaces(settings.current, (e.target as HTMLInputElement).value); };
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="gg-backdrop" onkeydown={onKey} role="dialog" aria-modal="true" aria-label={spec.title} tabindex="-1">
	<div class="gg-box" bind:this={box}>
		<h2>{spec.title}</h2>
		<div class="gg-fields">
			{#each spec.fields as field, i (i)}
				{#if field.kind === 'info'}
					<p class="gg-info">{field.text}</p>
				{:else if field.kind === 'text'}
					<label><span>{field.label}</span>
						{#if field.refName}
							<input type="text" value={values[field.id] as string} placeholder={field.placeholder} oninput={(e) => onRefName(field.id, e)} />
						{:else}
							<input type="text" bind:value={values[field.id]} placeholder={field.placeholder} />
						{/if}
					</label>
				{:else if field.kind === 'textarea'}
					<label><span>{field.label}</span><textarea rows="5" bind:value={values[field.id]}></textarea></label>
				{:else if field.kind === 'checkbox'}
					<label class="gg-check"><input type="checkbox" bind:checked={values[field.id] as boolean} /> {field.label}</label>
				{:else if field.kind === 'select'}
					<label><span>{field.label}</span>
						<select bind:value={values[field.id]}>
							{#each field.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
						</select>
					</label>
				{:else if field.kind === 'radio'}
					<fieldset><legend>{field.label}</legend>
						{#each field.options as o (o.value)}
							<label class="gg-check"><input type="radio" name={field.id} value={o.value} bind:group={values[field.id]} /> {o.label}</label>
						{/each}
					</fieldset>
				{/if}
			{/each}
		</div>
		{#if error}<p class="gg-error">{error}</p>{/if}
		<div class="gg-buttons">
			<button class="gg-cancel" onclick={onCancel}>{t('dialog.cancel')}</button>
			<button class="gg-ok" class:danger={spec.danger} onclick={submit}>{spec.action}</button>
		</div>
	</div>
</div>

<style>
	.gg-backdrop { position: fixed; inset: 0; z-index: 900; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.35); }
	.gg-box {
		width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto; box-sizing: border-box;
		padding: 18px 20px 16px; border-radius: 12px; display: flex; flex-direction: column; gap: 12px;
		background: var(--gg-editorWidget-background); color: var(--gg-editorWidget-foreground);
		border: 1px solid var(--gg-editorWidget-border); box-shadow: 0 12px 40px var(--gg-widget-shadow);
	}
	h2 { margin: 0; font-size: 14px; font-weight: 600; }
	.gg-fields { display: flex; flex-direction: column; gap: 10px; }
	label { display: flex; flex-direction: column; gap: 4px; }
	label.gg-check { flex-direction: row; align-items: center; gap: 6px; }
	label > span, legend { font-size: 12px; color: var(--gg-descriptionForeground); }
	fieldset { border: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
	input[type=text], textarea, select {
		font: inherit; padding: 6px 8px; border-radius: 6px; outline: none;
		background: var(--gg-input-background); color: var(--gg-input-foreground); border: 1px solid var(--gg-input-border);
	}
	input[type=text]:focus, textarea:focus, select:focus { border-color: var(--gg-focusBorder); }
	textarea { resize: vertical; font-family: var(--gg-editor-font-family); font-size: 12px; }
	.gg-info { margin: 0; color: var(--gg-descriptionForeground); }
	.gg-error { margin: 0; color: var(--gg-errorForeground); }
	.gg-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
	button {
		font: inherit; padding: 4px 14px; border-radius: 6px; cursor: pointer;
		border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground);
	}
	.gg-ok { background: var(--gg-button-background); color: var(--gg-button-foreground); border-color: transparent; }
	.gg-ok.danger { background: var(--gg-errorForeground); }
</style>
