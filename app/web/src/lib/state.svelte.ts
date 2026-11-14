// state.json (Rust: state.rs), as the windows share it: a snapshot taken at boot, changes
// sent with `state_set` (Rust coalesces the writes and tells the other windows with
// `state-changed`, which updates the snapshot here). The keys the app uses have typed readers.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { sidebarFrom, type SidebarState } from './sidebar';

let snapshot = $state.raw<Record<string, unknown>>({});
const listeners: ((key: string) => void)[] = [];

export const appState = {
	get<T = unknown>(key: string): T | undefined { return snapshot[key] as T | undefined; },
	/** Set a key (`null` removes it): here at once, in the file shortly, in the other windows.
	 * Settles when Rust has it (callers that need that, such as adding to the sidebar, wait). */
	set(key: string, value: unknown): Promise<void> {
		const next = { ...snapshot };
		if (value === null || value === undefined) delete next[key]; else next[key] = value;
		snapshot = next;
		return invoke<void>('state_set', { key, value: value ?? null }).catch(() => {});
	},
	get sidebar(): SidebarState { return sidebarFrom(snapshot['sidebar']); },
	get lastActiveRepo(): string | null { const v = snapshot['lastActiveRepo']; return typeof v === 'string' ? v : null; },
	/** repository → smb://… of the share it is on. */
	get mounts(): Record<string, string> { const v = snapshot['mounts']; return typeof v === 'object' && v !== null ? (v as Record<string, string>) : {}; },
	/** Runs `fn(key)` when another window changed `key`. */
	onChange(fn: (key: string) => void) { listeners.push(fn); }
};

/** Take the snapshot and follow the other windows' changes. */
export async function loadState(): Promise<void> {
	snapshot = await invoke<Record<string, unknown>>('state_snapshot');
	const me = getCurrentWindow().label;
	void listen<{ from: string; key: string; value: unknown }>('state-changed', (event) => {
		if (event.payload.from === me) return;
		const next = { ...snapshot };
		if (event.payload.value === null || event.payload.value === undefined) delete next[event.payload.key]; else next[event.payload.key] = event.payload.value;
		snapshot = next;
		for (const fn of listeners) fn(event.payload.key);
	});
}
