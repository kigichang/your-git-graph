/* The dialogs of the sidebar: where a repository on another machine is (Add SSH Repository,
 * Connect to Server for a network share) and the name of a group. They only ask; host/main.js
 * connects, adds and saves. Styled
 * like the credential prompt (theme.css, .ggDialog). */

import { invalidRemote, invalidShare } from './remote.js';
import { invalidGroupName } from './sidebar.js';

const STRINGS = {
	en: {
		ssh: 'Add SSH Repository', destination: 'Host', destinationHint: 'user@host, or a Host of ~/.ssh/config', port: 'Port', portHint: 'default',
		path: 'Folder', pathHint: 'a repository, or a folder of them (~/… or /…)', connect: 'Connect', cancel: 'Cancel',
		server: 'Connect to Server', url: 'Address of the share', urlHint: 'smb://server/share',
		newGroup: 'New Group', renameGroup: 'Rename Group', name: 'Name', ok: 'OK'
	},
	'zh-cn': {
		ssh: '加入 SSH 儲存庫', destination: '主機', destinationHint: 'user@host，或 ~/.ssh/config 裡的 Host', port: '連接埠', portHint: '預設',
		path: '資料夾', pathHint: '儲存庫，或含多個儲存庫的資料夾（~/… 或 /…）', connect: '連線', cancel: '取消',
		server: '連線到伺服器', url: '共享資料夾的位址', urlHint: 'smb://server/share',
		newGroup: '新增群組', renameGroup: '重新命名群組', name: '名稱', ok: '確定'
	}
};

/** A dialog `id` with `rows` of fields ({ name, label, hint, narrow }); resolves to the trimmed
 * values once `invalid(values)` is null, or to null when cancelled. `initial` refills the
 * fields and `error` says why the last attempt failed. */
function ask(id, title, rows, t, invalid, initial, error, ok = t.connect) {
	return new Promise((resolve) => {
		const elem = document.createElement('div');
		elem.id = id;
		elem.className = 'ggDialog';
		const field = (f) => '<label' + (f.narrow ? ' class="ggDialogNarrow"' : '') + '><span></span><input name="' + f.name + '" autocapitalize="off" autocorrect="off" spellcheck="false"></label>';
		elem.innerHTML = '<form class="ggDialogBox" autocomplete="off"><div class="ggDialogTitle"></div>'
			+ rows.map((row) => '<div class="ggDialogRow">' + row.map(field).join('') + '</div>').join('')
			+ '<div class="ggDialogError" hidden></div>'
			+ '<div class="ggDialogButtons"><button type="button" class="ggDialogCancel"></button><button type="submit" class="ggDialogOk"></button></div></form>';
		const form = elem.querySelector('form');
		const fields = rows.flat();
		elem.querySelector('.ggDialogTitle').textContent = title;
		for (const f of fields) {
			const input = form.elements[f.name];
			input.previousElementSibling.textContent = f.label;
			input.placeholder = f.hint || '';
			input.value = (initial && initial[f.name]) || '';
		}
		elem.querySelector('.ggDialogCancel').textContent = t.cancel;
		elem.querySelector('.ggDialogOk').textContent = ok;
		const problem = elem.querySelector('.ggDialogError');
		const say = (text) => { problem.textContent = text; problem.hidden = text === ''; }; // text, never HTML
		say(error || '');
		const close = (answer) => { elem.remove(); resolve(answer); };
		form.addEventListener('submit', (e) => {
			e.preventDefault();
			const answer = Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value.trim()]));
			const wrong = invalid(answer);
			if (wrong !== null) { say(wrong); return; }
			close(answer);
		});
		elem.querySelector('.ggDialogCancel').addEventListener('click', () => close(null));
		// Keep keystrokes away from the view's own shortcuts underneath.
		form.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Escape') { e.preventDefault(); close(null); }
		});
		document.body.appendChild(elem);
		const first = fields.map((f) => form.elements[f.name]).find((input) => input.value === '') || form.elements[fields[0].name];
		first.focus();
		first.select();
	});
}

/** Ask for { destination, port, path } of a repository reached over ssh; null when cancelled. */
export function askRemote({ language, initial, error }) {
	const t = STRINGS[language] || STRINGS.en;
	return ask('ggAddRemote', t.ssh, [
		[{ name: 'destination', label: t.destination, hint: t.destinationHint }, { name: 'port', label: t.port, hint: t.portHint, narrow: true }],
		[{ name: 'path', label: t.path, hint: t.pathHint }]
	], t, invalidRemote, initial, error);
}

/** Ask for { url } of a network share to mount; null when cancelled. */
export function askServer({ language, initial, error }) {
	const t = STRINGS[language] || STRINGS.en;
	return ask('ggConnectServer', t.server, [[{ name: 'url', label: t.url, hint: t.urlHint }]], t, ({ url }) => invalidShare(url), initial, error);
}

/** Ask for { name } of a group: a new one, or the new name of `current`; null when cancelled. */
export function askGroup({ language, groups, current }) {
	const t = STRINGS[language] || STRINGS.en;
	return ask('ggGroupName', current === undefined ? t.newGroup : t.renameGroup, [[{ name: 'name', label: t.name }]], t,
		({ name }) => invalidGroupName(name, groups, current), { name: current }, null, t.ok);
}
