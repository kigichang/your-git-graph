/* The Markdown preview of the file view: the rendering (app/diff/markdown.js) and what the
 * window needs around it (app/diff/mdview.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../diff/markdown.js';
import { isMarkdown, resolveRelative, monotonic, lineToOffset, offsetToLine } from '../diff/mdview.js';

test('which files get a preview', () => {
	for (const path of ['README.md', 'docs/Guide.MD', 'a/b/notes.markdown']) assert.equal(isMarkdown(path), true, path);
	for (const path of ['README', 'md', 'a.md.txt', 'notes.mdx', 'x.markdown/y.rs']) assert.equal(isMarkdown(path), false, path);
});

test('the content of a repository cannot bring in HTML or scripts', () => {
	const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\ntext <b onclick="x()">bold</b>\n\n[x](javascript:alert(1)) [y](vbscript:x) [ok](https://example.com/a)\n');
	assert.doesNotMatch(html, /<script|<img|<b[ >]/, 'written out as text, not as elements');
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.doesNotMatch(html, /href="(javascript|vbscript):/i);
	assert.match(html, /<a href="https:\/\/example\.com\/a">ok<\/a>/);
	// A fence's language cannot break out of its attribute; diagram sources are escaped.
	const fences = renderMarkdown('```js"><script>x</script>\nlet a\n```\n\n```mermaid\ngraph TD; A-->B<script>\n```\n\n```plantuml\nA -> B : <b>hi</b>\n```\n');
	assert.doesNotMatch(fences, /<script|<b>/);
});

test('tables, task lists, math and plain links', () => {
	const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n\nInline $a^2$ and\n\n$$\n\\sum_i x_i\n$$\n\nsee https://example.com now\n');
	assert.match(html, /<table[^>]*>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/);
	assert.equal((html.match(/class="task-list-item-checkbox"/g) || []).length, 2);
	assert.match(html, /<input class="task-list-item-checkbox" checked="" disabled=""/, 'the boxes cannot be ticked');
	assert.match(html, /class="katex"/);
	assert.match(html, /class="katex-display"/);
	assert.match(html, /<a href="https:\/\/example\.com">https:\/\/example\.com<\/a>/);
});

test('code is left to the window; mermaid and plantuml fences become containers', () => {
	const html = renderMarkdown('```rust\nfn main() {}\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```PlantUML\nA -> B\n```\n\n```puml\nC -> D\n```\n');
	assert.match(html, /<pre><code[^>]*class="language-rust"[^>]*>fn main\(\) \{\}\n<\/code><\/pre>/);
	assert.match(html, /<pre class="mermaid" data-line="5">graph TD; A--&gt;B\n<\/pre>/);
	assert.match(html, /<pre class="plantuml" data-line="9">A -&gt; B\n<\/pre>/);
	assert.match(html, /<pre class="plantuml" data-line="13">C -&gt; D\n<\/pre>/);
});

test('blocks carry the source line they start at', () => {
	const html = renderMarkdown('# Title\n\nfirst\nparagraph\n\n- one\n- two\n\n```js\nx\n```\n\n> quote\n');
	const lines = Array.from(html.matchAll(/<(\w+)[^>]*data-line="(\d+)"/g)).map((m) => m[1] + ':' + m[2]);
	assert.deepEqual(lines, ['h1:1', 'p:3', 'ul:6', 'li:6', 'li:7', 'code:9', 'blockquote:13', 'p:13']);
});

test('an image path is a file of the repository, relative to the document', () => {
	assert.equal(resolveRelative('README.md', 'img/a.png'), 'img/a.png');
	assert.equal(resolveRelative('docs/guide/intro.md', './shot.png'), 'docs/guide/shot.png');
	assert.equal(resolveRelative('docs/guide/intro.md', '../../assets/logo.svg?raw=true#top'), 'assets/logo.svg');
	assert.equal(resolveRelative('docs/a.md', 'my%20pic.png'), 'docs/my pic.png');
	assert.equal(resolveRelative('docs/a.md', '100%.png'), 'docs/100%.png');
	assert.equal(resolveRelative('docs/a.md', 'a/../../x.png'), 'x.png');
	for (const out of ['../../x.png', '../../../etc/passwd', 'a/../../../x.png']) assert.equal(resolveRelative('docs/a.md', out), null, out);
	assert.equal(resolveRelative('README.md', '../x.png'), null);
	for (const other of ['https://example.com/a.png', '//example.com/a.png', '/etc/passwd', 'file:///etc/passwd', 'data:image/png;base64,AAAA', '', '#top', '..']) {
		assert.equal(resolveRelative('docs/a.md', other), null, other);
	}
});

test('lines of the source map to offsets of the page and back', () => {
	// As measured: out of order, a line twice (a list and its first item), a block higher than
	// the one before it (a table cell).
	const marks = monotonic([{ line: 11, top: 300 }, { line: 1, top: 0 }, { line: 5, top: 100 }, { line: 5, top: 104 }, { line: 8, top: 90 }, { line: 21, top: 1300 }]);
	assert.deepEqual(marks, [{ line: 1, top: 0 }, { line: 5, top: 100 }, { line: 11, top: 300 }, { line: 21, top: 1300 }]);
	assert.equal(lineToOffset(marks, 1), 0);
	assert.equal(lineToOffset(marks, 3), 50);
	assert.equal(lineToOffset(marks, 5), 100);
	assert.equal(lineToOffset(marks, 8), 200);
	assert.equal(lineToOffset(marks, 16.5), 850);
	assert.equal(lineToOffset(marks, 0), 0);
	assert.equal(lineToOffset(marks, 99), 1300);
	for (const line of [1, 2.5, 5, 9, 11, 20, 21]) assert.ok(Math.abs(offsetToLine(marks, lineToOffset(marks, line)) - line) < 1e-9, 'round trip of line ' + line);
	assert.equal(offsetToLine(marks, -5), 1);
	assert.equal(offsetToLine(marks, 5000), 21);
	assert.equal(lineToOffset([], 3), 0);
});
