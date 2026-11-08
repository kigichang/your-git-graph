import { test, expect } from 'vitest';
import { buildTree, flatFiles, folderPaths, lineCounts } from './filetree';
import type { FileChange } from './api/client';

const change = (path: string, status: FileChange['status'] = 'M'): FileChange => ({ oldPath: path, newPath: path, status, additions: null, deletions: null });

const shape = (nodes: ReturnType<typeof buildTree>): unknown =>
	nodes.map((n) => (n.kind === 'folder' ? { [n.name]: shape(n.children) } : n.name));

test('files group into folders, folders first, sorted', () => {
	const tree = buildTree([change('src/b.ts'), change('README'), change('src/a.ts'), change('docs/x/y.md'), change('src/lib/z.ts')], false);
	expect(shape(tree)).toEqual([{ docs: [{ x: ['y.md'] }] }, { src: [{ lib: ['z.ts'] }, 'a.ts', 'b.ts'] }, 'README']);
	expect(folderPaths(tree)).toEqual(['docs', 'docs/x', 'src', 'src/lib']);
});

test('a folder holding only one folder is shown as one entry', () => {
	const tree = buildTree([change('a/b/c/file'), change('a/b/other'), change('d/e/f')]);
	expect(shape(tree)).toEqual([{ 'a/b': [{ c: ['file'] }, 'other'] }, { 'd/e': ['f'] }]);
	expect(folderPaths(tree)).toEqual(['a/b', 'a/b/c', 'd/e']);
});

test('the flat list keeps the files of a folder together, folders first', () => {
	const paths = ['src/engine.rs', 'src/export/mod.rs', 'README', 'src-tauri/lib.rs', 'src/ffmpeg/mod.rs', 'crates/main.rs'];
	expect(flatFiles(paths.map((p) => change(p))).map((f) => f.newPath)).toEqual(['crates/main.rs', 'src/export/mod.rs', 'src/ffmpeg/mod.rs', 'src/engine.rs', 'src-tauri/lib.rs', 'README']);
});

test('the line counts', () => {
	expect(lineCounts(change('f'))).toBe(null);
	expect(lineCounts({ ...change('f'), additions: 3, deletions: 0 })).toEqual({ added: 3, removed: 0 });
	expect(lineCounts({ ...change('f'), additions: null, deletions: 2 })).toEqual({ added: 0, removed: 2 });
});
