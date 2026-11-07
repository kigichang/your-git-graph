// The files of a commit as a tree of folders (the details panel's file tree). Pure; tested in
// filetree.test.ts.
import type { FileChange } from './api/client';

export type FileNode = { kind: 'file'; name: string; path: string; change: FileChange };
export type FolderNode = { kind: 'folder'; name: string; path: string; children: TreeNode[] };
export type TreeNode = FileNode | FolderNode;

/** The tree of `files` (by their new path). With `compact`, a folder holding one folder and
 * nothing else is shown as one entry, `a/b/c`. Folders come before files; both sorted by name. */
export function buildTree(files: FileChange[], compact = true): TreeNode[] {
	const root: FolderNode = { kind: 'folder', name: '', path: '', children: [] };
	for (const change of files) {
		const parts = change.newPath.split('/');
		let folder = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const name = parts[i] as string;
			let next = folder.children.find((c): c is FolderNode => c.kind === 'folder' && c.name === name);
			if (next === undefined) {
				next = { kind: 'folder', name, path: parts.slice(0, i + 1).join('/'), children: [] };
				folder.children.push(next);
			}
			folder = next;
		}
		folder.children.push({ kind: 'file', name: parts[parts.length - 1] as string, path: change.newPath, change });
	}
	const sort = (nodes: TreeNode[]) => {
		nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
		for (const n of nodes) if (n.kind === 'folder') sort(n.children);
	};
	sort(root.children);
	return compact ? root.children.map(compacted) : root.children;
}

function compacted(node: TreeNode): TreeNode {
	if (node.kind !== 'folder') return node;
	let folder = node;
	while (folder.children.length === 1 && folder.children[0]?.kind === 'folder') {
		const only = folder.children[0] as FolderNode;
		folder = { kind: 'folder', name: folder.name + '/' + only.name, path: only.path, children: only.children };
	}
	return { ...folder, children: folder.children.map(compacted) };
}

/** Every folder path of the tree, to start with all of them open. */
export function folderPaths(nodes: TreeNode[]): string[] {
	const out: string[] = [];
	const walk = (list: TreeNode[]) => { for (const n of list) if (n.kind === 'folder') { out.push(n.path); walk(n.children); } };
	walk(nodes);
	return out;
}

/** `+a −d` of a change, or '' while not counted; a binary file is 'binary'. */
export function countsText(change: FileChange): string {
	if (change.additions === null && change.deletions === null) return '';
	return `+${change.additions ?? 0} −${change.deletions ?? 0}`;
}
