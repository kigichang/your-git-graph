// The interface's words: `t(key, values)` in the current language. English now; Traditional
// Chinese joins with the settings panel (M6), as a second dictionary with the same keys.
import { en, type Key } from './en';

export type { Key };

let current: Record<Key, string> = en;

/** Switch dictionaries (the same keys as `en`). */
export function setStrings(strings: Record<Key, string>): void {
	current = strings;
}

/** The text for `key`, with `{name}` placeholders filled from `values`. */
export function t(key: Key, values: Record<string, string | number> = {}): string {
	return current[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? '{' + name + '}'));
}
