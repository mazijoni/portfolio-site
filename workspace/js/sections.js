/**
 * sections.js — Tab / section switching.
 *
 * Only one section is visible at a time. Each section module is loaded lazily
 * the first time its tab is activated to avoid unnecessary Firestore subscriptions.
 */

const SECTIONS = ["empty", "overview", "media", "kanban"];

let _activeSection = "empty";
const _loaded = new Set();

export function initSections() {
    // Tab click
    document.querySelectorAll(".ws-tab").forEach(btn => {
        btn.addEventListener("click", () => {
            activateSection(btn.dataset.section);
        });
    });

    // When a project is selected → restore saved section or default to overview
    window.addEventListener("projectSelected", () => {
        const saved = sessionStorage.getItem("ws_section");
        activateSection(saved && SECTIONS.includes(saved) && saved !== "empty" ? saved : "overview");
    });

    // When project is deselected → show empty state
    window.addEventListener("projectDeselected", () => {
        _showSection("empty");
        _activeSection = "empty";
        // Reset tab highlight
        document.querySelectorAll(".ws-tab").forEach(t => t.classList.remove("active"));
    });

    // Hash-based deep link — media tab doesn't need a project selected
    const initHash = location.hash.replace("#", "");
    if (initHash === "media") {
        activateSection("media");
    }
}

export function activateSection(name) {
    if (!SECTIONS.includes(name)) return;

    // Highlight tab
    document.querySelectorAll(".ws-tab").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.section === name);
    });

    _showSection(name);
    _activeSection = name;
    if (name !== "empty") sessionStorage.setItem("ws_section", name);

    // Lazy-load section module
    if (!_loaded.has(name)) {
        _loaded.add(name);
        _importSection(name);
    } else {
        // Re-trigger section refresh when already loaded
        window.dispatchEvent(new CustomEvent("sectionActivated", { detail: { section: name } }));
    }
}

function _showSection(name) {
    SECTIONS.forEach(s => {
        const el = document.getElementById(`section-${s}`);
        if (el) el.classList.toggle("active", s === name);
    });
}

async function _importSection(name) {
    const moduleMap = {
        overview: "./sections/overview.js",
        media:    "./sections/media.js",
        kanban:   "./sections/kanban.js",
    };
    if (!moduleMap[name]) return;
    try {
        const mod = await import(moduleMap[name]);
        if (mod.init) mod.init();
    } catch (err) {
        console.error(`[sections] Failed to load ${name}:`, err);
    }
}
