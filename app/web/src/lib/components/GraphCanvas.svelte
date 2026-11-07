<script lang="ts">
	// The graph column: one canvas the size of the viewport, redrawn for the rows in view
	// whenever they or the scroll position change. Lives in the viewport, not in the scrolled
	// content, so scrolling only shifts what it draws.
	import { drawRows, rowAt, rowTop, NO_GAP, type Gap } from '../graph/draw';
	import type { Layout } from '../api/client';

	let { layout, width, height, rowHeight, scrollTop, gap = NO_GAP, head = -1, selected = -1, palette }: {
		layout: Layout; width: number; height: number; rowHeight: number; scrollTop: number;
		/** The space of the details shown inline: the lines run on below it, nothing is drawn over it. */
		gap?: Gap;
		head?: number; selected?: number; palette?: string[];
	} = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let drawn = 0; // how many times the canvas was painted (the self-test reads it); not state: the effect must not depend on it
	export const paints = () => drawn;

	$effect(() => {
		if (!canvas || width === 0 || height === 0) return;
		const dpr = window.devicePixelRatio || 1;
		if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
		}
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.lineCap = 'round';
		const first = rowAt(scrollTop, rowHeight, gap), last = rowAt(scrollTop + height, rowHeight, gap) + 1;
		drawRows(ctx, layout, { first, last, yOf: (row) => rowTop(row, rowHeight, gap) + rowHeight / 2 - scrollTop, rowHeight, head, selected, palette });
		if (gap.row >= 0) ctx.clearRect(0, (gap.row + 1) * rowHeight - scrollTop, width, gap.height);
		drawn++;
	});
</script>

<canvas bind:this={canvas} class="gg-graph-canvas" style:width="{width}px" style:height="{height}px"></canvas>

<style>
	.gg-graph-canvas {
		position: absolute; left: 0; top: 0; pointer-events: none;
		-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 10px), transparent);
		mask-image: linear-gradient(to right, #000 calc(100% - 10px), transparent);
	}
</style>
