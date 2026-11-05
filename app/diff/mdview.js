/* What the Markdown preview of the file view needs besides the rendering itself (markdown.js,
 * loaded only for Markdown files): which files get one, where a relative image is in the
 * repository, and how lines of the source map to offsets of the rendered page. Pure. */

/** Files shown with a preview beside the source. */
export const isMarkdown = (path) => /\.(md|markdown)$/i.test(path);

/** The repository path an image or link `src` of the file at `filePath` means, or null when it
 * is not a file of the repository: a URL, an absolute path, or one that climbs out of the root. */
export function resolveRelative(filePath, src) {
	let target = String(src).split(/[?#]/)[0];
	if (target === '' || target.startsWith('/') || target.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
	try { target = decodeURIComponent(target); } catch (_) { /* not percent-encoded: as written */ }
	const parts = filePath.split('/').slice(0, -1);
	for (const part of target.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.length === 0 ? null : parts.join('/');
}

/** `marks` ({ line, top }: where the block starting at a source line is on the page) made
 * usable for interpolation: by line, one per line, tops never going back. */
export function monotonic(marks) {
	const sorted = marks.slice().sort((a, b) => a.line - b.line || a.top - b.top);
	const out = [];
	for (const m of sorted) {
		const last = out[out.length - 1];
		if (last !== undefined && (m.line === last.line || m.top < last.top)) continue;
		out.push(m);
	}
	return out;
}

/** Linear interpolation of `x` over the marks, from field `from` to field `to`. */
function interpolate(marks, x, from, to) {
	if (marks.length === 0) return 0;
	if (x <= marks[0][from]) return marks[0][to];
	for (let i = 1; i < marks.length; i++) {
		const a = marks[i - 1], b = marks[i];
		if (x <= b[from]) return b[from] === a[from] ? a[to] : a[to] + (x - a[from]) / (b[from] - a[from]) * (b[to] - a[to]);
	}
	return marks[marks.length - 1][to];
}

/** The page offset showing source line `line` (may be fractional); marks as monotonic() gives. */
export const lineToOffset = (marks, line) => interpolate(marks, line, 'line', 'top');

/** The (fractional) source line shown at page offset `offset`. */
export const offsetToLine = (marks, offset) => interpolate(marks, offset, 'top', 'line');
