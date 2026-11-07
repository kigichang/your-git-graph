import { test, expect } from 'vitest';
import { formatDate, relative } from './dates';

test('the formats', () => {
	const t = Date.UTC(2026, 10, 7, 12, 34) / 1000;
	expect(formatDate(t, 'iso-date-time')).toBe('2026-11-07 12:34Z');
	expect(formatDate(t, 'iso-date')).toBe('2026-11-07');
	expect(formatDate(t, 'date-time')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	expect(formatDate(t, 'date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('relative dates', () => {
	const now = 1_800_000_000;
	expect(relative(now - 30, now)).toBe('just now');
	expect(relative(now - 90, now)).toBe('1 minute ago');
	expect(relative(now - 3600 * 5, now)).toBe('5 hours ago');
	expect(relative(now - 86400 * 9, now)).toBe('1 week ago');
	expect(relative(now - 86400 * 400, now)).toBe('1 year ago');
	expect(relative(now + 3600 * 2, now)).toBe('in 2 hours');
	expect(relative(now - 86400 * 3, now, (n, unit) => `${n}${unit[0]}`)).toBe('3d');
});
