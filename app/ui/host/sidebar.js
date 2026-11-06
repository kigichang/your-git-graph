/* The repository sidebar: the repositories added to the app, the one this window shows, and
 * switching between them. The list is shared by all windows (state.json "sidebar"); each
 * window shows one repository at a time (host/main.js switches the upstream view with
 * loadRepos + loadViewTo). The pure helpers below are tested in tests/sidebar.test.mjs; the
 * DOM part (createSidebar) never touches Tauri - actions go out through callbacks. */

/* ---------- Pure helpers ---------- */

import { parseRemote } from './remote.js';

const AVATAR_COLOURS = ['#1a9e8f', '#e0773a', '#7b61ff', '#d64f73', '#3d8bfd', '#b8860b', '#3a9a52', '#a05cd6'];

export const baseName = (path) => path.replace(/\/+$/, '').split('/').pop() || path;

/** The letter and colour of a repository's avatar: the first letter or digit of its name, a
 * colour that stays the same for the same name. */
export function avatarOf(path) {
	const name = baseName(path);
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
	const letter = (name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
	return { letter, colour: AVATAR_COLOURS[hash % AVATAR_COLOURS.length] };
}

/** What each repository is called in the list: its folder name, with a hint: the machine of a
 * repository reached over ssh, else where names collide the folder it is in. */
export function labelsOf(repos) {
	const count = new Map();
	for (const repo of repos) count.set(baseName(repo), (count.get(baseName(repo)) || 0) + 1);
	return Object.fromEntries(repos.map((repo) => {
		const name = baseName(repo);
		const remote = parseRemote(repo);
		if (remote !== null) return [repo, { name, hint: remote.authority }];
		return [repo, { name, hint: count.get(name) > 1 ? baseName(repo.slice(0, repo.length - name.length)) : null }];
	}));
}

/** `list` with `repos` added at the end (those not in it yet). */
export const addRepos = (list, repos) => list.concat(repos.filter((repo, i) => !list.includes(repo) && repos.indexOf(repo) === i));

/** `list` with `repo` moved to just before `before` (null: to the end). */
export function moveRepo(list, repo, before) {
	if (!list.includes(repo) || repo === before) return list;
	const rest = list.filter((r) => r !== repo);
	const at = before === null ? -1 : rest.indexOf(before);
	return at === -1 ? rest.concat(repo) : [...rest.slice(0, at), repo, ...rest.slice(at)];
}

/** `list` without `repos`, and what to show next when `current` was one of those removed: the
 * one that took its place (the first left after it), else the last one before; null when nothing
 * is left. */
export function removeRepos(list, repos, current) {
	const next = list.filter((r) => !repos.includes(r));
	if (!repos.includes(current)) return { list: next, show: current };
	const after = list.slice(list.indexOf(current) + 1).find((r) => !repos.includes(r));
	return { list: next, show: after ?? next.at(-1) ?? null };
}

/* Groups: the sidebar's repositories in named groups, those in none under "default". Kept as
 * the names in order (`groups`) and each repository's group (`groupOf`, absent: default); the
 * order within a group is the order of the list. */

/** The name the group of ungrouped repositories shows (not a name a group can take). */
export const DEFAULT_GROUP = 'default';

/** The sections of the sidebar: { group: null (default) | name, repos }, default first. */
export function groupsOf(repos, groups, groupOf) {
	const of = (repo) => (groups.includes(groupOf[repo]) ? groupOf[repo] : null);
	return [null, ...groups].map((group) => ({ group, repos: repos.filter((repo) => of(repo) === group) }));
}

/** `repo` dropped into `group` (null: default) just before `before` (null: at its end). */
export function moveToGroup(list, groupOf, repo, group, before) {
	const next = { ...groupOf };
	if (group === null) delete next[repo]; else next[repo] = group;
	return { list: moveRepo(list, repo, before), groupOf: next };
}

/** `repos` (in the order they are to keep) dropped into `group` just before `before` (not one
 * of them; null: at the group's end). */
export function moveManyToGroup(list, groupOf, repos, group, before) {
	return repos.reduce((moved, repo) => moveToGroup(moved.list, moved.groupOf, repo, group, before), { list, groupOf });
}

/** What is wrong with `name` for a group (`current`: the one being renamed), or null. */
export function invalidGroupName(name, groups, current) {
	if (name === '') return 'Enter a name for the group.';
	if (name.toLowerCase() === DEFAULT_GROUP) return '"' + DEFAULT_GROUP + '" is the group of the repositories in no group.';
	return name !== current && groups.includes(name) ? 'There is a group with this name already.' : null;
}

export function renameGroup(groups, groupOf, from, to) {
	return {
		groups: groups.map((g) => (g === from ? to : g)),
		groupOf: Object.fromEntries(Object.entries(groupOf).map(([repo, g]) => [repo, g === from ? to : g]))
	};
}

/** Without the group `name`: its repositories are in no group again. */
export function removeGroup(groups, groupOf, name) {
	return { groups: groups.filter((g) => g !== name), groupOf: Object.fromEntries(Object.entries(groupOf).filter(([, g]) => g !== name)) };
}

/** Ahead/behind from `git rev-list --left-right --count @{upstream}...HEAD` ("behind\tahead"). */
export function parseAheadBehind(stdout) {
	const m = /^(\d+)\s+(\d+)\s*$/.exec(stdout.trim());
	return m ? { behind: parseInt(m[1], 10), ahead: parseInt(m[2], 10) } : null;
}

/** The badge after a repository's name: ↑ahead ↓behind, nothing when in step. */
export function badgeOf(status) {
	if (!status) return '';
	return [status.ahead > 0 ? '↑' + status.ahead : '', status.behind > 0 ? '↓' + status.behind : ''].filter((s) => s !== '').join(' ');
}

const STRINGS = {
	en: {
		title: 'Repositories', add: 'Add Repository', addLocal: 'Add Local Repository…', addRemote: 'Add SSH Repository…', addServer: 'Connect to Server (SMB)…', newGroup: 'New Group…', renameGroup: 'Rename Group…', deleteGroup: 'Delete Group', moveTo: (group) => 'Move to “' + group + '”', collapse: 'Hide Sidebar (⌃⌘S)', expand: 'Show Sidebar (⌃⌘S)', settings: 'Settings',
		reveal: 'Reveal in Finder', terminal: 'Open in Terminal', newWindow: 'Open in New Window', remove: 'Remove from Sidebar',
		missing: 'Not found — click to try again', offline: 'Not connected — click to connect', ahead: (n) => n + ' commit' + (n === 1 ? '' : 's') + ' to push', behind: (n) => n + ' commit' + (n === 1 ? '' : 's') + ' to pull'
	},
	// The view's Chinese ('zh-cn' is the language code its code knows): Traditional Chinese
	// (Taiwan) in this app - see host/settings.js and scripts/zh-tw.mjs.
	'zh-cn': {
		title: '儲存庫', add: '加入儲存庫', addLocal: '加入本機儲存庫…', addRemote: '加入 SSH 儲存庫…', addServer: '連線到伺服器 (SMB)…', newGroup: '新增群組…', renameGroup: '重新命名群組…', deleteGroup: '刪除群組', moveTo: (group) => '移到「' + group + '」', collapse: '隱藏側邊欄 (⌃⌘S)', expand: '顯示側邊欄 (⌃⌘S)', settings: '設定',
		reveal: '在 Finder 中顯示', terminal: '在終端機中開啟', newWindow: '在新視窗中開啟', remove: '從側邊欄移除',
		missing: '找不到 — 點一下重試', offline: '尚未連線 — 點一下連線', ahead: (n) => n + ' 個提交待推送', behind: (n) => n + ' 個提交待拉取'
	}
};

/* ---------- The DOM ---------- */

const ICONS = {
	plus: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
	sidebar: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M6.5 3v10" stroke="currentColor" stroke-width="1.3"/></svg>',
	gear: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M12.76 6.45 L14.46 6.66 L14.46 9.34 L12.76 9.55 L12.46 10.27 L13.52 11.62 L11.62 13.52 L10.27 12.46 L9.55 12.76 L9.34 14.46 L6.66 14.46 L6.45 12.76 L5.73 12.46 L4.38 13.52 L2.48 11.62 L3.54 10.27 L3.24 9.55 L1.54 9.34 L1.54 6.66 L3.24 6.45 L3.54 5.73 L2.48 4.38 L4.38 2.48 L5.73 3.54 L6.45 3.24 L6.66 1.54 L9.34 1.54 L9.55 3.24 L10.27 3.54 L11.62 2.48 L13.52 4.38 L12.46 5.73Z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>'
};

const el = (tag, className, text) => {
	const e = document.createElement(tag);
	if (className) e.className = className;
	if (text !== undefined) e.textContent = text;
	return e;
};
const iconButton = (icon, title, onClick) => {
	const b = el('button', 'ggIconBtn');
	b.innerHTML = ICONS[icon]; // fixed markup, no data
	b.title = title;
	b.setAttribute('aria-label', title);
	b.addEventListener('click', onClick);
	return b;
};

/** The sidebar in `document.body`. actions: { select(repo), add(), addRemote(), addServer(), remove(repos), reveal(repo),
 * terminal(repo), newWindow(repo), move(repos, group, before), newGroup(), renameGroup(name),
 * deleteGroup(name), moveGroup(name, before), foldGroup(name), toggle(), settings() }; move: the repositories
 * `repos` dragged (or sent by the menu) into `group` (null: default), to just before `before`
 * (null: its end); moveGroup: to just before the
 * group `before` (null: last). Returns { render(state) } where
 * state is { repos, groups, groupOf, folded (the names of the groups whose repositories are
 * hidden, DEFAULT_GROUP for the default one), current, status: { [repo]: { ahead, behind } | { missing: true } },
 * collapsed, language }. select is also called for the current repository when it is missing
 * (not found, not connected): a click tries again. */
export function createSidebar(actions) {
	let state = { repos: [], groups: [], groupOf: {}, folded: [], current: null, status: {}, collapsed: false, language: 'en' };
	const t = () => STRINGS[state.language] || STRINGS.en;

	const nav = el('nav');
	nav.id = 'ggSidebar';
	const head = el('div', 'ggSidebarHead');
	const title = el('span', 'ggSidebarTitle');
	const addBtn = iconButton('plus', '', () => {
		const box = addBtn.getBoundingClientRect();
		openMenu([[t().addLocal, actions.add], [t().addRemote, actions.addRemote], [t().addServer, actions.addServer], null, [t().newGroup, actions.newGroup]], box.left, box.bottom + 2);
	});
	const hideBtn = iconButton('sidebar', '', () => actions.toggle());
	head.append(title, addBtn, hideBtn);
	const list = el('div');
	list.id = 'ggRepoList';
	list.setAttribute('role', 'listbox');
	const foot = el('div', 'ggSidebarFoot');
	const settingsBtn = el('button', 'ggFootBtn');
	settingsBtn.addEventListener('click', () => actions.settings());
	foot.append(settingsBtn);
	nav.append(head, list, foot);

	// Shown in the view's top-left corner while the sidebar is hidden.
	const showBtn = iconButton('sidebar', '', () => actions.toggle());
	showBtn.id = 'ggSidebarShow';

	/* A small context menu of the sidebar's own (the view's belongs to upstream). */
	let menu = null;
	const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
	/* Several rows can be selected (⌘-click adds or removes one, ⇧-click takes the rows from the
	 * last one clicked) to move them into a group together (by dragging any of them, or from
	 * their menu) or take them out of the sidebar. Nothing is kept: a plain click, Escape or the move itself ends the selection. */
	const selected = new Set();
	let anchor = null; // where a ⇧-click starts from
	const paintSelection = () => rows().forEach((r) => r.classList.toggle('selected', selected.has(r.dataset.repo)));
	const clearSelection = () => { selected.clear(); paintSelection(); };
	/** The repositories an action on `repo` is about: the selection when it is part of one. */
	const withSelection = (repo) => (selected.size > 1 && selected.has(repo) ? rows().map((r) => r.dataset.repo).filter((r) => selected.has(r)) : [repo]);
	const moveMenu = (repos) => [null, ...state.groups].map((group) => [t().moveTo(group === null ? DEFAULT_GROUP : group), () => { clearSelection(); actions.move(repos, group, null); }]);
	/* A repository's menu; one on another machine has no folder for the Finder to show. For a
	 * selection: where to move it, and taking it all out. */
	const repoMenu = (repo) => {
		const repos = withSelection(repo);
		const remove = [t().remove, () => { clearSelection(); actions.remove(repos); }];
		return repos.length > 1 ? [...moveMenu(repos), null, remove] : [
			...(parseRemote(repo) === null ? [[t().reveal, () => actions.reveal(repo)]] : []),
			[t().terminal, () => actions.terminal(repo)], [t().newWindow, () => actions.newWindow(repo)],
			...(state.groups.length > 0 ? [null, ...moveMenu([repo])] : []),
			null, remove
		];
	};
	document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target) && !addBtn.contains(e.target)) closeMenu(); }, true);
	/** items: [label, action] each, null for a separator. */
	function openMenu(items, x, y) {
		closeMenu();
		menu = el('ul', 'ggMenu');
		for (const entry of items) {
			if (entry === null) { menu.appendChild(el('li', 'ggMenuSeparator')); continue; }
			const li = el('li', 'ggMenuItem', entry[0]);
			li.addEventListener('click', () => { closeMenu(); entry[1](); });
			menu.appendChild(li);
		}
		document.body.appendChild(menu);
		const box = menu.getBoundingClientRect();
		menu.style.left = Math.min(x, window.innerWidth - box.width - 4) + 'px';
		menu.style.top = Math.min(y, window.innerHeight - box.height - 4) + 'px';
	}

	/* Reordering by dragging a row, within its group or into another. Pointer events, not HTML5
	 * drag and drop (Tauri's own file drop handling takes those over). A press becomes a drag once
	 * it moves a few pixels; until then it is a click. Rows are keyed by data-repo so a render
	 * during the drag keeps it. A group is moved among the groups the same way, by its name
	 * ("default" stays first). */
	let drag = null; // rows: { repos, y, active, group, before }; a group: { moving, y, active, before }
	const rows = () => [...list.querySelectorAll('.ggRepo')];
	const headers = () => [...list.querySelectorAll('.ggGroup')];
	const groupKey = (group) => (group === null ? '' : group); // data-group
	const clearMarks = () => [...rows(), ...headers()].forEach((r) => r.classList.remove('ggDropBefore', 'ggDropAfter', 'ggDropInto'));
	const shownAs = (repos, groupOf) => JSON.stringify(groupsOf(repos, state.groups, groupOf));
	/** Whether dropping now would change what the sidebar shows. */
	const dropMoves = () => {
		if (drag.moving) return JSON.stringify(moveRepo(state.groups, drag.moving, drag.before)) !== JSON.stringify(state.groups);
		const next = moveManyToGroup(state.repos, state.groupOf, drag.repos, drag.group, drag.before);
		return shownAs(next.list, next.groupOf) !== shownAs(state.repos, state.groupOf);
	};
	function markDrag() {
		clearMarks();
		for (const r of rows()) r.classList.toggle('dragging', drag !== null && drag.active && !drag.moving && drag.repos.includes(r.dataset.repo));
		for (const h of headers()) h.classList.toggle('dragging', drag !== null && drag.active && h.dataset.group === drag.moving);
		// The line shows where the row (or group) would land, unless that is where it already is.
		if (drag === null || !drag.active || !dropMoves()) return;
		if (drag.moving) {
			if (drag.before !== null) headers().find((h) => h.dataset.group === drag.before)?.classList.add('ggDropBefore');
			else list.lastElementChild.classList.add('ggDropAfter'); // after the last group
			return;
		}
		if (drag.before !== null) { rows().find((r) => r.dataset.repo === drag.before)?.classList.add('ggDropBefore'); return; }
		const last = rows().filter((r) => r.dataset.group === groupKey(drag.group) && !drag.repos.includes(r.dataset.repo)).at(-1);
		if (last) last.classList.add('ggDropAfter');
		else headers().find((h) => h.dataset.group === groupKey(drag.group))?.classList.add('ggDropInto'); // an empty group
	}
	function endDrag(commit) {
		if (drag === null) return;
		const { repos, moving, active, group, before } = drag;
		const moves = active && dropMoves();
		drag = null;
		list.classList.remove('ggReordering');
		markDrag();
		if (!active) return;
		// The click that follows the release is not a selection.
		const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
		list.addEventListener('click', swallow, true);
		setTimeout(() => list.removeEventListener('click', swallow, true), 0);
		if (commit && moves) { if (moving) actions.moveGroup(moving, before); else { clearSelection(); actions.move(repos, group, before); } }
	}
	list.addEventListener('pointerdown', (e) => {
		const header = e.target.closest('.ggGroup');
		if (e.button === 0 && header !== null && header.dataset.group !== '' && state.groups.length > 1) {
			drag = { moving: header.dataset.group, y: e.clientY, active: false, before: null };
			return;
		}
		const row = e.target.closest('.ggRepo');
		if (e.button !== 0 || row === null || (state.repos.length < 2 && state.groups.length === 0)) return;
		drag = { repos: withSelection(row.dataset.repo), y: e.clientY, active: false, group: row.dataset.group === '' ? null : row.dataset.group, before: null };
	});
	document.addEventListener('pointermove', (e) => {
		if (drag === null) return;
		if (!drag.active) {
			if (Math.abs(e.clientY - drag.y) < 4) return;
			drag.active = true;
			list.classList.add('ggReordering');
			closeMenu();
		}
		if (drag.moving) {
			// Before the first group whose middle (its name and rows) is below the pointer; past them all: last.
			const named = headers().filter((h) => h.dataset.group !== '');
			const below = named.find((h, i) => {
				const bottom = i + 1 < named.length ? named[i + 1].getBoundingClientRect().top : list.lastElementChild.getBoundingClientRect().bottom;
				return e.clientY < (h.getBoundingClientRect().top + bottom) / 2;
			});
			drag.before = below ? below.dataset.group : null;
			markDrag();
			return;
		}
		// Into the group whose header is the last one above the pointer; there before the first
		// row (of those staying where they are) whose middle is below the pointer; past them all: its end.
		const header = headers().filter((h) => h.getBoundingClientRect().top <= e.clientY).at(-1) || headers()[0];
		const below = rows().filter((r) => r.dataset.group === header.dataset.group && !drag.repos.includes(r.dataset.repo)).find((r) => { const box = r.getBoundingClientRect(); return e.clientY < box.top + box.height / 2; });
		drag.group = header.dataset.group === '' ? null : header.dataset.group;
		drag.before = below ? below.dataset.repo : null;
		markDrag();
	});
	document.addEventListener('pointerup', () => endDrag(true));
	document.addEventListener('pointercancel', () => endDrag(false));
	// Escape, or the window losing focus, ends what is under way: the menu, the selection, a drag.
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); clearSelection(); endDrag(false); } });
	window.addEventListener('blur', () => { closeMenu(); endDrag(false); });

	function render(next) {
		state = { ...state, ...next };
		title.textContent = t().title;
		addBtn.title = t().add;
		addBtn.setAttribute('aria-label', t().add);
		hideBtn.title = t().collapse;
		hideBtn.setAttribute('aria-label', t().collapse);
		showBtn.title = t().expand;
		showBtn.setAttribute('aria-label', t().expand);
		settingsBtn.innerHTML = ICONS.gear;
		settingsBtn.append(el('span', null, t().settings));
		document.body.classList.add('ggHasSidebar');
		document.body.classList.toggle('ggSidebarCollapsed', state.collapsed);
		if (!nav.isConnected) document.body.append(nav, showBtn);

		const labels = labelsOf(state.repos);
		for (const repo of [...selected]) if (!state.repos.includes(repo)) selected.delete(repo);
		const row = (repo, group) => {
			const status = state.status[repo];
			const item = el('button', 'ggRepo' + (repo === state.current ? ' current' : '') + (status && status.missing ? ' missing' : '') + (selected.has(repo) ? ' selected' : ''));
			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', String(repo === state.current));
			item.dataset.repo = repo;
			item.dataset.group = groupKey(group);
			const missing = !!(status && status.missing);
			item.title = repo + (missing ? ' — ' + (parseRemote(repo) === null ? t().missing : t().offline) : '');
			const avatar = avatarOf(repo);
			const badge = el('span', 'ggAvatar', avatar.letter);
			badge.style.background = avatar.colour;
			const name = el('span', 'ggRepoName', labels[repo].name);
			if (labels[repo].hint) name.append(el('span', 'ggRepoHint', ' ' + labels[repo].hint));
			item.append(badge, name);
			const text = badgeOf(status);
			if (text !== '') {
				const b = el('span', 'ggRepoBadge', text);
				b.title = [status.ahead > 0 ? t().ahead(status.ahead) : '', status.behind > 0 ? t().behind(status.behind) : ''].filter((s) => s).join(', ');
				item.append(b);
			}
			item.addEventListener('click', (e) => {
				if (e.metaKey || (e.shiftKey && anchor !== null)) {
					if (e.metaKey) {
						if (!selected.delete(repo)) selected.add(repo);
						anchor = repo;
					} else {
						const order = rows().map((r) => r.dataset.repo), from = order.indexOf(anchor), to = order.indexOf(repo);
						if (from !== -1) for (const r of order.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(r);
					}
					paintSelection();
					return;
				}
				clearSelection();
				anchor = repo;
				if (repo !== state.current || missing) actions.select(repo);
			});
			item.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(repoMenu(repo), e.clientX, e.clientY); });
			return item;
		};
		list.replaceChildren(...groupsOf(state.repos, state.groups, state.groupOf).flatMap(({ group, repos }) => {
			const name = group === null ? DEFAULT_GROUP : group, folded = state.folded.includes(name);
			const header = el('div', 'ggGroup' + (folded ? ' folded' : ''), name);
			header.dataset.group = groupKey(group);
			header.dataset.count = String(repos.length); // shown while folded (sidebar.css)
			header.setAttribute('aria-expanded', String(!folded));
			header.addEventListener('click', () => actions.foldGroup(name));
			if (group !== null) {
				header.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					openMenu([[t().renameGroup, () => actions.renameGroup(group)], [t().deleteGroup, () => actions.deleteGroup(group)]], e.clientX, e.clientY);
				});
			}
			return [header, ...(folded ? [] : repos.map((repo) => row(repo, group)))];
		}));
		markDrag();
	}

	return { render };
}
