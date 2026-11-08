// The graph window's entry point: the app, and the built-in self-test when GG_SELFTEST=1.
import './lib/csp';
import { mount } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import App from './App.svelte';

mount(App, { target: document.body });

invoke<string | null>('preview').then(async (scenes) => {
	if (scenes) {
		const { runPreview } = await import('./preview');
		await runPreview(scenes);
	}
}, () => {});

invoke<unknown>('self_test').then(async (config) => {
	if (config !== null) {
		const { selfTest } = await import('./selftest');
		await selfTest(config as Record<string, unknown>);
	}
}, () => {});
