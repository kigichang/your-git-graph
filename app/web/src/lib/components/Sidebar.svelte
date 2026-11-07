<script lang="ts">
	// The repository sidebar: the repositories added to the app, by group; the one this window
	// shows; dragging to reorder or into a group; ⌘/⇧-click to pick several. The list itself
	// is the window's (state.json); this only draws it and asks for changes.
	import { avatarOf, badgeOf, groupsOf, labelsOf, moveManyToGroup, moveRepo, DEFAULT_GROUP, type SidebarState } from '../sidebar';
	import { t } from '../i18n';

	export type RepoStatus = { missing?: boolean; note?: string; ahead?: number | null; behind?: number | null };
	export type SidebarTarget = { kind: 'repos'; repos: string[] } | { kind: 'group'; name: string } | { kind: 'add' };

	let { sidebar, current, status, onSelect, onChange, onContextMenu, onCollapse }: {
		sidebar: SidebarState; current: string | null; status: Record<string, RepoStatus>;
		onSelect: (repo: string) => void;
		/** The list changed here (an order, a group, a fold): the new sidebar to keep. */
		onChange: (next: SidebarState) => void;
		onContextMenu: (e: MouseEvent, target: SidebarTarget) => void;
		onCollapse: () => void;
	} = $props();

	const sections = $derived(groupsOf(sidebar.repos, sidebar.groups, sidebar.groupOf));
	const labels = $derived(labelsOf(sidebar.repos));
	const folded = (group: string | null) => sidebar.foldedGroups.includes(group ?? DEFAULT_GROUP);

	let picked = $state<string[]>([]); // ⌘/⇧-selected rows, besides `current`
	let lastPicked: string | null = null;
	let drag = $state<{ repos: string[]; x: number; y: number; over: { repo: string | null; group: string | null } | null } | null>(null);
	let groupDrag = $state<{ name: string; before: string | null } | null>(null);

	export const pickedRepos = () => picked;

	function onRowPointerDown(e: PointerEvent, repo: string) {
		if (e.button !== 0) return;
		if (e.metaKey) {
			picked = picked.includes(repo) ? picked.filter((r) => r !== repo) : [...picked, repo];
			lastPicked = repo;
			return;
		}
		if (e.shiftKey && lastPicked !== null) {
			const [a, b] = [sidebar.repos.indexOf(lastPicked), sidebar.repos.indexOf(repo)].sort((x, y) => x - y) as [number, number];
			picked = sidebar.repos.slice(a, b + 1);
			return;
		}
		// A click selects; moving more than 4px before releasing drags instead.
		const startX = e.clientX, startY = e.clientY;
		const dragging = picked.includes(repo) ? picked : [repo];
		let started = false;
		const move = (ev: PointerEvent) => {
			if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
			started = true;
			drag = { repos: dragging, x: ev.clientX, y: ev.clientY, over: dropTarget(ev) };
		};
		const up = (ev: PointerEvent) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('keydown', key);
			if (!started) { picked = []; lastPicked = repo; onSelect(repo); return; }
			const over = dropTarget(ev);
			drag = null;
			if (over === null || over.repo !== null && dragging.includes(over.repo)) return;
			const moved = moveManyToGroup(sidebar.repos, sidebar.groupOf, dragging, over.group, over.repo);
			onChange({ ...sidebar, repos: moved.list, groupOf: moved.groupOf });
			picked = [];
		};
		const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { started = true; drag = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); } };
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('keydown', key);
	}

	/** Where a drop at the pointer lands: before a row (in its group), or at a group's end. */
	function dropTarget(e: PointerEvent): { repo: string | null; group: string | null } | null {
		const el = document.elementFromPoint(e.clientX, e.clientY);
		const row = el?.closest<HTMLElement>('.gg-repo');
		if (row?.dataset.repo !== undefined) {
			const group = row.dataset.group === '' ? null : (row.dataset.group ?? null);
			return { repo: row.dataset.repo, group };
		}
		const section = el?.closest<HTMLElement>('.gg-section');
		if (section) return { repo: null, group: section.dataset.group === '' ? null : (section.dataset.group ?? null) };
		return null;
	}

	function onGroupPointerDown(e: PointerEvent, name: string) {
		if (e.button !== 0 || sidebar.groups.length < 2) return;
		const startY = e.clientY;
		let started = false;
		const move = (ev: PointerEvent) => {
			if (!started && Math.abs(ev.clientY - startY) < 4) return;
			started = true;
			const header = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.gg-group');
			const over = header?.dataset.group;
			groupDrag = { name, before: over !== undefined && over !== '' && over !== name ? over : null };
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			if (!started) { toggleFold(name); return; }
			const target = groupDrag;
			groupDrag = null;
			if (target && target.before !== null) onChange({ ...sidebar, groups: moveRepo(sidebar.groups, name, target.before) });
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	function toggleFold(group: string | null) {
		const key = group ?? DEFAULT_GROUP;
		const next = sidebar.foldedGroups.includes(key) ? sidebar.foldedGroups.filter((g) => g !== key) : [...sidebar.foldedGroups, key];
		onChange({ ...sidebar, foldedGroups: next });
	}

	function rowMenu(e: MouseEvent, repo: string) {
		e.preventDefault();
		const repos = picked.includes(repo) ? picked : [repo];
		onContextMenu(e, { kind: 'repos', repos });
	}

	const titleOf = (repo: string) => {
		const s = status[repo];
		const parts = [repo];
		if (s?.missing) parts.push(s.note ?? t('sidebar.missing'));
		if ((s?.ahead ?? 0) > 0) parts.push(t('sidebar.ahead', { count: s?.ahead ?? 0 }));
		if ((s?.behind ?? 0) > 0) parts.push(t('sidebar.behind', { count: s?.behind ?? 0 }));
		return parts.join('\n');
	};
</script>

<aside class="gg-sidebar" aria-label={t('sidebar.title')}>
	<div class="gg-head">
		<span class="gg-title">{t('sidebar.title')}</span>
		<button class="gg-icon" title={t('sidebar.add')} onclick={(e) => onContextMenu(e, { kind: 'add' })}>＋</button>
		<button class="gg-icon" title={t('sidebar.collapse')} onclick={onCollapse}>⟨</button>
	</div>
	<div class="gg-list">
		{#each sections as section (section.group ?? '')}
			{@const name = section.group ?? DEFAULT_GROUP}
			<div class="gg-section" data-group={section.group ?? ''} class:gg-drop-group={drag?.over?.group === section.group && drag?.over?.repo === null}>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="gg-group" class:folded={folded(section.group)} class:gg-group-over={groupDrag?.before === section.group} data-group={section.group ?? ''}
					onpointerdown={(e) => (section.group === null ? (e.button === 0 && toggleFold(null)) : onGroupPointerDown(e, section.group))}
					oncontextmenu={(e) => { if (section.group !== null) { e.preventDefault(); onContextMenu(e, { kind: 'group', name: section.group }); } }}>
					<span class="gg-twisty">{folded(section.group) ? '▸' : '▾'}</span>
					<span class="gg-group-name">{name}</span>
					{#if folded(section.group)}<span class="gg-count">{section.repos.length}</span>{/if}
				</div>
				{#if !folded(section.group)}
					{#each section.repos as repo (repo)}
						{@const avatar = avatarOf(repo)}
						{@const label = labels[repo] ?? { name: repo, hint: null }}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="gg-repo" class:current={repo === current} class:picked={picked.includes(repo)} class:missing={status[repo]?.missing}
							class:gg-drop-before={drag?.over?.repo === repo} data-repo={repo} data-group={section.group ?? ''} title={titleOf(repo)}
							onpointerdown={(e) => onRowPointerDown(e, repo)} oncontextmenu={(e) => rowMenu(e, repo)}>
							<span class="gg-avatar" style:background={avatar.colour}>{avatar.letter}</span>
							<span class="gg-text">
								<span class="gg-name">{label.name}</span>
								{#if label.hint}<span class="gg-hint">{label.hint}</span>{/if}
							</span>
							{#if badgeOf(status[repo])}<span class="gg-badge">{badgeOf(status[repo])}</span>{/if}
						</div>
					{/each}
				{/if}
			</div>
		{/each}
	</div>
	{#if drag}
		<div class="gg-ghost" style:left="{drag.x + 12}px" style:top="{drag.y + 12}px">{drag.repos.length === 1 ? (labels[drag.repos[0] as string]?.name ?? '') : drag.repos.length + ' repositories'}</div>
	{/if}
</aside>

<style>
	.gg-sidebar {
		width: var(--gg-sidebar-width, 220px); flex: none; display: flex; flex-direction: column; min-height: 0;
		background: var(--gg-sidebar-background); border-right: 1px solid var(--gg-panel-border); user-select: none; -webkit-user-select: none;
	}
	.gg-head { display: flex; align-items: center; gap: 4px; padding: 8px 6px 6px 12px; }
	.gg-title { flex: 1; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--gg-descriptionForeground); }
	.gg-icon { font: inherit; width: 24px; height: 24px; border-radius: 5px; border: none; background: none; color: var(--gg-descriptionForeground); cursor: pointer; }
	.gg-icon:hover { background: var(--gg-list-hoverBackground); color: var(--gg-foreground); }
	.gg-list { flex: 1; overflow: auto; padding-bottom: 8px; }
	.gg-section { padding-bottom: 4px; min-height: 28px; }
	.gg-section.gg-drop-group { outline: 2px solid var(--gg-focusBorder); outline-offset: -2px; border-radius: 6px; }
	.gg-group { display: flex; align-items: center; gap: 4px; padding: 4px 12px 2px; font-size: 11px; font-weight: 600; color: var(--gg-descriptionForeground); cursor: pointer; }
	.gg-group.gg-group-over { box-shadow: inset 0 2px 0 var(--gg-focusBorder); }
	.gg-twisty { width: 10px; font-size: 10px; }
	.gg-count { margin-left: auto; font-weight: 400; }
	.gg-repo { display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 12px; margin: 0 6px; border-radius: 6px; cursor: default; }
	.gg-repo:hover { background: var(--gg-list-hoverBackground); }
	.gg-repo.current { background: var(--gg-sidebar-selected); }
	.gg-repo.picked { outline: 1px solid var(--gg-focusBorder); }
	.gg-repo.missing { opacity: 0.45; }
	.gg-repo.gg-drop-before { box-shadow: inset 0 2px 0 var(--gg-focusBorder); }
	.gg-avatar { flex: none; width: 22px; height: 22px; border-radius: 6px; color: #fff; font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
	.gg-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.gg-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.gg-hint { font-size: 10px; color: var(--gg-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.gg-badge { flex: none; font-size: 11px; color: var(--gg-gitDecoration-addedResourceForeground); }
	.gg-ghost { position: fixed; z-index: 1200; pointer-events: none; padding: 3px 10px; border-radius: 6px; background: var(--gg-menu-background); border: 1px solid var(--gg-menu-border); box-shadow: 0 4px 16px var(--gg-widget-shadow); font-size: 12px; }
</style>
