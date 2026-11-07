import { test, expect } from 'vitest';
import { en } from './en';
import { zhTW } from './zh-TW';
import { languageFor } from './strings.svelte';

test('both dictionaries have the same keys, and the same placeholders', () => {
	expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
	for (const key of Object.keys(en) as (keyof typeof en)[]) {
		const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
		expect(holes(zhTW[key]), key).toEqual(holes(en[key]));
	}
});

test('the Chinese is Traditional (Taiwan), not Simplified', () => {
	// Characters that only occur in Simplified Chinese writing.
	const simplified = /[这个们时间来对开关发现应该还没设档项选择确认删创远标签仓库检显储变销载编辑启动闭进经]/u;
	for (const [key, text] of Object.entries(zhTW)) {
		const bad = text.match(simplified);
		expect(bad, `${key}: "${text}" has a Simplified character ${bad?.[0] ?? ''}`).toBe(null);
	}
});

test('auto picks Traditional Chinese for any Chinese system language', () => {
	expect(languageFor('auto', ['zh-Hant-TW'])).toBe('zh-TW');
	expect(languageFor('auto', ['zh-CN'])).toBe('zh-TW');
	expect(languageFor('auto', ['en-US', 'zh'])).toBe('zh-TW');
	expect(languageFor('auto', ['en-US'])).toBe('en');
	expect(languageFor('en', ['zh-TW'])).toBe('en');
	expect(languageFor('zh-TW', ['en'])).toBe('zh-TW');
});
