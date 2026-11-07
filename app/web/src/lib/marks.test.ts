import { test, expect } from 'vitest';
import { marks } from './marks';

const show = (text: string) => marks(text).map((s) => (s.mark === 'text' ? s.text : `<${s.mark}>${s.text}</${s.mark}>`)).join('');

test('code, bold and italic are marked', () => {
	expect(show('Fix `git log` in **every** case, *really*')).toBe('Fix <code>git log</code> in <strong>every</strong> case, <em>really</em>');
	expect(show('__bold__ and _it_')).toBe('<strong>bold</strong> and <em>it</em>');
	expect(show('a *b* c')).toBe('a <em>b</em> c');
});

test('what is not markup stays text', () => {
	expect(show('snake_case_name and file_name.rs')).toBe('snake_case_name and file_name.rs');
	expect(show('2 * 3 * 4')).toBe('2 * 3 * 4');
	expect(show('`**not bold**`')).toBe('<code>**not bold**</code>');
	expect(show('an `unclosed tick')).toBe('an `unclosed tick');
	expect(show('** spaced **')).toBe('** spaced **');
	expect(marks('plain')).toEqual([{ mark: 'text', text: 'plain' }]);
	expect(marks('')).toEqual([{ mark: 'text', text: '' }]);
});

test('HTML is only ever text, and off means one text span', () => {
	expect(marks('<img src=x onerror=alert(1)> **<b>x</b>**')).toEqual([
		{ mark: 'text', text: '<img src=x onerror=alert(1)> ' },
		{ mark: 'strong', text: '<b>x</b>' }
	]);
	expect(marks('**bold**', false)).toEqual([{ mark: 'text', text: '**bold**' }]);
});
