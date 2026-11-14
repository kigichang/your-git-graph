// The settings (settings.json, read through Rust: `settings_get`), as reactive state every
// component reads; `settings-changed` (a change in any window, or a hand edit noticed when
// the window comes to the front) reloads them.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Settings } from './api/generated/Settings';
import type { SettingsView } from './api/generated/SettingsView';
import type { Ignored } from './api/generated/Ignored';
import { log } from './api/client';

export type { Settings, Ignored };

/** The defaults, until the file is read (the same as Rust's `Settings::default()`). */
export const DEFAULT_SETTINGS: Settings = {
	language: 'auto',
	graph: { style: 'rounded', rowHeight: 24, fontSize: 13, colours: ['#2f80ed', '#eb5757', '#27ae60', '#d9a400', '#9b51e0', '#1aa39a', '#f2994a', '#e0409a'], combineLocalAndRemoteLabels: true, stickyHeader: true },
	commits: { initialLoad: 300, loadMore: 100, loadMoreAutomatically: true, order: 'date', showUncommitted: true, showUntracked: true, includeReflog: false, dateType: 'author', dateFormat: 'date-time', markdown: true },
	repository: { showRemoteBranches: true, showRemoteHeads: true, fetchAndPrune: false, fetchAndPruneTags: false },
	details: { location: 'inline', fileView: 'list', compactFolders: true, autoCenter: true },
	dialogs: {},
	authors: [],
	plantumlJar: null,
	logEnabled: false
};

let current = $state.raw<Settings>(DEFAULT_SETTINGS);
let ignored = $state.raw<Ignored[]>([]);
const listeners: ((s: Settings) => void)[] = [];

export const settings = {
	get current() { return current; },
	get ignored() { return ignored; },
	/** Runs `fn` after every reload (not now). */
	onChange(fn: (s: Settings) => void) { listeners.push(fn); }
};

export async function reloadSettings(): Promise<Settings> {
	try {
		const view = await invoke<SettingsView>('settings_get');
		current = view.settings;
		ignored = view.ignored;
		void log(`settings: read (row height ${view.settings.graph.rowHeight}, ${view.ignored.length} ignored)`);
		for (const i of view.ignored) void log(`settings: ${i.key} ignored (${i.reason})`);
	} catch (e) {
		void log('settings: cannot read: ' + String(e));
	}
	for (const fn of listeners) fn(current);
	return current;
}

/** Set one setting (`null`: back to the default); Rust refuses an invalid value. */
export function setSetting(key: string, value: unknown): Promise<void> {
	return invoke<void>('settings_set', { key, value });
}

let watching = false;
/** Read the settings now and again whenever they change. */
export function watchSettings(): Promise<Settings> {
	if (!watching) {
		watching = true;
		void listen('settings-changed', () => { void reloadSettings(); });
		window.addEventListener('focus', () => { void reloadSettings(); });
	}
	return reloadSettings();
}
