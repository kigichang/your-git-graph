/* The Markdown renderer of the file view, as its own bundle (diff-dist/preview.js and
 * preview.css with KaTeX's styles): diff/main.js loads it only for a Markdown file. */
import 'katex/dist/katex.min.css';
import { renderMarkdown } from './markdown.js';

window.__ggPreview = { renderMarkdown };
