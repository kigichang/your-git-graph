/* The appearance the page is drawn in, for theme.css and the upstream webview: light or dark
 * (the system's, or View > Appearance - Rust sets it app-wide, which WebKit reports as
 * prefers-color-scheme) and Increase Contrast (prefers-contrast: more).
 *   <html>  gg-dark, gg-contrast                     (theme.css)
 *   <body>  vscode-light | vscode-dark | vscode-high-contrast [+ vscode-high-contrast-light]
 *           as VS Code marks a webview's theme kind  (upstream web/styles)
 * Loaded first by index.html and diff.html; window.__ggTheme.onChange(fn) runs fn(appearance)
 * now and on every change; force({ dark, contrast }) overrides either (the self-test), null
 * undoes it. */
(function () {
	'use strict';
	const dark = window.matchMedia('(prefers-color-scheme: dark)');
	const contrast = window.matchMedia('(prefers-contrast: more)');
	const listeners = [];
	let forced = {};
	/* The tokens upstream reads from <html>'s inline style (web/utils.ts getVSCodeStyle: VS Code
	 * injects them there) - the find match and flash colours, the fonts, whether a selection
	 * colour exists. They live in theme.css, so they are copied over for each appearance; the
	 * change also tells upstream's MutationObserver to pick up the new colours. */
	const INLINE = ['--vscode-font-family', '--vscode-editor-font-family', '--vscode-editor-findMatchHighlightBackground', '--vscode-selection-background'];
	function mirrorInline() {
		const style = document.documentElement.style;
		for (const name of INLINE) style.removeProperty(name);
		const computed = window.getComputedStyle(document.documentElement);
		for (const name of INLINE) style.setProperty(name, computed.getPropertyValue(name).trim());
	}

	const current = () => ({ dark: forced.dark ?? dark.matches, contrast: forced.contrast ?? contrast.matches });

	function apply() {
		const t = current();
		const root = document.documentElement.classList;
		root.toggle('gg-dark', t.dark);
		root.toggle('gg-contrast', t.contrast);
		mirrorInline();
		if (document.body) {
			const body = document.body.classList;
			body.toggle('vscode-light', !t.dark && !t.contrast);
			body.toggle('vscode-dark', t.dark && !t.contrast);
			body.toggle('vscode-high-contrast', t.contrast);
			body.toggle('vscode-high-contrast-light', t.contrast && !t.dark);
		}
		for (const fn of listeners) fn(t);
	}

	dark.addEventListener('change', apply);
	contrast.addEventListener('change', apply);
	document.addEventListener('DOMContentLoaded', apply);
	apply();

	// GG_PREVIEW=…,contrast (src-tauri/src/main.rs): Increase Contrast for a look at it.
	if (window.__TAURI__) {
		window.__TAURI__.core.invoke('preview').then((p) => {
			if (p && p.split(',').includes('contrast')) window.__ggTheme.force({ contrast: true });
		}, () => {});
	}

	window.__ggTheme = {
		current,
		apply,
		onChange(fn) { listeners.push(fn); fn(current()); },
		force(override) { forced = override || {}; apply(); }
	};
})();
