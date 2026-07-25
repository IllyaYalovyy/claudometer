import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudometerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Real preferences arrive with a later task; for now the window
        // only needs to open without errors.
        window.add(new Adw.PreferencesPage());
    }
}
