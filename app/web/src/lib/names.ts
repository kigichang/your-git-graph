// Short forms the interface shows: a path's last part, a commit's abbreviated hash.

/** The last part of a path, trailing slashes ignored ("/r/repo/" → "repo"). */
export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;

/** A commit's hash as the interface shows it: its first 8 characters. */
export const shortHash = (hash: string): string => hash.slice(0, 8);
