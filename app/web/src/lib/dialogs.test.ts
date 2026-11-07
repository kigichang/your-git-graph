import { test, expect } from 'vitest';
import { dialogFor, substituteSpaces, isStreamed, type Values } from './dialogs';
import { DEFAULT_SETTINGS } from './settings.svelte';
import type { Commit } from './api/client';
import type { MenuTarget } from './menus';

const commit: Commit = { hash: 'c'.repeat(40), parents: ['a'.repeat(40)], author: 'A', email: 'a@x', date: 0, message: 'subject', heads: [], tags: [], remotes: [], stash: null };
const merge: Commit = { ...commit, hash: 'm'.repeat(40), parents: ['a'.repeat(40), 'b'.repeat(40)] };
const ctx = { settings: DEFAULT_SETTINGS, remotes: ['origin', 'up'], currentBranch: 'main', details: null };
const withDefaults = (dialogs: Record<string, unknown>) => ({ ...ctx, settings: { ...DEFAULT_SETTINGS, dialogs } });

/** The spec's answers as typed, over its defaults. */
function answers(spec: NonNullable<ReturnType<typeof dialogFor>>, typed: Values = {}): Values {
	const v: Values = {};
	for (const f of spec.fields) if (f.kind !== 'info') v[f.id] = f.value;
	return { ...v, ...typed };
}

test('create branch: a name is required; the checkout default comes from the settings', () => {
	const spec = dialogFor('createBranch', { kind: 'commit', commit, isHead: false }, ctx)!;
	expect(spec.build(answers(spec))).toEqual({ error: 'Name?' });
	expect(spec.build(answers(spec, { name: ' feat ' }))).toEqual({ kind: 'createBranch', branch: 'feat', commit: commit.hash, checkout: false, force: false });
	const ticked = dialogFor('createBranch', { kind: 'commit', commit, isHead: false }, withDefaults({ 'createBranch.checkout': true }))!;
	expect(answers(ticked).checkout).toBe(true);
});

test('push and fetch name remotes; fetch all is the empty choice', () => {
	const push = dialogFor('push', { kind: 'branch', name: 'main', commit, current: true }, ctx)!;
	expect(push.build(answers(push, { mode: 'force-with-lease' }))).toEqual({ kind: 'push', branch: 'main', remotes: ['origin'], setUpstream: true, mode: 'force-with-lease' });
	const fetch = dialogFor('fetch', { kind: 'background' }, ctx)!;
	expect(fetch.build(answers(fetch))).toEqual({ kind: 'fetch', remote: null, prune: false, pruneTags: false });
	expect(fetch.build(answers(fetch, { remote: 'up', prune: true }))).toEqual({ kind: 'fetch', remote: 'up', prune: true, pruneTags: false });
	expect(isStreamed({ kind: 'fetch', remote: null, prune: false, pruneTags: false })).toBe(true);
	expect(isStreamed({ kind: 'createBranch', branch: 'b', commit: 'c', checkout: false, force: false })).toBe(false);
});

test('remote branches: checkout as local, pull, delete; without a known remote there is no dialog', () => {
	const target: MenuTarget = { kind: 'remoteBranch', name: 'origin/feature/x', remote: 'origin', commit };
	const checkout = dialogFor('checkoutRemoteBranch', target, ctx)!;
	expect(answers(checkout).name).toBe('feature/x');
	expect(checkout.build(answers(checkout))).toEqual({ kind: 'checkoutBranch', branch: 'feature/x', remoteBranch: 'origin/feature/x', pullAfterwards: null });
	const pull = dialogFor('pull', target, ctx)!;
	expect(pull.build(answers(pull, { squash: true }))).toEqual({ kind: 'pull', remote: 'origin', branch: 'feature/x', noFastForward: false, squash: true });
	expect(dialogFor('deleteRemoteBranch', target, ctx)!.build({})).toEqual({ kind: 'deleteRemoteBranch', remote: 'origin', branch: 'feature/x' });
	expect(dialogFor('pull', { ...target, remote: null }, ctx)).toBe(null);
});

test('cherry pick and revert ask for the mainline parent of a merge only', () => {
	const plain = dialogFor('cherryPick', { kind: 'commit', commit, isHead: false }, ctx)!;
	expect(plain.fields.map((f) => f.kind)).toEqual(['checkbox', 'checkbox']);
	expect(plain.build(answers(plain, { recordOrigin: true }))).toEqual({ kind: 'cherryPick', commit: commit.hash, parentIndex: 0, recordOrigin: true, noCommit: false });
	const ofMerge = dialogFor('revert', { kind: 'commit', commit: merge, isHead: false }, ctx)!;
	expect(ofMerge.fields[0]?.kind).toBe('select');
	expect(ofMerge.build(answers(ofMerge, { parent: '2' }))).toEqual({ kind: 'revert', commit: merge.hash, parentIndex: 2 });
});

test('reset, tags, stashes and the message editor', () => {
	const reset = dialogFor('resetTo', { kind: 'commit', commit, isHead: false }, withDefaults({ 'reset.mode': 'hard' }))!;
	expect(reset.build(answers(reset))).toEqual({ kind: 'reset', commit: commit.hash, mode: 'hard' });
	const tag = dialogFor('addTag', { kind: 'commit', commit, isHead: false }, ctx)!;
	expect(tag.build(answers(tag, { name: 'v1', kind: 'lightweight', pushTo: 'origin' }))).toEqual({ kind: 'addTag', tag: 'v1', commit: commit.hash, tagKind: 'lightweight', message: '', force: false, pushTo: 'origin' });
	const stash = dialogFor('applyStash', { kind: 'stash', selector: 'stash@{1}', commit }, ctx)!;
	expect(stash.build(answers(stash, { index: true }))).toEqual({ kind: 'stashApply', selector: 'stash@{1}', reinstateIndex: true });
	const details = { hash: commit.hash, parents: commit.parents, author: 'A', authorEmail: 'a@x', authorDate: 0, committer: 'A', committerEmail: 'a@x', committerDate: 0, body: 'subject\n\nbody\n', files: [] };
	const edit = dialogFor('editMessage', { kind: 'commit', commit, isHead: true }, { ...ctx, details })!;
	expect(answers(edit).message).toBe('subject\n\nbody\n');
	expect(edit.build(answers(edit, { message: 'new\n\n' }))).toEqual({ kind: 'editCommitMessage', commit: commit.hash, message: 'new', author: null });
	expect(edit.build(answers(edit, { authorName: 'B' }))).toMatchObject({ author: { name: 'B', email: 'a@x' } });
});

test('spaces in reference names follow the setting', () => {
	expect(substituteSpaces(DEFAULT_SETTINGS, 'a b')).toBe('a b');
	expect(substituteSpaces({ ...DEFAULT_SETTINGS, dialogs: { 'general.spaceSubstitution': 'hyphen' } }, 'a  b c')).toBe('a-b-c');
	expect(substituteSpaces({ ...DEFAULT_SETTINGS, dialogs: { 'general.spaceSubstitution': 'underscore' } }, 'a b')).toBe('a_b');
});
