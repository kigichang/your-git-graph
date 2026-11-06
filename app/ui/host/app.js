/* The webview requests that VS Code itself used to answer: clipboard, links, Terminal, dialogs,
 * the view's persisted state, settings, code reviews - and polite refusals for what this app
 * does not offer yet. Handler shape as in gitops.js; ctx.system, ctx.store, ctx.settings and
 * ctx.config come from main.js. */
import { syncGlobalAuthor } from './gitops.js';
import { UNCOMMITTED, diffSpec, workingFileSpec, fileSpec, compareSpec } from './diffspec.js';
import { validateSetting } from './settings.js';
import { exportRepoConfig } from './repoconfig.js';
import { isRemote, pathOf } from './remote.js';

const NOT_REMOTE = 'Not available for a repository on another machine.';

/** The handlers below that write into a repository (the file watcher's echo is ignored). */
export const APP_WRITES = new Set(['exportRepoConfig']);

const message = (e) => String((e && e.message) || e);
const attempt = async (fn) => { try { await fn(); return null; } catch (e) { return message(e); } };
const notYet = (what) => what + ' is not available in the macOS app yet.';

export const appHandlers = {
	/* --- Repositories and persisted view state --- */
	async loadRepos(ctx) {
		return { command: 'loadRepos', repos: ctx.store.repos(), lastActiveRepo: ctx.repo, loadViewTo: null };
	},
	async rescanForRepos(ctx) {
		return appHandlers.loadRepos(ctx);
	},
	async setRepoState(ctx, m) {
		ctx.store.setRepoState(m.repo, m.state);
		return null;
	},
	async setViewSnapshot() {
		return null; // VS Code restores a hidden tab from it; this window is never hidden that way
	},
	async setGlobalViewState(ctx, m) {
		ctx.store.set('globalViewState', m.state);
		return { command: 'setGlobalViewState', error: null };
	},
	async setWorkspaceViewState(ctx, m) {
		ctx.store.set('workspaceViewState', m.state);
		return { command: 'setWorkspaceViewState', error: null };
	},

	/* --- Code reviews (which files of a commit / comparison are still unreviewed) --- */
	async startCodeReview(ctx, m) {
		const codeReview = { id: m.id, lastActive: Date.now(), lastViewedFile: m.lastViewedFile, remainingFiles: m.files };
		ctx.codeReviews.set(m.id, codeReview);
		return { command: 'startCodeReview', codeReview, commitHash: m.commitHash, compareWithHash: m.compareWithHash, error: null };
	},
	async updateCodeReview(ctx, m) {
		const review = ctx.codeReviews.get(m.id);
		if (review === null) return { command: 'updateCodeReview', error: 'The code review no longer exists.' };
		if (m.remainingFiles.length === 0) ctx.codeReviews.delete(m.id);
		else ctx.codeReviews.set(m.id, { ...review, lastActive: Date.now(), lastViewedFile: m.lastViewedFile, remainingFiles: m.remainingFiles });
		return { command: 'updateCodeReview', error: null };
	},
	async endCodeReview(ctx, m) {
		ctx.codeReviews.delete(m.id);
		return null;
	},

	/* --- macOS integrations --- */
	async copyToClipboard(ctx, m) {
		return { command: 'copyToClipboard', type: m.type, error: await attempt(() => ctx.system.clipboard(m.data)) };
	},
	async copyFilePath(ctx, m) {
		const text = m.absolute ? pathOf(ctx.repo) + '/' + m.filePath : m.filePath; // on the repository's machine
		return { command: 'copyFilePath', error: await attempt(() => ctx.system.clipboard(text)) };
	},
	async openExternalUrl(ctx, m) {
		return { command: 'openExternalUrl', error: await attempt(() => ctx.system.openUrl(m.url)) };
	},
	async openFile(ctx, m) {
		return { command: 'openFile', error: await attempt(() => ctx.system.openPath(ctx.repo + '/' + m.filePath)) };
	},
	async openTerminal(ctx) {
		return { command: 'openTerminal', error: await attempt(() => ctx.terminal(null)) };
	},
	async showErrorMessage(ctx, m) {
		await attempt(() => ctx.system.showError(m.message));
		return null;
	},
	async openExternalDirDiff(ctx, m) {
		if (isRemote(ctx.repo)) return { command: 'openExternalDirDiff', error: NOT_REMOTE }; // the diff tool would start over there
		const args = ['difftool', '--dir-diff', '--no-prompt', ...(m.isGui ? ['--gui'] : []), m.fromHash, ...(m.toHash === UNCOMMITTED ? [] : [m.toHash])];
		const result = await ctx.git(args);
		return { command: 'openExternalDirDiff', error: result.exitCode === 0 ? null : (result.stderr.trim() || 'git difftool failed.') };
	},

	/* --- Diff windows (the diff window reads the contents itself: app/diff/main.js) --- */
	async viewDiff(ctx, m) {
		return { command: 'viewDiff', error: await attempt(() => ctx.system.openDiff(diffSpec(ctx.repo, m))) };
	},
	async viewDiffBinary(ctx, m) {
		return { command: 'viewDiff', error: await attempt(() => ctx.system.openDiff(diffSpec(ctx.repo, m, true))) };
	},
	async viewDiffWithWorkingFile(ctx, m) {
		return { command: 'viewDiffWithWorkingFile', error: await attempt(() => ctx.system.openDiff(workingFileSpec(ctx.repo, m))) };
	},
	async viewFileAtRevision(ctx, m) {
		return { command: 'viewFileAtRevision', error: await attempt(() => ctx.system.openDiff(fileSpec(ctx.repo, m))) };
	},
	async openCompareTab(ctx, m) {
		const error = await attempt(() => ctx.system.openDiff(compareSpec(ctx.repo, m)));
		if (error !== null) await attempt(() => ctx.system.showError(error));
		return null; // the protocol has no response for it
	},

	/* --- Settings (settings.json: every window applies a change when it is written) --- */
	async setGlobalSetting(ctx, m) {
		const base = { command: 'setGlobalSetting', setting: m.setting, authorConfigTouched: false };
		const invalid = validateSetting(m.setting, m.value);
		if (invalid !== null) return { ...base, error: invalid };
		const error = await attempt(() => ctx.settings.write(m.setting, m.value));
		if (error !== null || m.setting !== 'commitAuthors') return { ...base, error };
		// The list the widget showed is what the edit is judged against (see syncGlobalAuthor).
		const previous = Array.isArray(m.previousValue) ? m.previousValue : ctx.config().commitAuthors;
		// Not with a remote repository shown: its git's global configuration is that account's.
		const synced = isRemote(ctx.repo) ? { touched: false, error: null } : await syncGlobalAuthor(ctx, previous, m.value);
		return { ...base, authorConfigTouched: synced.touched, error: synced.error };
	},
	async setInterfaceLanguage(ctx, m) {
		// The view's Chinese ('zh-cn') is this app's Traditional Chinese: kept as "zh-tw".
		const language = m.language === 'zh-cn' ? 'zh-tw' : m.language;
		const error = validateSetting('interfaceLanguage', language) ?? await attempt(() => ctx.settings.write('interfaceLanguage', language));
		return { command: 'setInterfaceLanguage', error };
	},
	async openExtensionSettings(ctx) {
		return { command: 'openExtensionSettings', error: await attempt(() => ctx.system.openSettings()) };
	},
	async openLogFile(ctx) {
		return { command: 'openLogFile', error: await attempt(() => ctx.system.openLog()) };
	},
	async exportRepoConfig(ctx, m) {
		const contents = exportRepoConfig(ctx.store.repoState(m.repo), ctx.store.get('globalViewState', {}).issueLinkingConfig ?? null);
		return { command: 'exportRepoConfig', error: await attempt(() => ctx.system.exportRepoConfig(m.repo, contents)) };
	},

	/* --- Not offered yet --- */
	async viewScm() { return { command: 'viewScm', error: notYet('The Source Control view') }; },
	async createPullRequest(ctx, m) { return { command: 'createPullRequest', push: m.push, errors: [notYet('Creating a pull request')] }; },
	async fetchPullRequest(ctx, m) { return { command: 'pullRequestStatus', repo: m.repo, prs: null }; },
	async gerritSetFetchRefs() { return { command: 'gerritSetFetchRefs', enabled: false, cleared: 0, error: notYet('The Gerrit integration') }; },
	async fetchAvatar() { return null; } // avatars are switched off in the generated config
};
