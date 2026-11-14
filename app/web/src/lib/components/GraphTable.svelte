<script lang="ts">
	// The commit table: Graph | Description | Date | Author | Commit, with only the rows in
	// view in the DOM (a spacer gives the scrollbar its length), the graph column drawn on a
	// canvas, a header that stays put or scrolls away (`graph.stickyHeader`), keyboard selection,
	// and "load more" at the bottom.
	import type { Snippet } from 'svelte';
	import GraphCanvas from './GraphCanvas.svelte';
	import Message from './Message.svelte';
	import { graphWidth, rowAt, rowTop, type Gap, type GraphStyle } from '../graph/draw';
	import { formatDate, relative } from '../dates';
	import { UNCOMMITTED, type Commit, type Layout } from '../api/client';
	import type { DateFormat } from '../api/generated/DateFormat';
	import type { MenuTarget } from '../menus';
	import { t } from '../i18n';
	import { shortHash } from '../names';

	const relativeWords = (n: number, unit: string, ago: boolean) => {
		if (n === 0) return t('relative.justNow');
		const text = t(('relative.' + unit) as 'relative.year', { n });
		return ago ? t('relative.ago', { text }) : t('relative.in', { text });
	};
	const dateText = (seconds: number) => formatDate(seconds, dateFormat, relativeWords);
	/** The remote labels not already shown as a local branch's (combined onto it). */
	const remoteLabels = (commit: Commit) => (combineLabels ? commit.remotes.filter((r) => !commit.heads.some((h) => r.name === (r.remote ?? '') + '/' + h)) : commit.remotes);
	const combinedWith = (commit: Commit, head: string) => (combineLabels ? commit.remotes.filter((r) => r.name === (r.remote ?? '') + '/' + head).map((r) => r.remote ?? '').join(', ') : '');

	let { commits, layout, head = null, currentBranch = null, more = false, rowHeight = 24, fontSize = 13, palette, loadMoreAutomatically = true, highlighted = null, dateFormat = 'date-time', combineLabels = true,
		graphStyle = 'rounded', stickyHeader = true, markdown = true,
		gapRow = -1, gapHeight = 0, gap, onLoadMore, onSelect, onOpen, onCompare, onEscape, onTag, onContextMenu }: {
		commits: Commit[]; layout: Layout; head?: string | null; currentBranch?: string | null; more?: boolean; rowHeight?: number; fontSize?: number; palette?: string[]; loadMoreAutomatically?: boolean;
		/** How the lines change lane (`graph.style`). */
		graphStyle?: GraphStyle;
		/** The column titles stay at the top (`graph.stickyHeader`); off, they scroll away with the rows. */
		stickyHeader?: boolean;
		/** The messages' light markup (`commits.markdown`). */
		markdown?: boolean;
		/** The details shown inline: `gap` is drawn in a space of `gapHeight` px below row `gapRow` (-1: none). */
		gapRow?: number;
		gapHeight?: number;
		gap?: Snippet;
		/** The rows the find widget matched. */
		highlighted?: Set<number> | null;
		dateFormat?: DateFormat;
		/** A remote branch with the same name as a local one shows as one label. */
		combineLabels?: boolean;
		onLoadMore?: () => void;
		/** A right-click: on a row (its commit, the uncommitted row, a stash), a ref label, or the empty space. */
		onContextMenu?: (e: MouseEvent, target: MenuTarget) => void;
		/** A row was selected (click, keys); `again` when it was the selected one already. */
		onSelect?: (row: number, commit: Commit, again: boolean) => void;
		/** Enter: open the selected row's details (they may have been closed with Esc). */
		onOpen?: (row: number, commit: Commit) => void;
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
	/** Where the rows start in the scrolled content: below the header when it scrolls with them. */
	const headerOffset = $derived(stickyHeader ? 0 : rowHeight);
	/** The scroll position within the rows (negative while the scrolling header is in view). */
	const rowsScroll = $derived(scrollTop - headerOffset);
	const headRow = $derived(head === null ? -1 : commits.findIndex((c) => c.hash === head));
	const width = $derived(Math.max(64, Math.min(MAX_GRAPH_WIDTH, graphWidth(layout.lanes))));
	const g: Gap = $derived(gap && gapRow >= 0 && gapRow < rows ? { row: gapRow, height: gapHeight } : { row: -1, height: 0 });
	const first = $derived(Math.max(0, rowAt(Math.max(0, rowsScroll), rowHeight, g) - OVERSCAN));
	const last = $derived(Math.min(rows - 1, rowAt(Math.max(0, rowsScroll + viewHeight), rowHeight, g) + 1 + OVERSCAN));
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
		const top = headerOffset + rowTop(row, rowHeight, g), bottom = top + rowHeight;
		if (top < viewport.scrollTop) viewport.scrollTop = top;
		else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
	}

	/** Bring `row` (with the details below it, when they are inline there) into view: centred
	 * with `centre` (details.autoCenter), else scrolled just enough; a block taller than the
	 * view starts at its top. */
	export function showRow(row: number, centre: boolean) {
		if (!viewport || row < 0 || row >= rows) return;
		const top = headerOffset + rowTop(row, rowHeight, g), block = rowHeight + (row === g.row ? g.height : 0), view = viewport.clientHeight;
		if (block >= view) viewport.scrollTop = top;
		else if (centre) viewport.scrollTop = top - (view - block) / 2;
		else if (top < viewport.scrollTop) viewport.scrollTop = top;
		else if (top + block > viewport.scrollTop + view) viewport.scrollTop = top + block - view;
	}

	function onRowClick(e: MouseEvent, row: number) {
		if (e.shiftKey && selected >= 0 && selected !== row) {
			onCompare?.(commits[selected] as Commit, commits[row] as Commit);
			return;
		}
		select(row);
	}

	function onKeydown(e: KeyboardEvent) {
		// The inline details' own (a link, a file, the arrows in its lists), as when docked.
		if ((e.target as Element).closest('.gg-gap')) return;
		if (e.key === 'ArrowDown') { select(Math.min(rows - 1, selected + 1)); e.preventDefault(); }
		else if (e.key === 'ArrowUp') { select(Math.max(0, selected - 1)); e.preventDefault(); }
		else if (e.key === 'End') { if (more) onLoadMore?.(); else select(rows - 1); e.preventDefault(); }
		else if (e.key === 'Home') { select(0); e.preventDefault(); }
		else if (e.key === 'Enter' && !e.isComposing && selected >= 0 && selected < rows) { onOpen?.(selected, commits[selected] as Commit); e.preventDefault(); }
		// Handled here (the find widget, else the details): the details' own window-wide Esc must not close them too.
		else if (e.key === 'Escape') { onEscape?.(); e.preventDefault(); }
		else if (e.key === 'j' && e.metaKey) { if (headRow >= 0) select(headRow); e.preventDefault(); }
	}

	function menu(e: MouseEvent, target: MenuTarget) {
		if (!onContextMenu) return;
		e.preventDefault();
		e.stopPropagation();
		onContextMenu(e, target);
	}
	function rowTarget(row: number, commit: Commit): MenuTarget {
		if (commit.hash === UNCOMMITTED) return { kind: 'uncommitted', commit };
		if (commit.stash !== null) return { kind: 'stash', selector: commit.stash.selector, commit };
		return { kind: 'commit', commit, isHead: row === headRow };
	}
	function onRowMenu(e: MouseEvent, row: number, commit: Commit) {
		if (selected !== row && commit.hash !== UNCOMMITTED) select(row);
		menu(e, rowTarget(row, commit));
	}
	function onBackgroundMenu(e: MouseEvent) {
		if ((e.target as Element).closest('.gg-row, .gg-gap')) return;
		menu(e, { kind: 'background' });
	}

	/** Scroll to HEAD's row and select it (View > Show HEAD Commit); false when it is not loaded. */
	export function showHead(): boolean {
		if (headRow < 0) return false;
		select(headRow);
		return true;
	}

	const hashCell = (hash: string) => (hash === UNCOMMITTED ? '' : shortHash(hash));
