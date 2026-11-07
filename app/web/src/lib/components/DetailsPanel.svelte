<script lang="ts">
	// The panel docked below the graph: a commit's details, the uncommitted changes, a stash,
	// a comparison of two commits, or a tag. Its height can be dragged.
	import FileList from './FileList.svelte';
	import { formatDate } from '../dates';
	import { UNCOMMITTED, type Details, type FileChange, type TagDetails } from '../api/client';

	export type DetailsView =
		| { kind: 'loading' }
		| { kind: 'error'; message: string }
		| { kind: 'commit'; details: Details; stash: string | null }
		| { kind: 'compare'; from: string; to: string; files: FileChange[] }
		| { kind: 'tag'; name: string; details: TagDetails };

	let { view, fileView = 'tree', compactFolders = true, onClose, onOpenFile }: {
		view: DetailsView; fileView?: 'tree' | 'list'; compactFolders?: boolean;
		onClose: () => void; onOpenFile: (change: FileChange, fileOnly: boolean) => void;
	} = $props();

	let height = $state(280);
	const short = (hash: string) => (hash === UNCOMMITTED ? 'Working Tree' : hash.slice(0, 8));

	function startResize(e: PointerEvent) {
		const startY = e.clientY, startHeight = height;
		const move = (ev: PointerEvent) => { height = Math.max(120, Math.min(window.innerHeight - 160, startHeight + (startY - ev.clientY))); };
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

<section class="gg-details" style:height="{height}px" aria-label="Details">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="gg-resize" onpointerdown={startResize}></div>
	<button class="gg-close" title="Close (Esc)" onclick={onClose}>✕</button>
	{#if view.kind === 'loading'}
		<p class="gg-muted">Loading…</p>
	{:else if view.kind === 'error'}
		<p class="gg-error">{view.message}</p>
	{:else if view.kind === 'tag'}
		<div class="gg-header">
			<h2>Tag {view.name}</h2>
			<dl>
				<dt>Object</dt><dd class="gg-mono">{view.details.hash}</dd>
				{#if view.details.annotated}
					<dt>Tagger</dt><dd>{view.details.tagger} &lt;{view.details.taggerEmail}&gt;</dd>
					<dt>Date</dt><dd>{formatDate(view.details.taggerDate)}</dd>
				{:else}
					<dt>Kind</dt><dd>Lightweight</dd>
				{/if}
			</dl>
			{#if view.details.annotated}<pre class="gg-body">{view.details.message}</pre>{/if}
		</div>
	{:else}
		<div class="gg-columns">
			<div class="gg-header">
				{#if view.kind === 'compare'}
					<h2>Compare {short(view.from)} ↔ {short(view.to)}</h2>
					<dl>
						<dt>From</dt><dd class="gg-mono">{view.from}</dd>
						<dt>To</dt><dd class="gg-mono">{view.to === UNCOMMITTED ? 'Working tree' : view.to}</dd>
					</dl>
				{:else if view.details.hash === UNCOMMITTED}
					<h2>Uncommitted Changes</h2>
				{:else}
					<h2>{view.stash !== null ? 'Stash ' + view.stash : 'Commit ' + short(view.details.hash)}</h2>
					<dl>
						<dt>Hash</dt><dd class="gg-mono">{view.details.hash}</dd>
						{#if view.details.parents.length > 0}
							<dt>Parents</dt><dd class="gg-mono">{view.details.parents.map(short).join(', ')}</dd>
						{/if}
						<dt>Author</dt><dd>{view.details.author} &lt;{view.details.authorEmail}&gt;</dd>
						<dt>Date</dt><dd>{formatDate(view.details.authorDate)}</dd>
						{#if view.details.committer !== view.details.author || view.details.committerEmail !== view.details.authorEmail}
							<dt>Committer</dt><dd>{view.details.committer} &lt;{view.details.committerEmail}&gt; · {formatDate(view.details.committerDate)}</dd>
						{/if}
					</dl>
					<pre class="gg-body">{view.details.body}</pre>
				{/if}
			</div>
			<div class="gg-filecol">
				{#if (view.kind === 'compare' ? view.files : view.details.files).length === 0}
					<p class="gg-muted">No files changed.</p>
				{:else}
					<FileList files={view.kind === 'compare' ? view.files : view.details.files} view={fileView} compact={compactFolders} onOpen={onOpenFile} />
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
	.gg-resize { position: absolute; top: -3px; left: 0; right: 0; height: 6px; cursor: row-resize; z-index: 1; }
	.gg-close {
		position: absolute; top: 6px; right: 10px; z-index: 1; font: inherit; font-size: 12px; line-height: 1;
		padding: 3px 6px; border-radius: 4px; border: none; background: none; color: var(--gg-descriptionForeground); cursor: pointer;
	}
	.gg-close:hover { background: var(--gg-list-hoverBackground); color: var(--gg-foreground); }
	.gg-columns { display: flex; flex: 1; min-height: 0; }
	.gg-header { flex: 1; min-width: 0; overflow: auto; padding: 10px 14px; }
	.gg-filecol { flex: 1; min-width: 0; overflow: auto; border-left: 1px solid var(--gg-panel-border); padding: 6px 0; }
	h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
	dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 10px; font-size: 12px; }
	dt { color: var(--gg-descriptionForeground); }
	dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.gg-mono { font-family: var(--gg-editor-font-family); user-select: text; -webkit-user-select: text; }
	.gg-body { margin: 0; font: inherit; white-space: pre-wrap; overflow-wrap: break-word; user-select: text; -webkit-user-select: text; }
	.gg-muted { color: var(--gg-descriptionForeground); padding: 10px 14px; margin: 0; }
	.gg-error { color: var(--gg-errorForeground); padding: 10px 14px; margin: 0; white-space: pre-wrap; }
</style>
