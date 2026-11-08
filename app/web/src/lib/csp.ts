// What the Content-Security-Policy (tauri.conf.json) refused in this window, for the self-test:
// the policy must stop what it is for without getting in the way of anything the app does.
// Imported first by each window's entry point, to see everything.
export const cspViolations: string[] = [];

document.addEventListener('securitypolicyviolation', (e) => {
	cspViolations.push(e.violatedDirective + ': ' + (e.blockedURI || e.sample));
});
