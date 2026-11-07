// The dictionary in use, as reactive state: a component reading `t()` follows a change of
// language without reloading. Pure modules call `t()` when they build their strings, so they
// get the new words the next time they run.
import { en, type Key } from './en';
import { zhTW } from './zh-TW';

export type Language = 'en' | 'zh-TW';

const DICTIONARIES: Record<Language, Record<Key, string>> = { en, 'zh-TW': zhTW };

let language = $state<Language>('en');

/** The language for a setting of `auto`, `en` or `zh-TW`: any Chinese system language is zh-TW. */
export function languageFor(setting: string, systemLanguages: readonly string[] = navigator.languages ?? [navigator.language]): Language {
	if (setting === 'en' || setting === 'zh-TW') return setting;
	return systemLanguages.some((l) => l.toLowerCase().startsWith('zh')) ? 'zh-TW' : 'en';
}

export function setLanguage(next: Language): void {
	language = next;
}

export function currentLanguage(): Language {
	return language;
}

/** The text for `key`, with `{name}` placeholders filled from `values`. */
export function t(key: Key, values: Record<string, string | number> = {}): string {
	const text = DICTIONARIES[language][key] ?? en[key];
	return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? '{' + name + '}'));
}
