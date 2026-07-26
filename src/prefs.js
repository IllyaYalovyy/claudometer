// UX-DESIGN.md §7: one page, three groups (Display / Thresholds /
// Refresh). All validation lives in src/lib/settings_model.js; this file
// only builds rows and shuttles values between widgets and GSettings.
// Writes are guarded to only touch changed keys and every rule is
// idempotent, so widget↔settings echo settles instead of looping.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    CRITICAL_PERCENT_MAX,
    CRITICAL_PERCENT_MIN,
    HEADLINE_METRICS,
    INDICATOR_STYLES,
    REFRESH_INTERVALS_SEC,
    WARNING_PERCENT_MAX,
    WARNING_PERCENT_MIN,
    normalizeHeadlineMetric,
    normalizeIndicatorStyle,
    normalizeRefreshInterval,
    normalizeThresholds,
    refreshIntervalLabel,
    setCriticalPercent,
    setWarningPercent,
} from './lib/settings_model.js';

// §7 row wording, in INDICATOR_STYLES / HEADLINE_METRICS order.
const INDICATOR_STYLE_LABELS = ['Icon and percentage', 'Icon only', 'Percentage only'];
const HEADLINE_METRIC_LABELS = ['Most constrained', 'Session window', 'Weekly'];

// A ComboRow whose selection mirrors one settings key. `read` normalizes
// the stored value (garbage from a CLI write selects the default), `write`
// stores the picked choice.
function comboRow(settings, key, {title, choices, labels, read, write}) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(labels),
    });
    const sync = () => {
        const selected = choices.indexOf(read());
        if (row.selected !== selected)
            row.selected = selected;
    };
    sync();
    row.connect('notify::selected', () => {
        const choice = choices[row.selected];
        if (choice !== undefined && read() !== choice)
            write(choice);
    });
    // The prefs service process outlives the dialog; without this the
    // handler would keep writing to a destroyed row until GC.
    const changedId = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(changedId));
    return row;
}

function spinRow(title, lower, upper) {
    return new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: 1,
            page_increment: 5,
        }),
    });
}

export default class ClaudometerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        page.add(this._displayGroup(settings));
        page.add(this._thresholdsGroup(settings));
        page.add(this._refreshGroup(settings));
        window.add(page);
    }

    _displayGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Display'});
        group.add(comboRow(settings, 'indicator-style', {
            title: 'Indicator style',
            choices: INDICATOR_STYLES,
            labels: INDICATOR_STYLE_LABELS,
            read: () => normalizeIndicatorStyle(
                settings.get_string('indicator-style')),
            write: choice => settings.set_string('indicator-style', choice),
        }));
        group.add(comboRow(settings, 'headline-metric', {
            title: 'Headline metric',
            choices: HEADLINE_METRICS,
            labels: HEADLINE_METRIC_LABELS,
            read: () => normalizeHeadlineMetric(
                settings.get_string('headline-metric')),
            write: choice => settings.set_string('headline-metric', choice),
        }));
        return group;
    }

    _thresholdsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Thresholds',
            description: 'Percent of the headline window’s limit',
        });
        const warningRow = spinRow('Warning at',
            WARNING_PERCENT_MIN, WARNING_PERCENT_MAX);
        const criticalRow = spinRow('Critical at',
            CRITICAL_PERCENT_MIN, CRITICAL_PERCENT_MAX);

        const read = () => normalizeThresholds({
            warningPercent: settings.get_int('warning-percent'),
            criticalPercent: settings.get_int('critical-percent'),
        });
        const store = next => {
            if (settings.get_int('warning-percent') !== next.warningPercent)
                settings.set_int('warning-percent', next.warningPercent);
            if (settings.get_int('critical-percent') !== next.criticalPercent)
                settings.set_int('critical-percent', next.criticalPercent);
        };
        const sync = () => {
            const current = read();
            if (warningRow.value !== current.warningPercent)
                warningRow.value = current.warningPercent;
            if (criticalRow.value !== current.criticalPercent)
                criticalRow.value = current.criticalPercent;
        };

        // Repair a stored pair that violates warning<critical (possible via
        // a CLI write; the schema cannot express the cross-field rule).
        store(read());
        sync();
        warningRow.connect('notify::value',
            () => store(setWarningPercent(read(), warningRow.value)));
        criticalRow.connect('notify::value',
            () => store(setCriticalPercent(read(), criticalRow.value)));
        const changedIds = [
            settings.connect('changed::warning-percent', sync),
            settings.connect('changed::critical-percent', sync),
        ];
        group.connect('destroy',
            () => changedIds.forEach(id => settings.disconnect(id)));

        group.add(warningRow);
        group.add(criticalRow);
        return group;
    }

    _refreshGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Refresh'});
        group.add(comboRow(settings, 'refresh-interval-seconds', {
            title: 'Interval',
            choices: REFRESH_INTERVALS_SEC,
            labels: REFRESH_INTERVALS_SEC.map(refreshIntervalLabel),
            read: () => normalizeRefreshInterval(
                settings.get_int('refresh-interval-seconds')),
            write: sec => settings.set_int('refresh-interval-seconds', sec),
        }));
        return group;
    }
}
