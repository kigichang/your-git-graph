<script lang="ts">
	// The settings (⌘,): every setting of settings.json by group, each change written at once
	// (Rust refuses an invalid value and says why); the author identities; the shown
	// repository's remotes and user details (operations); the file and the log.
	import { invoke } from '@tauri-apps/api/core';
	import { settings, setSetting, type Settings } from '../settings.svelte';
	import type { Author, OpRequest, RepoConfig } from '../api/client';
	import type { DialogSpec } from '../dialogs';
	import { errorText } from '../errors';
	import { t, type Key } from '../i18n';

	let { repo, remoteRepo, config, onClose, onOperate, onDialog, onExport }: {
		repo: string | null; remoteRepo: boolean; config: RepoConfig | null;
		onClose: () => void;
		/** Export Repository Configuration: the path written, or null when the file is there already. */
		onExport: () => Promise<string | null>;
		onOperate: (request: OpRequest) => Promise<boolean>;
		onDialog: (spec: DialogSpec<unknown>, onDone: (built: unknown) => void) => void;
	} = $props();

	type Row = { key: string; label: Key; kind: 'checkbox' | 'number' | 'select' | 'text'; options?: { value: string; label: Key }[]; min?: number; max?: number };
	const GROUPS: { title: Key; rows: Row[] }[] = [
		{ title: 'settings.general', rows: [
			{ key: 'language', label: 'settings.language', kind: 'select', options: [{ value: 'auto', label: 'value.auto' }, { value: 'en', label: 'value.en' }, { value: 'zh-TW', label: 'value.zhTW' }] },
			{ key: 'commits.dateFormat', label: 'settings.commits.dateFormat', kind: 'select', options: [{ value: 'date-time', label: 'value.dateTime' }, { value: 'date', label: 'value.dateOnly' }, { value: 'iso-date-time', label: 'value.isoDateTime' }, { value: 'iso-date', label: 'value.isoDate' }, { value: 'relative', label: 'value.relative' }] },
			{ key: 'commits.dateType', label: 'settings.commits.dateType', kind: 'select', options: [{ value: 'author', label: 'value.authorDate' }, { value: 'commit', label: 'value.commitDate' }] }
		] },
		{ title: 'settings.graph', rows: [
			{ key: 'graph.style', label: 'settings.graph.style', kind: 'select', options: [{ value: 'rounded', label: 'value.rounded' }, { value: 'angular', label: 'value.angular' }] },
			{ key: 'graph.rowHeight', label: 'settings.graph.rowHeight', kind: 'number', min: 16, max: 48 },
			{ key: 'graph.fontSize', label: 'settings.graph.fontSize', kind: 'number', min: 8, max: 24 },
			{ key: 'graph.combineLocalAndRemoteLabels', label: 'settings.graph.combine', kind: 'checkbox' },
			{ key: 'graph.stickyHeader', label: 'settings.graph.stickyHeader', kind: 'checkbox' }
		] },
		{ title: 'settings.commits', rows: [
			{ key: 'commits.initialLoad', label: 'settings.commits.initialLoad', kind: 'number', min: 1, max: 100000 },
			{ key: 'commits.loadMore', label: 'settings.commits.loadMore', kind: 'number', min: 1, max: 100000 },
			{ key: 'commits.loadMoreAutomatically', label: 'settings.commits.loadMoreAutomatically', kind: 'checkbox' },
			{ key: 'commits.order', label: 'settings.commits.order', kind: 'select', options: [{ value: 'date', label: 'value.date' }, { value: 'author-date', label: 'value.authorDate' }, { value: 'topo', label: 'value.topo' }] },
			{ key: 'commits.showUncommitted', label: 'settings.commits.showUncommitted', kind: 'checkbox' },
			{ key: 'commits.showUntracked', label: 'settings.commits.showUntracked', kind: 'checkbox' },
			{ key: 'commits.includeReflog', label: 'settings.commits.includeReflog', kind: 'checkbox' },
			{ key: 'commits.markdown', label: 'settings.commits.markdown', kind: 'checkbox' }
		] },
		{ title: 'settings.repository', rows: [
			{ key: 'repository.showRemoteBranches', label: 'settings.repository.showRemoteBranches', kind: 'checkbox' },
			{ key: 'repository.showRemoteHeads', label: 'settings.repository.showRemoteHeads', kind: 'checkbox' },
			{ key: 'repository.fetchAndPrune', label: 'settings.repository.fetchAndPrune', kind: 'checkbox' },
			{ key: 'repository.fetchAndPruneTags', label: 'settings.repository.fetchAndPruneTags', kind: 'checkbox' }
		] },
		{ title: 'settings.details', rows: [
			{ key: 'details.location', label: 'settings.details.location', kind: 'select', options: [{ value: 'bottom', label: 'value.bottom' }, { value: 'inline', label: 'value.inline' }] },
			{ key: 'details.fileView', label: 'settings.details.fileView', kind: 'select', options: [{ value: 'tree', label: 'value.tree' }, { value: 'list', label: 'value.list' }] },
			{ key: 'details.compactFolders', label: 'settings.details.compactFolders', kind: 'checkbox' },
			{ key: 'details.autoCenter', label: 'settings.details.autoCenter', kind: 'checkbox' }
		] },
		{ title: 'settings.advanced', rows: [
			{ key: 'plantuml.jar', label: 'settings.plantumlJar', kind: 'text' },
			{ key: 'log.enabled', label: 'settings.logEnabled', kind: 'checkbox' }
		] }
	];

	/** The value of a dotted key in the typed settings. */
	export function valueOf(s: Settings, key: string): unknown {
		switch (key) {
			case 'language': return s.language;
			case 'plantuml.jar': return s.plantumlJar ?? '';
			case 'log.enabled': return s.logEnabled;
			default: {
				const [group, field] = key.split('.') as [keyof Settings, string];
				return (s[group] as unknown as Record<string, unknown>)[field];
			}
		}
	}

	let errors = $state<Record<string, string>>({});
	async function change(key: string, value: unknown) {
		try {
			await setSetting(key, value === '' ? null : value);
			const next = { ...errors };
			delete next[key];
			errors = next;
		} catch (e) {
			errors = { ...errors, [key]: errorText(e) };
		}
	}

	/* Authors: edited here, written when saved. */
	let authors = $state<Author[]>(settings.current.authors.map((a) => ({ ...a })));
	let authorsError = $state('');
	async function saveAuthors() {
		const previous = settings.current.authors;
		const next = authors.filter((a) => a.name.trim() !== '' || a.email.trim() !== '').map((a) => ({ name: a.name.trim(), email: a.email.trim() }));
		try {
			await setSetting('authors', next);
			authorsError = '';
			if (repo !== null && !remoteRepo) await onOperate({ kind: 'syncGlobalAuthor', previous, next });
		} catch (e) {
			authorsError = errorText(e);
		}
	}

	/* Remotes and user details: dialogs over the shown repository's configuration. */
	function remoteDialog(existing: { name: string; url: string | null; pushUrl: string | null } | null) {
		const spec: DialogSpec<OpRequest> = {
			title: existing ? t('settings.remote.editTitle', { name: existing.name }) : t('settings.remote.addTitle'),
			action: existing ? t('dialog.editMessage.action') : t('settings.remote.add').replace('…', ''),
			fields: [
				{ kind: 'text', id: 'name', label: t('settings.remote.name'), value: existing?.name ?? '', refName: true },
				{ kind: 'text', id: 'url', label: t('settings.remote.url'), value: existing?.url ?? '' },
				{ kind: 'text', id: 'pushUrl', label: t('settings.remote.pushUrl'), value: existing?.pushUrl ?? '' },
				...(existing ? [] : [{ kind: 'checkbox', id: 'fetch', label: t('settings.remote.fetchNow'), value: true } as const])
			],
			build: (v) => {
				const name = String(v['name'] ?? '').trim(), url = String(v['url'] ?? '').trim(), pushUrl = String(v['pushUrl'] ?? '').trim();
				if (name === '') return { error: t('settings.remote.name') + '?' };
				if (url === '') return { error: t('settings.remote.url') + '?' };
				if (existing) return { kind: 'editRemote', nameOld: existing.name, nameNew: name, urlOld: existing.url, urlNew: url, pushUrlOld: existing.pushUrl, pushUrlNew: pushUrl === '' ? null : pushUrl };
				return { kind: 'addRemote', name, url, pushUrl: pushUrl === '' ? null : pushUrl, fetch: v['fetch'] === true };
			}
		};
		onDialog(spec as DialogSpec<unknown>, (built) => { void onOperate(built as OpRequest); });
	}
	function deleteRemoteDialog(name: string) {
		const spec: DialogSpec<OpRequest> = { title: t('settings.remote.deleteTitle', { name }), action: t('settings.remote.delete'), danger: true, fields: [{ kind: 'info', text: t('settings.remote.deleteInfo') }], build: () => ({ kind: 'deleteRemote', name }) };
		onDialog(spec as DialogSpec<unknown>, (built) => { void onOperate(built as OpRequest); });
	}
	function userDialog(where: 'local' | 'global') {
		const current = where === 'local' ? { name: config?.userName.local ?? '', email: config?.userEmail.local ?? '' } : { name: config?.userName.global ?? '', email: config?.userEmail.global ?? '' };
		const spec: DialogSpec<OpRequest> = {
			title: t('settings.user.editTitle', { where: t(where === 'local' ? 'settings.user.local' : 'settings.user.global') }), action: t('dialog.editMessage.action'),
			fields: [
				{ kind: 'text', id: 'name', label: t('settings.user.name'), value: current.name },
				{ kind: 'text', id: 'email', label: t('settings.user.email'), value: current.email },
				...(where === 'global' ? [{ kind: 'checkbox', id: 'deleteLocal', label: t('settings.user.deleteLocal'), value: false } as const] : [])
			],
			build: (v) => {
				const name = String(v['name'] ?? '').trim(), email = String(v['email'] ?? '').trim();
				if (name === '' || email === '') return { error: t('settings.user.name') + ' / ' + t('settings.user.email') + '?' };
				return { kind: 'editUserDetails', name, email, location: where, deleteLocalName: v['deleteLocal'] === true, deleteLocalEmail: v['deleteLocal'] === true };
			}
		};
		onDialog(spec as DialogSpec<unknown>, (built) => { void onOperate(built as OpRequest); });
	}
	function deleteUserDialog(where: 'local' | 'global') {
		const spec: DialogSpec<OpRequest> = {
			title: t('settings.user.deleteTitle', { where: t(where === 'local' ? 'settings.user.local' : 'settings.user.global') }), action: t('settings.user.delete'), danger: true,
			fields: [{ kind: 'checkbox', id: 'name', label: t('settings.user.deleteName'), value: true }, { kind: 'checkbox', id: 'email', label: t('settings.user.deleteEmail'), value: true }],
			build: (v) => ({ kind: 'deleteUserDetails', name: v['name'] === true, email: v['email'] === true, location: where })
		};
		onDialog(spec as DialogSpec<unknown>, (built) => { void onOperate(built as OpRequest); });
	}

	let exportNote = $state('');
	let exportFailed = $state(false);
	async function exportConfig() {
		exportNote = '';
		try {
			const path = await onExport();
			exportFailed = path === null;
			exportNote = path === null ? t('settings.repoConfig.exists') : t('settings.repoConfig.done', { path });
		} catch (e) {
			exportFailed = true;
			exportNote = errorText(e);
		}
	}

	const openFile = (command: 'open_settings_file' | 'open_session_log') => invoke(command).catch(() => {});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && !(e.target as Element).closest('.gg-backdrop ~ *')) { onClose(); e.stopPropagation(); }
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="gg-settings" role="dialog" aria-modal="false" aria-label={t('settings.title')}>
	<div class="gg-head">
		<h2>{t('settings.title')}</h2>
		<button class="gg-link" onclick={() => openFile('open_settings_file')}>{t('settings.openFile')}</button>
		<button class="gg-link" onclick={() => openFile('open_session_log')}>{t('settings.openLog')}</button>
		<button class="gg-close" title={t('details.close')} onclick={onClose}>✕</button>
	</div>
	<div class="gg-body">
		{#each GROUPS as group (group.title)}
			<h3>{t(group.title)}</h3>
			{#each group.rows as row (row.key)}
				{@const value = valueOf(settings.current, row.key)}
				<div class="gg-row" class:gg-check={row.kind === 'checkbox'}>
					{#if row.kind === 'checkbox'}
						<label><input type="checkbox" checked={value === true} onchange={(e) => change(row.key, (e.target as HTMLInputElement).checked)} /> {t(row.label)}</label>
					{:else if row.kind === 'number'}
						<label><span>{t(row.label)}</span><input type="number" min={row.min} max={row.max} value={value as number} onchange={(e) => change(row.key, Number((e.target as HTMLInputElement).value))} /></label>
					{:else if row.kind === 'select'}
						<label><span>{t(row.label)}</span>
							<select value={value as string} onchange={(e) => change(row.key, (e.target as HTMLSelectElement).value)}>
								{#each row.options ?? [] as o (o.value)}<option value={o.value}>{t(o.label)}</option>{/each}
							</select>
						</label>
					{:else}
						<label><span>{t(row.label)}</span><input type="text" value={value as string} onchange={(e) => change(row.key, (e.target as HTMLInputElement).value.trim())} /></label>
					{/if}
					{#if errors[row.key]}<span class="gg-error">{errors[row.key]}</span>{/if}
				</div>
			{/each}
		{/each}

		<h3>{t('settings.authors')}</h3>
		<p class="gg-hint">{t('settings.authors.hint')}</p>
		{#each authors as author, i (i)}
			<div class="gg-author">
				<input type="text" placeholder={t('settings.user.name')} bind:value={author.name} />
				<input type="text" placeholder={t('settings.user.email')} bind:value={author.email} />
				<button onclick={() => { authors = authors.filter((_, j) => j !== i); }}>{t('settings.authors.remove')}</button>
			</div>
		{/each}
		<div class="gg-buttons">
			<button onclick={() => { authors = [...authors, { name: '', email: '' }]; }}>{t('settings.authors.add')}</button>
			<button class="gg-ok" onclick={saveAuthors}>{t('settings.authors.save')}</button>
			{#if authorsError}<span class="gg-error">{authorsError}</span>{/if}
		</div>

		{#if repo !== null && config !== null}
			<h3>{t('settings.remotes')}</h3>
			{#each config.remotes as remote (remote.name)}
				<div class="gg-remote">
					<span class="gg-remote-name">{remote.name}</span>
					<span class="gg-remote-url" title={remote.pushUrl ? remote.url + ' → ' + remote.pushUrl : remote.url ?? ''}>{remote.url ?? ''}</span>
					<button onclick={() => remoteDialog(remote)}>{t('settings.remote.edit')}</button>
					<button onclick={() => onOperate({ kind: 'pruneRemote', name: remote.name })}>{t('settings.remote.prune')}</button>
					<button class="gg-danger" onclick={() => deleteRemoteDialog(remote.name)}>{t('settings.remote.delete')}</button>
				</div>
			{/each}
			<div class="gg-buttons"><button onclick={() => remoteDialog(null)}>{t('settings.remote.add')}</button></div>

			<h3>{t('settings.repoConfig')}</h3>
			<p class="gg-hint">{t('settings.repoConfig.hint')}</p>
			<div class="gg-buttons">
				<button class="gg-export" onclick={exportConfig}>{t('settings.repoConfig.export')}</button>
				{#if exportNote}<span class={exportFailed ? 'gg-error' : 'gg-note'}>{exportNote}</span>{/if}
			</div>

			<h3>{t('settings.user')}</h3>
			{#each [['local', config.userName.local, config.userEmail.local], ['global', config.userName.global, config.userEmail.global]] as [where, name, email] (where)}
				<div class="gg-remote">
					<span class="gg-remote-name">{t(where === 'local' ? 'settings.user.local' : 'settings.user.global')}</span>
					<span class="gg-remote-url">{name ?? t('settings.user.unset')} &lt;{email ?? t('settings.user.unset')}&gt;</span>
					<button onclick={() => userDialog(where as 'local' | 'global')}>{t('settings.user.edit')}</button>
					<button class="gg-danger" onclick={() => deleteUserDialog(where as 'local' | 'global')}>{t('settings.user.delete')}</button>
				</div>
			{/each}
		{/if}

		{#if settings.ignored.length > 0}
			<p class="gg-hint">{t('settings.ignored', { keys: settings.ignored.map((i) => i.key + ' (' + i.reason + ')').join(', ') })}</p>
		{/if}
	</div>
</div>

<style>
	.gg-settings {
		position: absolute; top: 0; right: 0; bottom: 0; width: min(520px, 100vw); z-index: 60; display: flex; flex-direction: column;
		background: var(--gg-editorWidget-background); color: var(--gg-editorWidget-foreground); border-left: 1px solid var(--gg-editorWidget-border);
		box-shadow: -8px 0 30px var(--gg-widget-shadow);
	}
	.gg-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--gg-panel-border); }
	h2 { margin: 0; flex: 1; font-size: 14px; font-weight: 600; }
	h3 { margin: 18px 0 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--gg-descriptionForeground); }
	.gg-body { flex: 1; overflow: auto; padding: 4px 14px 20px; }
	.gg-row { display: flex; flex-direction: column; gap: 2px; margin: 6px 0; }
	.gg-row label { display: flex; flex-direction: column; gap: 3px; }
	.gg-row.gg-check label { flex-direction: row; align-items: center; gap: 6px; }
	.gg-row span, .gg-hint { font-size: 12px; color: var(--gg-descriptionForeground); }
	input[type=text], input[type=number], select {
		font: inherit; padding: 4px 8px; border-radius: 5px; outline: none;
		background: var(--gg-input-background); color: var(--gg-input-foreground); border: 1px solid var(--gg-input-border);
	}
	input:focus, select:focus { border-color: var(--gg-focusBorder); }
	.gg-error { color: var(--gg-errorForeground) !important; font-size: 12px; }
	.gg-note { color: var(--gg-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
	.gg-hint { margin: 4px 0 8px; }
	.gg-author { display: flex; gap: 6px; margin: 4px 0; }
	.gg-author input { flex: 1; min-width: 0; }
	.gg-remote { display: flex; align-items: center; gap: 8px; margin: 4px 0; white-space: nowrap; }
	.gg-remote-name { font-weight: 600; flex: none; }
	.gg-remote-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--gg-descriptionForeground); }
	.gg-buttons { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
	button { font: inherit; padding: 2px 10px; border-radius: 5px; cursor: pointer; border: 1px solid var(--gg-input-border); background: var(--gg-input-background); color: var(--gg-foreground); }
	.gg-ok { background: var(--gg-button-background); color: var(--gg-button-foreground); border-color: transparent; }
	.gg-danger { color: var(--gg-errorForeground); }
	.gg-link { border: none; background: none; color: var(--gg-textLink-foreground); padding: 0 4px; }
	.gg-close { border: none; background: none; color: var(--gg-descriptionForeground); }
</style>
