/* Bundle the diff window (app/diff/main.js + Monaco's ESM build) into app/web/public/diff-dist/.
 * Monaco 0.53+ supports only bundled ESM; its language services (TypeScript, CSS, HTML, JSON
 * workers) are left out - the window needs syntax colouring, not IntelliSense. Two more
 * bundles hold what only the Markdown preview needs (diff/preview.js, diff/mermaid.js). */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildDiff() {
	const outdir = path.join(appDir, 'web', 'public', 'diff-dist');
	fs.rmSync(outdir, { recursive: true, force: true });
	await esbuild.build({
		absWorkingDir: appDir,
		entryPoints: {
			diff: 'diff/main.js',
			'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
			// The Markdown preview of the file view, loaded when a file needs it: the renderer
			// (with KaTeX's styles), and Mermaid for documents with such diagrams.
			preview: 'diff/preview.js',
			mermaid: 'diff/mermaid.js'
		},
		outdir,
		bundle: true,
		format: 'iife',
		minify: true,
		// KaTeX lists each font as woff2, woff and ttf: WebKit takes the first, the others stay out.
		loader: { '.ttf': 'file', '.woff2': 'file' },
		external: ['*.woff', 'fonts/KaTeX_*.ttf'],
		legalComments: 'linked',
		logLevel: 'warning'
	});
	const size = fs.readdirSync(outdir).reduce((sum, f) => sum + fs.statSync(path.join(outdir, f)).size, 0);
	console.log('diff window bundled in ' + outdir + ' (' + (size / 1024 / 1024).toFixed(1) + ' MB)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildDiff();
