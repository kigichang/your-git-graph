/* Write THIRD-PARTY.md (repository root): what the app bundles besides its own code, with each
 * part's licence - the engine, the Rust crates linked into the app and the remote helper
 * (cargo metadata), the npm packages bundled into the diff window (esbuild's metafile) and into
 * the graph window (what web/src imports) - followed by the licence texts themselves (the
 * copyright and permission notices that MIT, BSD, Apache-2.0 and the others ask to go with every
 * copy): each package's own licence file for the licence the app takes, or, for a package that
 * ships none, the licence's standard text in the name of the authors its manifest gives.
 * Identical texts are printed once. Run after changing a dependency; build-app.sh runs it and
 * reports when the file changed.
 *   node app/scripts/third-party.mjs */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiff } from './build-diff.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.dirname(appDir);
const ENGINE = 'git-graph-core';
const vendorDir = path.join(rootDir, 'vendor', 'vscode-git-graph-rs');

/** The crates linked into the workspace's binaries (normal dependencies, transitively). */
function crates() {
	const out = spawnSync('cargo', ['metadata', '--format-version', '1'], { cwd: path.join(appDir, 'src-tauri'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	if (out.status !== 0) throw new Error('cargo metadata failed: ' + out.stderr);
	const meta = JSON.parse(out.stdout);
	const members = new Set(meta.workspace_members);
	const byId = new Map(meta.packages.map((p) => [p.id, p]));
	const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
	const seen = new Set();
	const stack = [...members];
	while (stack.length > 0) {
		const id = stack.pop();
		if (seen.has(id)) continue;
		seen.add(id);
		for (const dep of nodes.get(id).deps) {
			if (dep.dep_kinds.some((k) => k.kind === null || k.kind === 'normal')) stack.push(dep.pkg);
		}
	}
	return Array.from(seen)
		.filter((id) => !members.has(id))
		.map((id) => byId.get(id))
		.map((p) => ({ name: p.name, version: p.version, license: p.license ?? (p.license_file ? 'see ' + p.license_file : '?'), repository: p.repository ?? '', dir: path.dirname(p.manifest_path), authors: p.authors ?? [] }))
		.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The packages web/src imports (the graph window's bundle, built by Vite). */
function webPackages() {
	const names = new Set();
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (/\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
				for (const m of fs.readFileSync(file, 'utf8').matchAll(/from\s+'((?:@[^/']+\/)?[^./'][^/']*)/g)) names.add(m[1]);
			}
		}
	};
	walk(path.join(appDir, 'web', 'src'));
	names.add('svelte'); // the compiled components run on its runtime
	return Array.from(names).filter((n) => fs.existsSync(path.join(appDir, 'node_modules', n, 'package.json'))).sort();
}

/** Packages whose package.json names no licence: what their licence file says. */
const LICENCE_FILES = { khroma: 'MIT' };

function npmPackage(name) {
	const p = JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', name, 'package.json'), 'utf8'));
	let repository = typeof p.repository === 'string' ? p.repository : p.repository?.url ?? '';
	repository = repository.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^git@github\.com:/, 'https://github.com/').replace(/^github:/, 'https://github.com/').replace(/\.git$/, '');
	if (/^[\w.-]+\/[\w.-]+$/.test(repository)) repository = 'https://github.com/' + repository;
	const license = typeof p.license === 'string' ? p.license : p.licenses?.map((l) => l.type).join(' OR ') ?? LICENCE_FILES[name] ?? '?';
	const author = typeof p.author === 'string' ? p.author : p.author?.name;
	return { name, version: p.version, license, repository, dir: path.join(appDir, 'node_modules', name), authors: author ? [author] : [] };
}

/* ---------- The licence texts ---------- */

/** The licence the app takes of an SPDX expression, per part joined by AND: MIT when offered,
 * else Apache-2.0, else the first alternative. */
