/* Bundle the diff window (app/diff/main.js + Monaco's ESM build) into app/ui/diff-dist/.
 * Monaco 0.53+ supports only bundled ESM; its language services (TypeScript, CSS, HTML, JSON
 * workers) are left out - the window needs syntax colouring, not IntelliSense. */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildDiff() {
	const outdir = path.join(appDir, 'ui', 'diff-dist');
	fs.rmSync(outdir, { recursive: true, force: true });
	await esbuild.build({
		absWorkingDir: appDir,
		entryPoints: {
			diff: 'diff/main.js',
			'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js'
		},
		outdir,
		bundle: true,
		format: 'iife',
		minify: true,
		loader: { '.ttf': 'file' },
		legalComments: 'linked',
		logLevel: 'warning'
	});
	const size = fs.readdirSync(outdir).reduce((sum, f) => sum + fs.statSync(path.join(outdir, f)).size, 0);
	console.log('diff window bundled in ' + outdir + ' (' + (size / 1024 / 1024).toFixed(1) + ' MB)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildDiff();
