import { test, expect } from 'vitest';
import { drawRows, spansInView, graphWidth, laneX, rowAt, rowTop, NO_GAP, LANE_PAD, LANE_WIDTH, type Ctx } from './draw';
import type { Layout } from '../api/client';

/* A branch merged back: rows m, f, d, e, b, a (the layout of graph.rs's test). */
const layout: Layout = {
	lanes: 2,
	nodeLane: [0, 1, 0, 1, 0, 0],
	nodeColour: [0, 1, 0, 1, 0, 0],
	spans: [
		0, 1, 1, 0, 1, 1, // m → f: out of m's node (lane 0) into lane 1
		0, 2, 0, 0, 0, 0, // m → d
		1, 3, 1, 1, 1, 1, // f → e
		2, 4, 0, 0, 0, 0, // d → b
		3, 4, 1, 1, 0, 1, // e → b: lane 1 ends in b's node (lane 0)
		4, 5, 0, 0, 0, 0 // b → a
	],
	dangling: []
};

function recorder() {
	const calls: string[] = [];
	const ctx = {
		strokeStyle: '', fillStyle: '', lineWidth: 0, globalAlpha: 1,
		beginPath: () => { calls.push('begin'); },
		moveTo: (x: number, y: number) => { calls.push(`move ${x},${y}`); },
		lineTo: (x: number, y: number) => { calls.push(`line ${x},${y}`); },
		bezierCurveTo: (...a: number[]) => { calls.push('curve ' + a.join(',')); },
		stroke: () => { calls.push('stroke ' + ctx.strokeStyle); },
		arc: (x: number, y: number, r: number) => { calls.push(`arc ${x},${y},${r}`); },
		fill: () => { calls.push('fill ' + ctx.fillStyle); },
		createLinearGradient: () => ({ addColorStop: () => {} }) as unknown as CanvasGradient
	};
	return { ctx: ctx as unknown as Ctx, calls };
}
const y = (row: number) => row * 24 + 12;

test('the spans crossing a range of rows, and the geometry', () => {
	expect(spansInView(layout, 2, 2)).toEqual([6, 12, 18]); // m→d ends at 2, f→e and d→b cross it
	expect(spansInView(layout, 5, 9)).toEqual([30]);
	expect(spansInView(layout, 0, 0)).toEqual([0, 6]);
	expect(graphWidth(2)).toBe(LANE_PAD * 2 + 2 * LANE_WIDTH);
	expect(graphWidth(0)).toBe(graphWidth(1));
	expect(laneX(1)).toBe(LANE_PAD + LANE_WIDTH);
});

test('visible rows get their lines and nodes, with the lines reaching in from outside', () => {
	const { ctx, calls } = recorder();
	drawRows(ctx, layout, { first: 1, last: 2, yOf: y, rowHeight: 24, palette: ['A', 'B'], head: 2 });
	// Rows 0..3 are drawn for the lines: every span but b→a crosses them (5 strokes); then
	// the two nodes, one filled and HEAD's stroked.
	expect(calls.filter((c) => c.startsWith('stroke')).length).toBe(5 + 1);
	expect(calls).toContain('curve 10,24,24,24,24,36'); // m → f: lane 0 (y 12) curves to lane 1 (y 36)
	expect(calls).toContain('move 10,12');
	expect(calls).toContain('line 10,60'); // m → d straight to row 2
	expect(calls).toContain('line 24,84'); // f → e straight to row 3
	expect(calls).toContain('arc 24,36,4'); // row 1's node in lane 1
	expect(calls).toContain('fill B');
	// HEAD (row 2) is a ring: stroked in its colour, not filled.
	const head = calls.indexOf('arc 10,60,4');
	expect(calls[head + 1]).toBe('stroke A');
});

test('a long straight span is one line, however many rows it crosses', () => {
	const { ctx, calls } = recorder();
	const long: Layout = { lanes: 2, nodeLane: Array(101).fill(0), nodeColour: Array(101).fill(0), spans: [0, 100, 1, 0, 1, 1], dangling: [] };
	drawRows(ctx, long, { first: 10, last: 20, yOf: y, rowHeight: 24 });
	expect(calls.filter((c) => c.startsWith('line')).length).toBe(1);
	expect(calls).toContain('move 24,228'); // row 9 (one above first)
	expect(calls).toContain('line 24,516'); // row 21 (one below last)
});

test('a dangling parent fades out below the node', () => {
	const { ctx, calls } = recorder();
	const dangling: Layout = { lanes: 1, nodeLane: [0], nodeColour: [0], spans: [], dangling: [0, 0, 0] };
	drawRows(ctx, dangling, { first: 0, last: 0, yOf: (row) => row * 20 + 10, rowHeight: 20 });
	expect(calls).toContain('line 10,24');
	expect(calls.some((c) => c.startsWith('stroke [object'))).toBe(true); // the gradient
});

test('a gap below a row (the details inline): rows below it move down, lines run through it', () => {
	const gap = { row: 0, height: 100 };
	expect([0, 1, 2].map((r) => rowTop(r, 24, gap))).toEqual([0, 124, 148]);
	expect([0, 1, 2].map((r) => rowTop(r, 24, NO_GAP))).toEqual([0, 24, 48]);
	expect([0, 23, 24, 123, 124, 147, 148].map((y) => rowAt(y, 24, gap))).toEqual([0, 0, 0, 0, 1, 1, 2]);
	expect(rowAt(50, 24, NO_GAP)).toBe(2);
	const { ctx, calls } = recorder();
	drawRows(ctx, layout, { first: 0, last: 2, yOf: (r) => rowTop(r, 24, gap) + 12, rowHeight: 24, palette: ['A', 'B'] });
	// m → f changes lane between rows 0 and 1, across the gap: down lane 0 to a row above f,
	// then the usual curve over one row's height.
	expect(calls).toContain('line 10,112');
	expect(calls).toContain('curve 10,124,24,124,24,136');
	expect(calls).toContain('line 10,160'); // m → d: straight, through the gap, to row 2
});

test('the style: rounded lines curve from lane to lane, angular ones slant straight', () => {
	const rounded = recorder();
	drawRows(rounded.ctx, layout, { first: 0, last: 1, yOf: y, rowHeight: 24, style: 'rounded' });
	expect(rounded.calls).toContain('curve 10,24,24,24,24,36');
	const angular = recorder();
	drawRows(angular.ctx, layout, { first: 0, last: 1, yOf: y, rowHeight: 24, style: 'angular' });
	expect(angular.calls.some((c) => c.startsWith('curve'))).toBe(false);
	// m → f: from m's node (lane 0, row 0) straight to f's (lane 1, row 1).
	const m = angular.calls.indexOf('move 10,12');
	expect(angular.calls[m + 1]).toBe('line 24,36');
	// Across a gap: straight down, then the slant over the last row's height.
	const gapped = recorder();
	drawRows(gapped.ctx, layout, { first: 0, last: 1, yOf: (r) => rowTop(r, 24, { row: 0, height: 100 }) + 12, rowHeight: 24, style: 'angular' });
	expect(gapped.calls).toContain('line 10,112');
	expect(gapped.calls).toContain('line 24,136');
});
