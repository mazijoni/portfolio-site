/**
 * hub.js — Hub app switching (Outlook-style sidebar nav).
 */

import { isFeatureEnabled } from "./features.js";

const _HIDDEN_BY_DEFAULT = new Set(['sheet', 'bluemap']);
const _PREF_KEY = 'hub_tab_prefs';

function _loadTabPrefs() {
    try { return JSON.parse(localStorage.getItem(_PREF_KEY)) || {}; }
    catch { return {}; }
}

function _applyTabPrefs() {
    const prefs = _loadTabPrefs();
    document.querySelectorAll('.hub-app-btn[data-app]').forEach(btn => {
        const app = btn.dataset.app;
        if (app === 'workspace' || app === 'settings') return;
        const defaultVisible = !_HIDDEN_BY_DEFAULT.has(app);
        const userVisible  = prefs[app] !== undefined ? prefs[app] : defaultVisible;
        const flagEnabled  = isFeatureEnabled(app);
        btn.style.display  = (userVisible && flagEnabled) ? '' : 'none';
    });
}

function _setTabPref(app, visible) {
    const prefs = _loadTabPrefs();
    prefs[app] = visible;
    localStorage.setItem(_PREF_KEY, JSON.stringify(prefs));
    _applyTabPrefs();
    if (!visible) {
        const activeBtn = document.querySelector(`.hub-app-btn[data-app="${app}"].active`);
        if (activeBtn) switchApp('workspace');
    }
}

function _initTabSettings() {
    const prefs = _loadTabPrefs();
    document.querySelectorAll('.hub-tab-toggle[data-app]').forEach(toggle => {
        const app = toggle.dataset.app;
        const defaultVisible = !_HIDDEN_BY_DEFAULT.has(app);
        toggle.checked = prefs[app] !== undefined ? prefs[app] : defaultVisible;
        toggle.addEventListener('change', () => _setTabPref(app, toggle.checked));
    });
}

export function initHub() {
    const btns = document.querySelectorAll(".hub-app-btn");

    btns.forEach(btn => {
        btn.addEventListener("click", () => switchApp(btn.dataset.app));
    });

    // Tutorial nav
    document.querySelectorAll(".tut-nav-item").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tut-nav-item").forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".tut-page").forEach(p => p.classList.remove("active"));
            btn.classList.add("active");
            const page = document.getElementById("tut-" + btn.dataset.page);
            if (page) page.classList.add("active");
        });
    });

    _applyTabPrefs();
    _initTabSettings();

    // Restore last active app from session storage
    const saved = sessionStorage.getItem("hub_app");
    if (saved && document.getElementById("app-" + saved)) {
        switchApp(saved);
    }
}

/** Re-apply tab visibility after feature flags are loaded. */
export function applyHubFeatureFlags() {
    _applyTabPrefs();
}

export function switchApp(appName) {
    document.querySelectorAll(".hub-app-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.app === appName);
    });
    document.querySelectorAll(".hub-app").forEach(a => {
        a.classList.remove("active");
    });
    const appEl = document.getElementById("app-" + appName);
    if (appEl) appEl.classList.add("active");

    document.body.dataset.hubApp = appName;
    sessionStorage.setItem("hub_app", appName);
}
