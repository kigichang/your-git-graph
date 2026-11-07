// Dates as the graph shows them. The formats of the settings (commits.dateFormat) come with
// the settings panel; until then one plain form.

const two = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:MM` in the local time zone, from seconds since the epoch. */
export function formatDate(seconds: number): string {
	const d = new Date(seconds * 1000);
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
