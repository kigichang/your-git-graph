/* The credential prompt (Rust side: src-tauri/src/askpass.rs). Git and ssh ask through the app's
 * askpass helper; each question arrives as an `askpass` event and is shown here, one at a time,
 * over the view. Answers go back with invoke('askpass_reply', { id, answer }), null = cancelled. */

/** Prompts whose answer must not be shown while typing. */
const SECRET = /password|passphrase|\bpin\b|token|secret/i;

export function installAskpass({ listen, invoke, log }) {
	const queue = [];      // { id, prompt } waiting to be shown
	let current = null;    // { id, elem } on screen

	function finish(answer) {
		if (current === null) return;
		const { id, elem } = current;
		current = null;
		elem.remove();
		invoke('askpass_reply', { id, answer }).catch((e) => log('askpass_reply failed: ' + e));
		showNext();
	}

	function showNext() {
		if (current !== null || queue.length === 0) return;
		const { id, prompt } = queue.shift();
		const elem = document.createElement('div');
		elem.id = 'ggAskpass';
		elem.className = 'ggDialog';
		elem.innerHTML = '<form class="ggDialogBox" autocomplete="off">'
			+ '<div class="ggDialogTitle">Git</div>'
			+ '<label class="ggAskpassPrompt" for="ggAskpassInput"></label>'
			+ '<input id="ggAskpassInput" autocapitalize="off" autocorrect="off" spellcheck="false">'
			+ '<div class="ggDialogButtons"><button type="button" class="ggAskpassCancel">Cancel</button><button type="submit" class="ggAskpassOk ggDialogOk">OK</button></div>'
			+ '</form>';
		elem.querySelector('.ggAskpassPrompt').textContent = prompt.trim(); // text, never HTML: it comes from the remote
		const input = elem.querySelector('input');
		input.type = SECRET.test(prompt) ? 'password' : 'text';
		const form = elem.querySelector('form');
		form.addEventListener('submit', (e) => { e.preventDefault(); finish(input.value); });
		elem.querySelector('.ggAskpassCancel').addEventListener('click', () => finish(null));
		// Keep keystrokes away from the view's own shortcuts underneath.
		form.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Escape') { e.preventDefault(); finish(null); }
		});
		document.body.appendChild(elem);
		current = { id, elem };
		input.focus();
	}

	listen('askpass', ({ payload }) => {
		if (payload.type === 'request') {
			log('askpass: prompt ' + payload.id);
			queue.push({ id: payload.id, prompt: payload.prompt });
			showNext();
		} else if (payload.type === 'close') {
			// git went away (finished, timed out, cancelled): the question no longer matters
			const waiting = queue.findIndex((q) => q.id === payload.id);
			if (waiting >= 0) queue.splice(waiting, 1);
			if (current !== null && current.id === payload.id) {
				current.elem.remove();
				current = null;
				showNext();
			}
			log('askpass: prompt ' + payload.id + ' closed');
		}
	});
}
