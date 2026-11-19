/* Markdown → HTML for the preview beside a Markdown file (diff/main.js): markdown-it with raw
 * HTML escaped, GFM task lists and KaTeX math. Code is left for the window to colour (Monaco);
 * ```mermaid and ```plantuml fences become containers the window renders afterwards. Blocks
 * carry the source line they start at (data-line, 1-based) for the scroll sync. No DOM: tested
 * by vitest (markdown.test.ts); bundled as diff-dist/preview.js (preview.js). */
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import katexPlugin from '@vscode/markdown-it-katex';
import { errorText } from '../web/src/lib/errors';

const md = new MarkdownIt({ html: false, linkify: true });
md.use(taskLists, { enabled: false });
// The katex plugin is transpiled CommonJS: some loaders hand over the namespace, not the function.
// maxSize: a length a document gives (\rule, \kern) is at most this many em - one of a
// million would push everything else out of the page.
md.use(katexPlugin.default ?? katexPlugin, { maxSize: 50, maxExpand: 1000, trust: false });

/* Where each block starts in the source. */
md.core.ruler.push('gg_source_lines', (state) => {
	for (const token of state.tokens) {
		if (token.map !== null && token.nesting >= 0) token.attrSet('data-line', String(token.map[0] + 1));
	}
});

// A Map: looked up by what a document wrote after ```, which may be "constructor".
const DIAGRAMS = new Map([['mermaid', 'mermaid'], ['plantuml', 'plantuml'], ['puml', 'plantuml']]);
const fence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const kind = DIAGRAMS.get(token.info.trim().toLowerCase());
	if (kind === undefined) return fence(tokens, idx, options, env, self);
	const line = token.map === null ? '' : ` data-line="${token.map[0] + 1}"`;
	return `<pre class="${kind}"${line}>${md.utils.escapeHtml(token.content)}</pre>\n`;
};

/** The HTML of a Markdown document. Never throws: a failure is shown in place of the page. */
export function renderMarkdown(text) {
	try {
		return md.render(text);
	} catch (e) {
		return `<pre>${md.utils.escapeHtml(errorText(e))}</pre>`;
	}
}
