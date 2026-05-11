/**
 * hub.js — Hub app switching (Outlook-style sidebar nav).
 */

const _HIDDEN_BY_DEFAULT = new Set(['sheet', 'bluemap']);
const _PREF_KEY = 'hub_tab_prefs';
const _SECTION_PREF_KEY = 'ws_section_tab_prefs';

function _loadTabPrefs() {
    try { return JSON.parse(localStorage.getItem(_PREF_KEY)) || {}; }
    catch { return {}; }
}

function _loadSectionPrefs() {
    try { return JSON.parse(localStorage.getItem(_SECTION_PREF_KEY)) || {}; }
    catch { return {}; }
}

function _applyTabPrefs() {
    const prefs = _loadTabPrefs();
    document.querySelectorAll('.hub-app-btn[data-app]').forEach(btn => {
        const app = btn.dataset.app;
        if (app === 'workspace' || app === 'settings') return;
        const defaultVisible = !_HIDDEN_BY_DEFAULT.has(app);
        const visible = prefs[app] !== undefined ? prefs[app] : defaultVisible;
        btn.style.display = visible ? '' : 'none';
    });
}

function _applySectionTabPrefs() {
    const prefs = _loadSectionPrefs();
    document.querySelectorAll('.ws-tab[data-section]').forEach(btn => {
        const section = btn.dataset.section;
        if (section === 'overview') return; // always visible
        const visible = prefs[section] !== undefined ? prefs[section] : true;
        btn.style.display = visible ? '' : 'none';
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

function _setSectionTabPref(section, visible) {
    const prefs = _loadSectionPrefs();
    prefs[section] = visible;
    localStorage.setItem(_SECTION_PREF_KEY, JSON.stringify(prefs));
    _applySectionTabPrefs();
    if (!visible) {
        // If the now-hidden tab is active, fall back to overview
        const activeTab = document.querySelector(`.ws-tab[data-section="${section}"].active`);
        if (activeTab) {
            window.dispatchEvent(new CustomEvent('activateSection', { detail: { section: 'overview' } }));
        }
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

    const sectionPrefs = _loadSectionPrefs();
    document.querySelectorAll('.section-tab-toggle[data-section]').forEach(toggle => {
        const section = toggle.dataset.section;
        toggle.checked = sectionPrefs[section] !== undefined ? sectionPrefs[section] : true;
        toggle.addEventListener('change', () => _setSectionTabPref(section, toggle.checked));
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
    _applySectionTabPrefs();
    _initTabSettings();

    // Restore last active app from session storage
    const saved = sessionStorage.getItem("hub_app");
    if (saved && document.getElementById("app-" + saved)) {
        switchApp(saved);
    }
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