function chosen(expression) {
	const parts = expression.replace(/[()]/g, ' ').split(/\s+AND\s+/);
	return parts.map((part) => {
		const ids = part.split(/\s+OR\s+|\//).map((s) => s.trim()).filter(Boolean);
		return ids.find((id) => id === 'MIT') ?? ids.find((id) => id.startsWith('Apache-2.0')) ?? ids[0];
	}).filter(Boolean);
}

/** How to recognise a licence's file: by its name, or by what a generic LICENSE file says. */
const KINDS = [
	{ id: /^MIT/, name: /mit/i, says: /Permission is hereby granted, free of charge/i },
	{ id: /^Apache-2\.0/, name: /apache/i, says: /Apache License/i },
	{ id: /^BSD-/, name: /bsd/i, says: /Redistribution and use in source and binary forms/i },
	{ id: /^0BSD/, name: /0bsd/i, says: /Permission to use, copy, modify, and\/or distribute/i },
	{ id: /^ISC/, name: /isc/i, says: /Permission to use, copy, modify, and\/or distribute/i },
	{ id: /^Zlib/, name: /zlib/i, says: /provided 'as-is'/i },
	{ id: /^Unicode/, name: /unicode/i, says: /UNICODE/ },
	{ id: /^MPL-2\.0/, name: /mpl/i, says: /Mozilla Public License/i },
	{ id: /^Unlicense/, name: /unlicense/i, says: /free and unencumbered/i },
	{ id: /^CC0/, name: /cc0/i, says: /CC0/ },
	{ id: /^BSL-1\.0/, name: /bsl|boost/i, says: /Boost Software License/i }
];
const GENERIC = /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i;
const LICENCE_FILE = /^(LICEN[CS]E|COPYING|UNLICENSE|NOTICE)/i;

/** The standard texts for packages that ship no licence file of their own. */
const MIT_TEXT = fs.readFileSync(path.join(rootDir, 'LICENSE'), 'utf8').split(/^-{5,}$/m)[0].replace(/^Copyright .*$/m, 'Copyright (c) {authors}').trim();
const APACHE_TEXT = fs.readFileSync(path.join(vendorDir, 'licenses', 'LICENSE-APACHE'), 'utf8').trim();
const BSD3_TEXT = `Copyright (c) {authors}

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions
   and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of
   conditions and the following disclaimer in the documentation and/or other materials provided
   with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to
   endorse or promote products derived from this software without specific prior written
   permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

/** A licence's file among `dir`'s, for licence `id`; null when there is none. */
function fileFor(dir, files, id, single) {
	const kind = KINDS.find((k) => k.id.test(id));
	if (kind) {
		const named = files.find((f) => kind.name.test(f) && !GENERIC.test(f));
		if (named) return named;
		// A file that says it: a generic one first (LICENSE), then any (encoding_rs's LICENSE-WHATWG is BSD).
		const says = (f) => kind.says.test(fs.readFileSync(path.join(dir, f), 'utf8'));
		const generic = files.find((f) => GENERIC.test(f) && says(f)) ?? files.find((f) => !/^NOTICE/i.test(f) && says(f));
		if (generic) return generic;
	}
	// A package under one licence with one licence file: that file.
	const generic = files.filter((f) => GENERIC.test(f));
	return single && generic.length === 1 ? generic[0] : null;
}

/** The texts that go with package `p`: [heading, text] pairs. */
function textsOf(p, texts) {
	const files = fs.existsSync(p.dir) ? fs.readdirSync(p.dir).filter((f) => LICENCE_FILE.test(f) && fs.statSync(path.join(p.dir, f)).isFile()) : [];
	const ids = chosen(p.license);
	const out = [];
	for (const id of ids) {
		const file = fileFor(p.dir, files, id, ids.length === 1);
		if (file) { out.push([id, fs.readFileSync(path.join(p.dir, file), 'utf8')]); continue; }
		const authors = p.authors.map((a) => a.replace(/\s*<[^>]*>/, '')).join(', ') || `the ${p.name} authors`;
		const standard = /^MIT/.test(id) ? MIT_TEXT.replace('{authors}', authors)
			: /^Apache-2\.0/.test(id) ? APACHE_TEXT
			: /^BSD-3-Clause/.test(id) ? BSD3_TEXT.replace('{authors}', authors)
			: texts.find((t) => t.id === id)?.text; // another package's copy of the same licence
		if (!standard) throw new Error(`${p.name} ${p.version}: no licence text for ${id} (files: ${files.join(', ') || 'none'})`);
		out.push([id + ' (standard text; the package ships none)', standard]);
	}
	// Apache-2.0 asks for the NOTICE file to go along.
	if (ids.some((id) => /^Apache/.test(id))) for (const f of files.filter((f) => /^NOTICE/i.test(f))) out.push(['NOTICE', fs.readFileSync(path.join(p.dir, f), 'utf8')]);
	return out;
}

/** `text` in a code block whose fence no line of it can close. */
function fenced(text) {
	const longest = Math.max(0, ...Array.from(text.matchAll(/^\s*(~+)/gm), (m) => m[1].length));
	const fence = '~'.repeat(Math.max(3, longest + 1));
	return `${fence}text\n${text}\n${fence}`;
}

/** Every package's texts, the same text printed once with all its packages. */
function licenceTexts(packages) {
	const texts = []; // { id, text, key, users }
	const byKey = new Map();
	// Packages with their own files first, so a package without can borrow a copy of the licence.
	const pending = [];
	for (const p of packages) {
		try {
			for (const [id, raw] of textsOf(p, [])) add(id, raw, p);
		} catch {
			pending.push(p);
		}
	}
	for (const p of pending) for (const [id, raw] of textsOf(p, texts)) add(id, raw, p);
	function add(id, raw, p) {
		const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
		const key = text.replace(/\s+/g, ' ');
		let entry = byKey.get(key);
		if (!entry) { entry = { id: id.replace(/ \(.*$/, ''), heading: id, text, users: [] }; byKey.set(key, entry); texts.push(entry); }
		entry.users.push(`${p.name} ${p.version}`);
	}
	texts.sort((a, b) => a.id.localeCompare(b.id) || b.users.length - a.users.length || a.users[0].localeCompare(b.users[0]));
	return texts.map((t, i) => {
		return `### ${i + 1}. ${t.heading}\n\nUsed by: ${t.users.join(', ')}.\n\n${fenced(t.text)}`;
	}).join('\n\n');
}

