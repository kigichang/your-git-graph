// The graph window's entry point: the app, and the built-in self-test when GG_SELFTEST=1.
import './lib/csp';
import { mount } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import App from './App.svelte';

const app = mount(App, { target: document.body });
// The self-test's and the previews' way into the app: not there in an ordinary launch.
const expose = () => {
	(window as unknown as { __gg: unknown }).__gg = { app: app.testHandle() };
};

invoke<string | null>('preview').then(async (scenes) => {
	if (scenes) {
		expose();
		const { runPreview } = await import('./preview');
		await runPreview(scenes);
	}
}, () => {});

invoke<unknown>('self_test').then(async (config) => {
	if (config !== null) {
		expose();
		const { selfTest } = await import('./selftest');
		await selfTest(config as Record<string, unknown>);
	}
}, () => {});
