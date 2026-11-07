// The light markup of commit messages (`commits.markdown`): `code`, **bold** / __bold__ and
// *italic* / _italic_, inline only. The result is a list of spans that the page renders as
// text nodes, never HTML, so a message can't inject markup. An underscore only counts at a
// word's edge (snake_case stays as it is); markers inside code are text.

export type Mark = 'text' | 'code' | 'strong' | 'em';
export type Span = { mark: Mark; text: string };

const TOKEN = /`([^`\n]+)`|\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__|\*(?=[^\s*])([^*\n]*?[^\s*])?\*|_(?=[^\s_])([^_\n]*?[^\s_])?_/g;
const WORD = /[\p{L}\p{N}_]/u;

/** `text` cut into spans; with `enabled` false, one text span. */
export function marks(text: string, enabled = true): Span[] {
	if (!enabled || text === '') return [{ mark: 'text', text }];
	const out: Span[] = [];
	let plain = '';
	let at = 0;
	TOKEN.lastIndex = 0;
	for (let m = TOKEN.exec(text); m !== null; m = TOKEN.exec(text)) {
		const whole = m[0];
		// An underscore marker needs a non-word character (or nothing) on its outer sides.
		if (whole.startsWith('_')) {
			const before = text[m.index - 1], after = text[m.index + whole.length];
			if ((before !== undefined && WORD.test(before)) || (after !== undefined && WORD.test(after))) {
				TOKEN.lastIndex = m.index + 1;
				continue;
			}
		}
		plain += text.slice(at, m.index);
		if (plain) out.push({ mark: 'text', text: plain });
		plain = '';
		if (m[1] !== undefined) out.push({ mark: 'code', text: m[1] });
		else if (m[2] !== undefined || m[3] !== undefined) out.push({ mark: 'strong', text: (m[2] ?? m[3]) as string });
		else out.push({ mark: 'em', text: whole.slice(1, -1) });
		at = m.index + whole.length;
	}
	plain += text.slice(at);
	if (plain) out.push({ mark: 'text', text: plain });
	return out;
}
