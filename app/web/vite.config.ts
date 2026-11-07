// The front end (Svelte 5 + TypeScript), built by Vite into web/dist/, which Tauri embeds.
// Two pages: index.html (the graph windows) and diff.html (the diff windows; its script is the
// esbuild bundle in public/diff-dist/, see scripts/build-diff.mjs). `npm run dev` serves them
// for `cargo tauri dev`.
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	root: here('.'),
	cacheDir: here('../node_modules/.vite'), // not under web/ (the Vite root)
	plugins: [svelte()],
	clearScreen: false,
	server: { port: 1420, strictPort: true },
	build: {
		outDir: here('dist'),
		emptyOutDir: true,
		target: 'safari16',
		rollupOptions: { input: { index: here('index.html'), diff: here('diff.html') } }
	},
	test: {
		include: ['src/**/*.test.ts', '../diff/**/*.test.ts'],
		environment: 'node'
	}
});