</script>

{#snippet header()}
	<div class="gg-header" role="row">
		<div class="gg-cell gg-col-graph">{t('column.graph')}</div>
		<div class="gg-cell gg-col-desc">{t('column.description')}</div>
		<div class="gg-cell gg-col-date">{t('column.date')}</div>
		<div class="gg-cell gg-col-author">{t('column.author')}</div>
		<div class="gg-cell gg-col-hash">{t('column.commit')}</div>
	</div>
{/snippet}

<div class="gg-table" style:--gg-graph-width="{width}px" style:--gg-row-height="{rowHeight}px" style:font-size="{fontSize}px">
	{#if stickyHeader}{@render header()}{/if}
	<div class="gg-body">
	<div class="gg-viewport" bind:this={viewport} onscroll={onScroll} onkeydown={onKeydown} oncontextmenu={onBackgroundMenu} tabindex="0" role="grid" aria-rowcount={rows}>
		{#if !stickyHeader}{@render header()}{/if}
		<div class="gg-spacer" style:height="{rows * rowHeight + g.height}px">
			<div class="gg-rows" style:transform="translateY({rowTop(first, rowHeight, g)}px)">
				{#each visible as { row, commit } (commit.hash)}
					<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
					<div class="gg-row" class:selected={row === selected} class:head={row === headRow} class:highlighted={highlighted?.has(row)} role="row" aria-rowindex={row + 1} tabindex="-1"
						onclick={(e) => onRowClick(e, row)} oncontextmenu={(e) => onRowMenu(e, row, commit)}>
						<div class="gg-cell gg-col-graph"></div>
						<div class="gg-cell gg-col-desc">
							{#each commit.heads as name (name)}<span class="gg-ref gg-ref-head" class:gg-ref-current={name === currentBranch} role="button" tabindex="-1"
								oncontextmenu={(e) => menu(e, { kind: 'branch', name, commit, current: name === currentBranch })}>{name}{#if combinedWith(commit, name)}<span class="gg-ref-also"> · {combinedWith(commit, name)}</span>{/if}</span>{/each}
							{#each remoteLabels(commit) as r (r.name)}<span class="gg-ref gg-ref-remote" role="button" tabindex="-1"
								oncontextmenu={(e) => menu(e, { kind: 'remoteBranch', name: r.name, remote: r.remote, commit })}>{r.name}</span>{/each}
							{#each commit.tags as t (t.name)}<button class="gg-ref gg-ref-tag" onclick={(e) => { e.stopPropagation(); onTag?.(t.name, commit); }}
								oncontextmenu={(e) => menu(e, { kind: 'tag', name: t.name, annotated: t.annotated, commit })}>{t.name}</button>{/each}
							{#if commit.stash}<span class="gg-ref gg-ref-stash">{commit.stash.selector}</span>{/if}
							<span class="gg-message"><Message text={commit.message} {markdown} /></span>
						</div>
						<div class="gg-cell gg-col-date">{commit.hash === UNCOMMITTED ? '' : dateText(commit.date)}</div>
						<div class="gg-cell gg-col-author">{commit.author}</div>
						<div class="gg-cell gg-col-hash">{hashCell(commit.hash)}</div>
					</div>
					<!-- The rows below the inline details start below them. -->
					{#if row === g.row}<div class="gg-gap-space" style:height="{g.height}px"></div>{/if}
				{/each}
			</div>
			<!-- The details themselves: mounted once, wherever the scroll is (kept when scrolled away). -->
			{#if g.row >= 0 && gap}
				<div class="gg-gap" style:top="{(g.row + 1) * rowHeight}px" style:height="{g.height}px">{@render gap()}</div>
			{/if}
		</div>
	</div>
	{#if viewHeight > 0}
		<div class="gg-graph-layer" style:height="{viewHeight}px">
			<GraphCanvas bind:this={graph} {layout} {width} height={viewHeight} {rowHeight} scrollTop={rowsScroll} gap={g} head={headRow} {selected} {palette} style={graphStyle} />
		</div>
	{/if}
	</div>
	{#if more}
		<div class="gg-footer"><button onclick={() => onLoadMore?.()}>{t('toolbar.loadMore')}</button></div>
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
	.gg-gap { position: absolute; left: var(--gg-graph-width); right: 0; display: flex; flex-direction: column; }
	.gg-row:hover { background: var(--gg-list-hoverBackground); }
	.gg-row.highlighted { background: var(--gg-editor-findMatchHighlightBackground); box-shadow: inset 0 0 0 1px var(--gg-editor-findMatchHighlightBorder); }
	.gg-row.selected { background: var(--gg-menu-selectionBackground); color: var(--gg-menu-selectionForeground); }
	.gg-ref-also { font-weight: 400; color: var(--gg-descriptionForeground); }
	.gg-row.selected .gg-ref-also { color: inherit; }
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
