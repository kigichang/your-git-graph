<script lang="ts">
	// The details of a commit, the uncommitted changes, a stash, a comparison of two commits, or
	// a tag: docked below the graph, or inline below the row (`inline`, inside the table). Its
	// height can be dragged (at the top when docked, at the bottom when inline).
	import FileList from './FileList.svelte';
	import Message from './Message.svelte';
	import { log, openUrl, UNCOMMITTED, type Details, type FileChange, type TagDetails } from '../api/client';
	import { errorText } from '../errors';
	import { t } from '../i18n';

	export type DetailsView =
		| { kind: 'loading' }
		| { kind: 'error'; message: string }
		| { kind: 'commit'; details: Details; stash: string | null }
		| { kind: 'compare'; from: string; to: string; files: FileChange[] }
		| { kind: 'tag'; name: string; details: TagDetails };

	let { view, fileView = 'list', compactFolders = true, markdown = true, inline = false, height = $bindable(280), onClose, onOpenFile, onFileMenu, onShowCommit }: {
		view: DetailsView; fileView?: 'tree' | 'list'; compactFolders?: boolean;
		/** The message's light markup (`commits.markdown`). */
		markdown?: boolean;
		inline?: boolean; height?: number;
		onClose: () => void; onOpenFile: (change: FileChange, fileOnly: boolean) => void; onFileMenu?: (e: MouseEvent, change: FileChange) => void;
		/** A parent's link was clicked. */
		onShowCommit: (hash: string) => void;
	} = $props();
	const short = (hash: string) => (hash === UNCOMMITTED ? t('details.workingTree') : hash.slice(0, 8));
	/** The whole date with the time zone, whatever the graph's Date column is set to show. */
	const date = (seconds: number) => new Date(seconds * 1000).toString();
	const label = (text: string) => t('details.label', { label: text });
	const mailto = (email: string) => 'mailto:' + encodeURIComponent(email).replace('%40', '@');
	function mail(e: MouseEvent, email: string) {
		e.preventDefault();
		void openUrl(mailto(email)).catch((err) => log('mail link: ' + errorText(err)));
	}

	function startResize(e: PointerEvent) {
		const startY = e.clientY, startHeight = height;
		const move = (ev: PointerEvent) => {
			const delta = inline ? ev.clientY - startY : startY - ev.clientY;
			height = Math.max(120, Math.min(window.innerHeight - 160, startHeight + delta));
		};
		const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		e.preventDefault();
	}

	// Esc closes the panel wherever the focus is, unless a text field or a menu takes it.
	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
		const target = e.target as Element | null;
		if (target?.closest('input, textarea, [contenteditable], .gg-branch-filter')) return;
		onClose();
		e.preventDefault();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet person(name: string, email: string)}
	{name}{#if email !== ''}{' '}&lt;<a class="gg-link" href={mailto(email)} onclick={(e) => mail(e, email)}>{email}</a>&gt;{/if}
{/snippet}

<section class="gg-details" class:inline style:height="{height}px" aria-label="Details">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="gg-resize" onpointerdown={startResize}></div>
	<button class="gg-close" title={t('details.close')} onclick={onClose}>✕</button>
	{#if view.kind === 'loading'}
		<p class="gg-muted">{t('details.loading')}</p>
	{:else if view.kind === 'error'}
		<p class="gg-error">{view.message}</p>
	{:else if view.kind === 'tag'}
		<div class="gg-header">
			<h2>{t('details.tag', { name: view.name })}</h2>
			<div class="gg-fields">
				<div><b>{label(t('details.object'))}</b> {view.details.hash}</div>
				{#if view.details.annotated}
					<div><b>{label(t('details.tagger'))}</b> {@render person(view.details.tagger, view.details.taggerEmail)}</div>
					<div><b>{label(t('details.date'))}</b> {date(view.details.taggerDate)}</div>
				{:else}
					<div><b>{label(t('details.kind'))}</b> {t('details.lightweight')}</div>
				{/if}
			</div>
			{#if view.details.annotated}<pre class="gg-body">{view.details.message}</pre>{/if}
		</div>
	{:else}
		<div class="gg-columns">
			<div class="gg-header">
				{#if view.kind === 'compare'}
					<h2>{t('details.compare', { from: short(view.from), to: short(view.to) })}</h2>
					<div class="gg-fields">
						<div><b>{label(t('details.from'))}</b> {view.from}</div>
						<div><b>{label(t('details.to'))}</b> {view.to === UNCOMMITTED ? t('details.workingTree') : view.to}</div>
					</div>
				{:else if view.details.hash === UNCOMMITTED}
					<h2>{t('details.uncommitted')}</h2>
				{:else}
					{#if view.stash !== null}<h2>{t('details.stash', { name: view.stash })}</h2>{/if}
					<div class="gg-fields">
						<div><b>{label(t('details.commit'))}</b> {view.details.hash}</div>
						{#if view.details.parents.length > 0}
							<div><b>{label(t('details.parents'))}</b> {#each view.details.parents as parent, i (parent)}{#if i > 0}, {/if}<a class="gg-link" href={'#' + parent} onclick={(e) => { e.preventDefault(); onShowCommit(parent); }}>{parent}</a>{/each}</div>
						{/if}
						<div><b>{label(t('details.author'))}</b> {@render person(view.details.author, view.details.authorEmail)}</div>
						<div><b>{label(t('details.committer'))}</b> {@render person(view.details.committer, view.details.committerEmail)}</div>
						<div><b>{label(t('details.date'))}</b> {date(view.details.authorDate)}</div>
						{#if view.details.committerDate !== view.details.authorDate}
							<div><b>{label(t('details.commitDate'))}</b> {date(view.details.committerDate)}</div>
						{/if}
					</div>
					<pre class="gg-body"><Message text={view.details.body} {markdown} /></pre>
				{/if}
			</div>
			<div class="gg-filecol">
				{#if (view.kind === 'compare' ? view.files : view.details.files).length === 0}
					<p class="gg-muted">{t('details.noFiles')}</p>
				{:else}
					<FileList files={view.kind === 'compare' ? view.files : view.details.files} view={fileView} compact={compactFolders} onOpen={onOpenFile} onMenu={onFileMenu} />
				{/if}
			</div>
		</div>
	{/if}
</section>

<style>
	.gg-details {
		position: relative; flex: none; display: flex; flex-direction: column; min-height: 0;
		border-top: 1px solid var(--gg-panel-border); background: var(--gg-editor-background);
	}
	.gg-details.inline { border-bottom: 1px solid var(--gg-panel-border); border-left: 1px solid var(--gg-panel-border); box-sizing: border-box; }
	.gg-resize { position: absolute; top: -3px; left: 0; right: 0; height: 6px; cursor: row-resize; z-index: 1; }
	.gg-details.inline .gg-resize { top: auto; bottom: -3px; }
	.gg-close {
		position: absolute; top: 6px; right: 10px; z-index: 1; font: inherit; font-size: 12px; line-height: 1;
		padding: 3px 6px; border-radius: 4px; border: none; background: none; color: var(--gg-descriptionForeground); cursor: pointer;
	}
	.gg-close:hover { background: var(--gg-list-hoverBackground); color: var(--gg-foreground); }
	.gg-columns { display: flex; flex: 1; min-height: 0; }
	.gg-header { flex: 1; min-width: 0; overflow: auto; padding: 10px 14px; user-select: text; -webkit-user-select: text; cursor: auto; }
	.gg-filecol { flex: 1; min-width: 0; overflow: auto; border-left: 1px solid var(--gg-panel-border); padding: 6px 0; }
	h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
	.gg-fields { margin: 0 0 14px; line-height: 20px; overflow-wrap: anywhere; }
	.gg-fields b { font-weight: 600; }
	.gg-link { color: var(--gg-textLink-foreground); }
	.gg-link:hover { color: var(--gg-textLink-activeForeground); }
	.gg-body { margin: 0; font: inherit; line-height: 20px; white-space: pre-wrap; overflow-wrap: break-word; }
	.gg-muted { color: var(--gg-descriptionForeground); padding: 10px 14px; margin: 0; }
	.gg-error { color: var(--gg-errorForeground); padding: 10px 14px; margin: 0; white-space: pre-wrap; }
</style>
