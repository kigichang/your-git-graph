<script lang="ts">
	// The commit table: Graph | Description | Date | Author | Commit, with only the rows in
	// view in the DOM (a spacer gives the scrollbar its length), the graph column drawn on a
	// canvas, a sticky header, keyboard selection, and "load more" at the bottom.
	import GraphCanvas from './GraphCanvas.svelte';
	import { graphWidth } from '../graph/draw';
	import { formatDate } from '../dates';
	import { UNCOMMITTED, type Commit, type Layout } from '../api/client';

	let { commits, layout, head = null, more = false, rowHeight = 24, fontSize = 13, palette, loadMoreAutomatically = true, onLoadMore, onSelect, onCompare, onEscape, onTag }: {
		commits: Commit[]; layout: Layout; head?: string | null; more?: boolean; rowHeight?: number; fontSize?: number; palette?: string[]; loadMoreAutomatically?: boolean;
		onLoadMore?: () => void;
		/** A row was selected (click, keys); `again` when it was the selected one already. */
		onSelect?: (row: number, commit: Commit, again: boolean) => void;
		/** ⇧-click: the selected row against another. */
		onCompare?: (selected: Commit, other: Commit) => void;
		onEscape?: () => void;
		onTag?: (name: string, commit: Commit) => void;
	} = $props();

	const OVERSCAN = 8;
	const MAX_GRAPH_WIDTH = 360;

	let viewport: HTMLDivElement | undefined = $state();
	let scrollTop = $state(0);
	let viewHeight = $state(0);
	let selected = $state(-1);
	let graph: ReturnType<typeof GraphCanvas> | undefined = $state();

	const rows = $derived(commits.length);
	const headRow = $derived(head === null ? -1 : commits.findIndex((c) => c.hash === head));
	const width = $derived(Math.min(MAX_GRAPH_WIDTH, graphWidth(layout.lanes)));
	const first = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN));
	const last = $derived(Math.min(rows - 1, Math.ceil((scrollTop + viewHeight) / rowHeight) + OVERSCAN));
	const visible = $derived.by(() => {
		const out: { row: number; commit: Commit }[] = [];
		for (let row = first; row <= last; row++) out.push({ row, commit: commits[row] as Commit });
		return out;
	});

	/** The self-test's view of the table. */
	export const stats = () => ({ rows, first, last, rendered: last - first + 1, paints: graph?.paints() ?? 0, selected, scrollTop });
	export const scrollTo = (top: number) => { if (viewport) viewport.scrollTop = top; };

	$effect(() => {
		if (!viewport) return;
		const observer = new ResizeObserver(() => { viewHeight = viewport?.clientHeight ?? 0; });
		observer.observe(viewport);
		viewHeight = viewport.clientHeight;
		return () => observer.disconnect();
	});

	function onScroll() {
		if (!viewport) return;
		scrollTop = viewport.scrollTop;
		if (more && loadMoreAutomatically && onLoadMore && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - rowHeight * 2) onLoadMore();
	}

	export function select(row: number) {
		if (row < 0 || row >= rows) return;
		const again = row === selected;
		selected = row;
		onSelect?.(row, commits[row] as Commit, again);
		reveal(row);
	}

	function reveal(row: number) {
		if (!viewport) return;
		const top = row * rowHeight, bottom = top + rowHeight;
		if (top < viewport.scrollTop) viewport.scrollTop = top;
		else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
	}

	function onRowClick(e: MouseEvent, row: number) {
		if (e.shiftKey && selected >= 0 && selected !== row) {
			onCompare?.(commits[selected] as Commit, commits[row] as Commit);
			return;
		}
		select(row);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') { select(Math.min(rows - 1, selected + 1)); e.preventDefault(); }
		else if (e.key === 'ArrowUp') { select(Math.max(0, selected - 1)); e.preventDefault(); }
		else if (e.key === 'End') { if (more) onLoadMore?.(); else select(rows - 1); e.preventDefault(); }
		else if (e.key === 'Home') { select(0); e.preventDefault(); }
		else if (e.key === 'Escape') { onEscape?.(); }
		else if (e.key === 'j' && e.metaKey) { if (headRow >= 0) select(headRow); e.preventDefault(); }
	}

	/** Scroll to HEAD's row and select it (View > Show HEAD Commit); false when it is not loaded. */
	export function showHead(): boolean {
		if (headRow < 0) return false;
		select(headRow);
		return true;
	}

	const shortHash = (hash: string) => (hash === UNCOMMITTED ? '' : hash.slice(0, 8));
</script>