/** The engine's grant: the MIT terms its repository's LICENSE gives the original contributions
 * (./native/), and the MIT text of its licenses/ directory. */
function engineNotice() {
	const license = fs.readFileSync(path.join(vendorDir, 'LICENSE'), 'utf8');
	const copyright = license.match(/^Copyright \(c\) .*$/m)?.[0];
	const grant = license.match(/Permission is hereby granted[\s\S]*?SOFTWARE\.\n/)?.[0];
	const mit = fs.readFileSync(path.join(vendorDir, 'licenses', 'LICENSE-MIT'), 'utf8').trim();
	if (!copyright || !grant) throw new Error('the engine\'s LICENSE has no MIT grant where expected');
	return { copyright, grant: `${copyright}\n\n${grant.trim()}`, mit, mitCopyright: mit.match(/^Copyright \(c\) .*$/m)?.[0] ?? '' };
}

const link = (url) => (url ? `[${url.replace(/^https?:\/\//, '')}](${url})` : '');
const table = (rows) => ['| Package | Version | Licence | Source |', '|---|---|---|---|', ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${link(r.repository)} |`)].join('\n');

const allCrates = crates();
const engine = allCrates.find((c) => c.name === ENGINE);
const rustCrates = allCrates.filter((c) => c.name !== ENGINE);
const diffPackages = (await buildDiff()).map(npmPackage);
const graphPackages = webPackages().map(npmPackage);
const notice = engineNotice();
const licences = new Set();
for (const r of [...rustCrates, ...diffPackages, ...graphPackages]) for (const l of r.license.split(/\s+(?:OR|AND|\/)\s+|\//).map((s) => s.replace(/[()]/g, '').trim())) if (l) licences.add(l);

const text = `# Third-party notices

Your Git Graph bundles the software below besides its own code (MIT, see [LICENSE](LICENSE)).
Each part keeps its own licence; the identifiers are [SPDX](https://spdx.org/licenses/) ones,
and "A OR B" means the part is offered under either, of which this app takes MIT when offered,
else Apache-2.0. The copyright and licence notices themselves are reproduced at the end
("Licence texts"). Nothing of mhutchie's Git Graph or of the vscode-git-graph-rs extension's own
code is in the app: only the engine below.

This file is generated by \`app/scripts/third-party.mjs\` from the dependency manifests; it is
also copied into the app bundle (\`Contents/Resources\`).

## The engine

| Package | Version | Licence | Source |
|---|---|---|---|
| ${ENGINE} (\`vendor/vscode-git-graph-rs/native/core\`, git submodule) | ${engine?.version ?? '?'} | ${engine?.license ?? 'MIT'} | [github.com/neophack/vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs) |

The engine reads repositories (through gitoxide); the app links it in-process, and the helper for
repositories on other machines does the same there. Its repository's \`LICENSE\` grants the MIT
licence for the original contributions, the engine (\`./native/\`) among them, as
"${notice.copyright}"; the MIT text in its \`licenses/\` directory reads
"${notice.mitCopyright}". Both notices:

${fenced(notice.grant)}

${fenced(notice.mit)}

## Rust crates

Linked into the app (\`git-graph-app\`), the shared core (\`gg-backend\`) and the remote helper
(\`gg-remote\`), as resolved by \`app/src-tauri/Cargo.lock\` (${rustCrates.length} crates, normal
dependencies, all targets).

${table(rustCrates)}

## JavaScript packages: the diff window

Bundled by esbuild into \`diff-dist/\` (\`app/scripts/build-diff.mjs\`): the editor, the Markdown
preview and the diagrams.

${table(diffPackages)}

## JavaScript packages: the graph window

Bundled by Vite from \`app/web/src\`.

${table(graphPackages)}

## Fonts and icons

KaTeX's fonts (part of the katex package above, SIL Open Font License 1.1) are bundled with the
Markdown preview. The app icon is the project's own. Monaco's codicon font is part of
monaco-editor (MIT).

## Source code

Every package is used as published, unmodified; its source is at the repository linked above and
in the published package of the version listed (crates.io, npm). That is where the source of the
packages under MPL-2.0 (cssparser, selectors and the others listed under it below) and EPL-2.0
(elkjs, the diagram layout of the Markdown preview) is to be had, as those licences ask.

## Not bundled

git, ssh and the macOS frameworks the app runs on are the user's; so is the PlantUML jar named in
the settings (GPL/LGPL/MIT editions exist; the app only runs it in a separate process).

Licences seen above: ${Array.from(licences).sort().join(', ')}.

## Licence texts

The notices of the packages above, each as the package ships it for the licence the app takes
(or, for a package that ships none, that licence's standard text in the name of the authors its
manifest gives). A text shared by several packages is printed once.

${licenceTexts([...rustCrates, ...diffPackages, ...graphPackages])}
`;

fs.writeFileSync(path.join(rootDir, 'THIRD-PARTY.md'), text);
console.log(`THIRD-PARTY.md: ${rustCrates.length} crates, ${diffPackages.length} + ${graphPackages.length} npm packages`);
