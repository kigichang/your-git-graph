// Drawing the graph column from a Layout (crates/backend/src/graph.rs): the lanes' lines
// (spans) and the nodes. Pure apart from the canvas calls; tested with a recording context in
// draw.test.ts.
import type { Layout } from '../api/client';

/** Numbers per span and per dangling entry of a Layout. */
export const SPAN = 6, DANGLING = 3;

/** Pixels between lanes, and from the column's edge to the first lane. */
export const LANE_WIDTH = 14;
export const LANE_PAD = 10;
export const NODE_RADIUS = 4;

/** The lanes' colours, cycled; readable on the light and the dark background. */
export const PALETTE = ['#2f80ed', '#eb5757', '#27ae60', '#d9a400', '#9b51e0', '#1aa39a', '#f2994a', '#e0409a'];

export const laneX = (lane: number): number => LANE_PAD + lane * LANE_WIDTH;
export const graphWidth = (lanes: number): number => LANE_PAD * 2 + Math.max(1, lanes) * LANE_WIDTH;

/** What a drawing needs of a canvas context. */
export type Ctx = Pick<CanvasRenderingContext2D, 'beginPath' | 'moveTo' | 'lineTo' | 'bezierCurveTo' | 'stroke' | 'arc' | 'fill' | 'createLinearGradient'> & {
	strokeStyle: string | CanvasGradient | CanvasPattern; fillStyle: string | CanvasGradient | CanvasPattern; lineWidth: number; globalAlpha: number;
};

export type DrawOptions = {
	/** The first and last row to draw (inclusive); the lines entering and leaving them come too. */
	first: number; last: number;
	/** The y of a row's centre on the canvas. */
	yOf: (row: number) => number;
	rowHeight: number;
	palette?: string[];
	/** The row whose node is HEAD's (drawn as a ring). */
	head?: number;
	/** The selected row (a larger node). */
	selected?: number;
};

const colourOf = (palette: string[], c: number): string => palette[c % palette.length] as string;

/** The spans crossing rows `first..=last` (any part of them), as indices into `layout.spans`. */
export function spansInView(layout: Layout, first: number, last: number): number[] {
	const out: number[] = [];
	const s = layout.spans;
	for (let i = 0; i < s.length; i += SPAN) {
		const start = s[i] as number;
		if (start > last) break; // sorted by start
		if ((s[i + 1] as number) >= first) out.push(i);
	}
	return out;
}

/** Draw rows `first..=last` of `layout`: the lines first, then the nodes on top. The lines
 * are drawn from a row above `first` to one below `last` so that nothing stops at the edge. */
export function drawRows(ctx: Ctx, layout: Layout, o: DrawOptions): void {
	const palette = o.palette ?? PALETTE;
	const rows = layout.nodeLane.length;
	const top = Math.max(0, o.first - 1), bottom = Math.min(rows, o.last + 1);
	ctx.lineWidth = 2;
	const s = layout.spans;
	for (const i of spansInView(layout, top, bottom)) {
		const start = s[i] as number, end = s[i + 1] as number, lane = s[i + 2] as number, from = s[i + 3] as number, to = s[i + 4] as number;
		if (start === end) continue;
		ctx.strokeStyle = colourOf(palette, s[i + 5] as number);
		ctx.beginPath();
		// The column the line is in at a row: `from` at its first, `to` at its last, else its lane.
		const xAt = (row: number) => laneX(row === start ? from : row === end ? to : lane);
		let row = Math.max(start, top);
		const stop = Math.min(end, bottom);
		ctx.moveTo(xAt(row), o.yOf(row));
		while (row < stop) {
			const x0 = xAt(row), x1 = xAt(row + 1);
			if (x0 === x1) {
				// Straight as far as the column stays the same: to the row before `to` differs.
				let run = row + 1;
				while (run < stop && xAt(run + 1) === x1) run++;
				ctx.lineTo(x1, o.yOf(run));
				row = run;
			} else {
				const y0 = o.yOf(row), y1 = o.yOf(row + 1);
				ctx.bezierCurveTo(x0, y0 + (y1 - y0) / 2, x1, y1 - (y1 - y0) / 2, x1, y1);
				row++;
			}
		}
		ctx.stroke();
	}
	const d = layout.dangling;
	for (let i = 0; i < d.length; i += DANGLING) {
		const row = d[i] as number;
		if (row < top || row > bottom) continue;
		const x = laneX(d[i + 1] as number), y = o.yOf(row), endY = y + o.rowHeight * 0.7;
		const fade = ctx.createLinearGradient(0, y, 0, endY);
		fade.addColorStop(0, colourOf(palette, d[i + 2] as number));
		fade.addColorStop(1, 'rgba(0,0,0,0)');
		ctx.strokeStyle = fade;
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(x, endY);
		ctx.stroke();
	}
	for (let row = Math.max(0, o.first); row <= Math.min(o.last, rows - 1); row++) {
		const x = laneX(layout.nodeLane[row] as number), y = o.yOf(row);
		const colour = colourOf(palette, layout.nodeColour[row] as number);
		ctx.beginPath();
		ctx.arc(x, y, row === o.selected ? NODE_RADIUS + 1 : NODE_RADIUS, 0, Math.PI * 2);
		if (row === o.head) {
			ctx.strokeStyle = colour;
			ctx.lineWidth = 2.5;
			ctx.stroke();
			ctx.lineWidth = 2;
		} else {
			ctx.fillStyle = colour;
			ctx.fill();
		}
	}
}
