/* errors.ts: the text of anything thrown, and which engine answers are failures. */
import { test, expect } from 'vitest';
import { errorText, engineAnswer } from './errors';

test('an Error gives its message, anything else itself', () => {
	expect(errorText(new Error('boom'))).toBe('boom');
	expect(errorText('Not connected to host')).toBe('Not connected to host');
	expect(errorText(null)).toBe('null');
	expect(errorText({ message: '' })).toBe('[object Object]');
});

test('only a lone error string is an engine failure', () => {
	expect(() => engineAnswer('{"error":"NotFound: no such commit"}')).toThrow('NotFound: no such commit');
	expect(engineAnswer('{"commits":[],"error":null}')).toEqual({ commits: [], error: null });
	expect(engineAnswer('{"error":null}')).toEqual({ error: null });
	expect(engineAnswer('{"error":"partly","commits":[]}')).toEqual({ error: 'partly', commits: [] });
	expect(engineAnswer('["error"]')).toEqual(['error']);
	expect(engineAnswer('null')).toBe(null);
	expect(engineAnswer('"1.0.28"')).toBe('1.0.28');
});
