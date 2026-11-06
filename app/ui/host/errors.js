/* Errors as text, and the engine's errors (pure; shared by the main window and the diff window). */

/** What to show or log for anything thrown: an Error's message, or the value itself (Tauri
 * rejects with plain strings). */
export const errorText = (e) => String((e && e.message) || e);

/** The answer of one engine call, from the JSON it returned. A failure comes back in-band as
 * exactly {"error": "Kind: message"} and is thrown here; an answer that has an `error` field
 * among others (often null) is a normal answer. */
export function engineAnswer(raw) {
	const answer = JSON.parse(raw);
	if (answer !== null && typeof answer === 'object' && !Array.isArray(answer)
		&& Object.keys(answer).length === 1 && typeof answer.error === 'string') {
		throw new Error(answer.error);
	}
	return answer;
}
