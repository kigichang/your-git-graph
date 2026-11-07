/* The theme (web/public/theme.css): in each of the four appearances (light, dark, each with
 * macOS Increase Contrast), text must keep a WCAG contrast ratio against what it is drawn on -
 * 4.5:1 for text, 7:1 for the main text with Increase Contrast - and with Increase Contrast,
 * borders must be visible (3:1). System colours (AccentColor) cannot be resolved here: the
 * self-test checks them in WebKit. */
import { test, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(fileURLToPath(new URL('../public/theme.css', import.meta.url)), 'utf8')
	.replace(/\/\*[\s\S]*?\*\//g, '');

type Tokens = Record<string, string>;
type RGBA = [number, number, number, number];

/** The custom properties of each top-level rule whose selector is exactly `selector`. */
function declarations(selector: string): Tokens {
	const out: Tokens = {};
	const rule = /([^{}]+)\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = rule.exec(css)) !== null) {
		if ((m[1] as string).trim() !== selector) continue;
		for (const d of (m[2] as string).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1] as string] = (d[2] as string).trim();
	}
	return out;
}

const MODES: Record<string, string[]> = {
	light: [':root'],
	dark: [':root', ':root.gg-dark'],
	'light, Increase Contrast': [':root', ':root.gg-contrast'],
	'dark, Increase Contrast': [':root', ':root.gg-dark', ':root.gg-contrast', ':root.gg-dark.gg-contrast']
};
const tokensOf = (mode: string): Tokens => Object.assign({}, ...(MODES[mode] as string[]).map(declarations));

/** [r, g, b, a] of a hex / rgb() / rgba() colour, null for anything else (system colours,
 * color-mix, transparent). */
function parse(value: string, tokens: Tokens): RGBA | null {
	const v = value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => tokens[name] ?? 'unresolved');
	let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
	if (m) {
		const hex = m[1] as string;
		const h = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
		return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
	}
	m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
	return m ? [+(m[1] as string), +(m[2] as string), +(m[3] as string), m[4] === undefined ? 1 : +m[4]] : null;
}
const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => (top[i] as number) * top[3] + (under[i] as number) * (1 - top[3])).concat(1) as RGBA;
const luminance = (rgb: RGBA): number => {
	const [r, g, b] = rgb.slice(0, 3).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: RGBA, b: RGBA): number => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };

/* [foreground, background, minimum ratio, minimum with Increase Contrast] */
const TEXT: [string, string, number, number][] = [
	['foreground', 'editor-background', 4.5, 7],
	['editor-foreground', 'editor-background', 4.5, 7],
	['descriptionForeground', 'editor-background', 4.5, 4.5],
	['errorForeground', 'editor-background', 4.5, 4.5],
	['textLink-foreground', 'editor-background', 4.5, 4.5],
	['editorWarning-foreground', 'editor-background', 4.5, 4.5],
	['editorInfo-foreground', 'editor-background', 4.5, 4.5],
	['menu-foreground', 'menu-background', 4.5, 7],
	['editorWidget-foreground', 'editorWidget-background', 4.5, 7],
	['editorSuggestWidget-foreground', 'editorWidget-background', 4.5, 7],
	['input-foreground', 'input-background', 4.5, 7],
	['dropdown-foreground', 'dropdown-background', 4.5, 7],
	['inputValidation-warningForeground', 'inputValidation-warningBackground', 4.5, 4.5],
	['foreground', 'inputValidation-errorBackground', 4.5, 4.5],
	['input-placeholderForeground', 'input-background', 3, 4.5],
	['gitDecoration-addedResourceForeground', 'editor-background', 4.5, 4.5],
	['gitDecoration-deletedResourceForeground', 'editor-background', 4.5, 4.5],
	['gitDecoration-modifiedResourceForeground', 'editor-background', 4.5, 4.5],
	['gitDecoration-renamedResourceForeground', 'editor-background', 4.5, 4.5],
	['testing-iconPassed', 'editor-background', 3, 4.5],
	['testing-iconFailed', 'editor-background', 3, 4.5],
	['charts-green', 'editor-background', 3, 4.5],
	['charts-red', 'editor-background', 3, 4.5],
	['charts-blue', 'editor-background', 3, 4.5],
	['charts-purple', 'editor-background', 3, 4.5],
	['charts-yellow', 'editor-background', 3, 3],
	['charts-orange', 'editor-background', 3, 4.5],
	['editorLightBulb-foreground', 'editor-background', 3, 3],
	// The repository sidebar: names, the header and footer, the ahead/behind badge.
	['foreground', 'sidebar-background', 4.5, 7],
	['descriptionForeground', 'sidebar-background', 4.5, 4.5],
	['gitDecoration-addedResourceForeground', 'sidebar-background', 4.5, 4.5]
];
/* Increase Contrast only: the edges of things must show. */
const BORDERS: [string, string][] = [
	['input-border', 'input-background'],
	['dropdown-border', 'dropdown-background'],
	['editorWidget-border', 'editorWidget-background'],
	['menu-border', 'menu-background'],
	['panel-border', 'editor-background'],
	['contrastBorder', 'editor-background'],
	['menu-selectionBorder', 'menu-background'],
	['editor-findMatchHighlightBorder', 'editor-background']
];

for (const mode of Object.keys(MODES)) {
	test(`contrast in ${mode}`, () => {
		const tokens = tokensOf(mode);
		const contrast = mode.includes('Increase Contrast');
		const token = (name: string) => tokens['--gg-' + name];
		const color = (name: string) => parse(token(name) ?? 'missing', tokens);
		const canvas = color('editor-background');
		expect(canvas !== null && canvas[3] === 1, 'an opaque editor background').toBe(true);
		const failures: string[] = [];
		const checkPair = (fg: string, bg: string, min: number) => {
			const b = color(bg), f = color(fg);
			if (b === null || f === null) { failures.push(`${fg} on ${bg}: not a colour (${token(fg)} / ${token(bg)})`); return; }
			const base = over(b, canvas as RGBA);
			const r = ratio(over(f, base), base);
			if (r < min) failures.push(`${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
		};
		for (const [fg, bg, normal, more] of TEXT) checkPair(fg, bg, contrast ? more : normal);
		if (contrast) for (const [border, bg] of BORDERS) checkPair(border, bg, 3);
		expect(failures).toEqual([]);
	});
}

test('the appearances define the same tokens', () => {
	const base = Object.keys(declarations(':root')).sort();
	for (const selector of [':root.gg-dark', ':root.gg-contrast', ':root.gg-dark.gg-contrast']) {
		const extra = Object.keys(declarations(selector)).filter((k) => !base.includes(k));
		expect(extra, selector + ' sets tokens the light theme lacks').toEqual([]);
	}
});
