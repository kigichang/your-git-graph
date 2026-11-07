/* The appearance the page is drawn in (theme.css): light or dark (the system's, or View >
 * Appearance - Rust sets it app-wide, which WebKit reports as prefers-color-scheme) and
 * Increase Contrast (prefers-contrast: more), as the classes gg-dark and gg-contrast on <html>.
 * Loaded first by index.html and diff.html (a classic script, so it runs before anything is
 * drawn). window.__ggTheme.onChange(fn) runs fn(appearance) now and on every change;
 * force({ dark, contrast }) overrides either (the self-test), null undoes it. */
(function () {
	'use strict';
	const dark = window.matchMedia('(prefers-color-scheme: dark)');
	const contrast = window.matchMedia('(prefers-contrast: more)');
	const listeners = [];
	let forced = {};

	const current = () => ({ dark: forced.dark ?? dark.matches, contrast: forced.contrast ?? contrast.matches });

	function apply() {
		const t = current();
		const root = document.documentElement.classList;
		root.toggle('gg-dark', t.dark);
		root.toggle('gg-contrast', t.contrast);
		for (const fn of listeners) fn(t);
	}

	dark.addEventListener('change', apply);
	contrast.addEventListener('change', apply);
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
