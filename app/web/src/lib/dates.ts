// Dates as the graph shows them, in the format of the settings (commits.dateFormat).
import type { DateFormat } from '../lib/api/generated/DateFormat';

const two = (n: number): string => String(n).padStart(2, '0');

const local = (d: Date, time: boolean) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` + (time ? ` ${two(d.getHours())}:${two(d.getMinutes())}` : '');
const iso = (d: Date, time: boolean) => (time ? d.toISOString().replace('T', ' ').slice(0, 16) + 'Z' : d.toISOString().slice(0, 10));

/** How long ago, in the largest unit that fits: "3 minutes ago", "2 years ago". */
export function relative(seconds: number, nowSeconds = Date.now() / 1000, words: (n: number, unit: string, ago: boolean) => string = englishRelative): string {
	const diff = nowSeconds - seconds;
	const ago = diff >= 0;
	const abs = Math.abs(diff);
	const units: [string, number][] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
	for (const [unit, size] of units) {
		if (abs >= size) return words(Math.floor(abs / size), unit, ago);
	}
	return words(0, 'minute', ago);
}

function englishRelative(n: number, unit: string, ago: boolean): string {
	if (n === 0) return 'just now';
	const text = `${n} ${unit}${n === 1 ? '' : 's'}`;
	return ago ? text + ' ago' : 'in ' + text;
}

/** `seconds` since the epoch in the given format; `relativeWords` words a relative date. */
export function formatDate(seconds: number, format: DateFormat = 'date-time', relativeWords?: (n: number, unit: string, ago: boolean) => string): string {
	const d = new Date(seconds * 1000);
	switch (format) {
		case 'date-time': return local(d, true);
		case 'date': return local(d, false);
		case 'iso-date-time': return iso(d, true);
		case 'iso-date': return iso(d, false);
		case 'relative': return relative(seconds, undefined, relativeWords);
	}
}
