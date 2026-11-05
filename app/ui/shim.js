/* The VS Code webview API, re-created for the Tauri window.
 *
 * The upstream webview bundle (media/out.min.js) talks to its extension host through
 * acquireVsCodeApi().postMessage(...) and listens for answers as window 'message' events.
 * Here the "host" lives in the same page (host/main.js): postMessage hands the request to it, and
 * its answers are delivered back as MessageEvents, exactly like a real webview receives them. */
(function () {
	'use strict';
	// The view's state (current repo, scroll position, ...) is kept per folder: windows showing
	// different folders must not restore each other's. host/main.js provides the store
	// (window.__ggStore, Application Support) and sets the folder before the bundle loads and
	// first asks for it.
	const stateKey = () => 'webviewState:' + (window.__ggStateFolder || '');
	let state, pending = null;
	// The view saves its state on every scroll: hand the store the latest one, at most every 300ms.
	const persist = () => {
		if (pending === null) return;
		clearTimeout(pending);
		pending = null;
		window.__ggStore.set(stateKey(), state);
	};
	window.addEventListener('pagehide', persist);

	const api = {
		getState: () => {
			if (state === undefined) state = window.__ggStore.get(stateKey(), null);
			return state;
		},
		setState: (next) => {
			state = next;
			if (pending === null) pending = setTimeout(persist, 300);
			return next;
		},
		postMessage: (message) => {
			// Synchronous, so the host still sees the click that sent it; it answers later (host/main.js).
			window.__ggHost.handle(message);
		}
	};
	let acquired = false;
	window.acquireVsCodeApi = function () {
		if (acquired) throw new Error('An instance of the VS Code API has already been acquired');
		acquired = true;
		return api;
	};

	/** Deliver one host → webview message. */
	window.__ggDeliver = function (message) {
		window.dispatchEvent(new MessageEvent('message', { data: message }));
	};
	// The theme kind VS Code marks on <body>: theme.js.
})();