<div class="gg-table" style:--gg-graph-width="{width}px" style:--gg-row-height="{rowHeight}px" style:font-size="{fontSize}px">
	<div class="gg-header" role="row">
		<div class="gg-cell gg-col-graph">Graph</div>
		<div class="gg-cell gg-col-desc">Description</div>
		<div class="gg-cell gg-col-date">Date</div>
		<div class="gg-cell gg-col-author">Author</div>
		<div class="gg-cell gg-col-hash">Commit</div>
	</div>
	<div class="gg-body">
	<div class="gg-viewport" bind:this={viewport} onscroll={onScroll} onkeydown={onKeydown} tabindex="0" role="grid" aria-rowcount={rows}>
		<div class="gg-spacer" style:height="{rows * rowHeight}px">
			<div class="gg-rows" style:transform="translateY({first * rowHeight}px)">
				{#each visible as { row, commit } (commit.hash)}
					<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
					<div class="gg-row" class:selected={row === selected} class:head={row === headRow} role="row" aria-rowindex={row + 1} tabindex="-1"
						onclick={(e) => onRowClick(e, row)}>
						<div class="gg-cell gg-col-graph"></div>
						<div class="gg-cell gg-col-desc">
							{#each commit.heads as name (name)}<span class="gg-ref gg-ref-head" class:gg-ref-current={name === head || (row === headRow)}>{name}</span>{/each}
							{#each commit.remotes as r (r.name)}<span class="gg-ref gg-ref-remote">{r.name}</span>{/each}
							{#each commit.tags as t (t.name)}<button class="gg-ref gg-ref-tag" onclick={(e) => { e.stopPropagation(); onTag?.(t.name, commit); }}>{t.name}</button>{/each}
							{#if commit.stash}<span class="gg-ref gg-ref-stash">{commit.stash.selector}</span>{/if}
							<span class="gg-message">{commit.message}</span>
						</div>
						<div class="gg-cell gg-col-date">{commit.hash === UNCOMMITTED ? '' : formatDate(commit.date)}</div>
						<div class="gg-cell gg-col-author">{commit.author}</div>
						<div class="gg-cell gg-col-hash">{shortHash(commit.hash)}</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
	{#if viewHeight > 0}
		<div class="gg-graph-layer" style:height="{viewHeight}px">
			<GraphCanvas bind:this={graph} {layout} {width} height={viewHeight} {rowHeight} {scrollTop} head={headRow} {selected} {palette} />
		</div>
	{/if}
	</div>
	{#if more}
		<div class="gg-footer"><button onclick={() => onLoadMore?.()}>Load more commits</button></div>
	{/if}
</div>

<style>
	.gg-table { display: flex; flex-direction: column; height: 100%; min-height: 0; }
	.gg-header, .gg-row { display: flex; align-items: center; height: var(--gg-row-height); white-space: nowrap; }
	.gg-header { flex: none; font-weight: 600; border-bottom: 1px solid var(--gg-panel-border); background: var(--gg-editorWidget-background); }
	.gg-body { flex: 1; min-height: 0; position: relative; }
	.gg-viewport { position: absolute; inset: 0; overflow: auto; outline: none; }
	.gg-spacer { position: relative; }
	.gg-rows { position: absolute; left: 0; right: 0; top: 0; }
	.gg-row:hover { background: var(--gg-list-hoverBackground); }
	.gg-row.selected { background: var(--gg-menu-selectionBackground); color: var(--gg-menu-selectionForeground); }
	.gg-row.head .gg-message { font-weight: 600; }
	.gg-cell { padding: 0 8px; overflow: hidden; text-overflow: ellipsis; }
	.gg-col-graph { flex: none; width: var(--gg-graph-width); padding: 0; }
	.gg-col-desc { flex: 1; min-width: 0; }
	.gg-col-date { flex: none; width: 150px; }
	.gg-col-author { flex: none; width: 150px; }
	.gg-col-hash { flex: none; width: 90px; font-family: var(--gg-editor-font-family); font-size: 12px; }
	.gg-graph-layer { position: absolute; top: 0; left: 0; width: var(--gg-graph-width); pointer-events: none; overflow: hidden; }
	.gg-ref {
		display: inline-block; margin-right: 4px; padding: 0 5px; border-radius: 4px; font-size: 11px; line-height: 16px;
		border: 1px solid var(--gg-panel-border); background: var(--gg-editorWidget-background); font-family: inherit; vertical-align: 1px;
	}
	button.gg-ref { cursor: pointer; }
	.gg-ref-current { font-weight: 600; }
	.gg-ref-head { border-color: var(--gg-charts-green); color: var(--gg-charts-green); }
	.gg-ref-remote { border-color: var(--gg-charts-blue); color: var(--gg-charts-blue); }
	.gg-ref-tag { border-color: var(--gg-charts-yellow); color: var(--gg-charts-yellow); }
	.gg-ref-stash { border-color: var(--gg-charts-purple); color: var(--gg-charts-purple); }
	.gg-row.selected .gg-ref { color: inherit; border-color: currentColor; background: transparent; }
	.gg-footer { flex: none; padding: 6px 8px; border-top: 1px solid var(--gg-panel-border); }
	.gg-footer button {
		font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer;
		border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground);
	}
</style>
