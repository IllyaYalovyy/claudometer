// Pure formatting: numbers and instants -> the display strings of
// designs/UX-DESIGN.md §3.3, §4.3, §4.4. No Shell imports; importable
// under plain `gjs -m`. All instants are epoch ms; rendering uses the
// local timezone via Date accessors.

import {DEFAULT_STALE_AFTER_MS} from './derive.js';

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatPercent(p) {
    return `${Math.round(p)}%`;
}

// §4.3 countdown: "2 h 15 m", "12 m", "1 h"; under a minute is "<1 min".
// Sub-minute remainders truncate — a countdown must never overpromise.
export function formatCountdown(ms) {
    if (ms < MINUTE_MS)
        return '<1 min';
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    if (hours === 0)
        return `${minutes} m`;
    if (minutes === 0)
        return `${hours} h`;
    return `${hours} h ${minutes} m`;
}

function formatClock(date, clock24) {
    const minutes = String(date.getMinutes()).padStart(2, '0');
    if (clock24)
        return `${String(date.getHours()).padStart(2, '0')}:${minutes}`;
    const hours = date.getHours() % 12 || 12;
    const period = date.getHours() < 12 ? 'AM' : 'PM';
    return `${hours}:${minutes} ${period}`;
}

// §4.3 reset row: relative + absolute together within 24 h ("Resets in
// 2 h 15 m (17:00)"); beyond 24 h the countdown is noise, so date only
// ("Resets Tue, Jul 28"). Exactly 24 h away still counts down.
export function formatResetRow(resetsAt, now, {clock24}) {
    const remaining = resetsAt - now;
    const reset = new Date(resetsAt);
    if (remaining > DAY_MS) {
        return `Resets ${WEEKDAYS[reset.getDay()]}, ` +
            `${MONTHS[reset.getMonth()]} ${reset.getDate()}`;
    }
    return `Resets in ${formatCountdown(remaining)} ` +
        `(${formatClock(reset, clock24)})`;
}

// Stale ages read in "min"/"h min" (footer prose), unlike the terse
// countdown units — §4.4 vs §4.3. Exported for the §8 stale qualifier in
// the indicator's accessible name.
export function formatAge(ms) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    if (hours === 0)
        return `${minutes} min`;
    if (minutes === 0)
        return `${hours} h`;
    return `${hours} h ${minutes} min`;
}

// §4.4 footer: "Updated just now" under 30 s, then whole minutes rounded
// to nearest; past staleAfterMs (same strict "older than" boundary as
// derive.js's STALE) the line explains the dimmed icon instead. The
// failure clause needs `lastRefreshFailed` — old data alone is not
// evidence of a failed refresh (#16: a healthy CLI throttles rewrites of
// its cache, so a working setup routinely ages past the threshold).
export function formatFreshness(fetchedAt, now, opts = {}) {
    const {
        staleAfterMs = DEFAULT_STALE_AFTER_MS,
        lastRefreshFailed = false,
    } = opts;
    const age = now - fetchedAt;
    if (age > staleAfterMs) {
        const aged = `Data is ${formatAge(age)} old`;
        return lastRefreshFailed ? `${aged} — last refresh failed` : aged;
    }
    if (age < 30000)
        return 'Updated just now';
    return `Updated ${Math.round(age / MINUTE_MS)} min ago`;
}

// §4.5 degraded footer: the fetch was attempted, nothing usable came back
// — "tried", never "updated". Same 30 s / whole-minute rhythm as
// formatFreshness so the footer reads consistently across states.
export function formatLastTried(triedAt, now) {
    const age = now - triedAt;
    if (age < 30000)
        return 'Last tried just now';
    return `Last tried ${Math.round(age / MINUTE_MS)} min ago`;
}
