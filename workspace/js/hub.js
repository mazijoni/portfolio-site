/**
 * hub.js — Hub app switching (Outlook-style sidebar nav).
 */

export function initHub() {
    const btns = document.querySelectorAll(".hub-app-btn");

    btns.forEach(btn => {
        btn.addEventListener("click", () => switchApp(btn.dataset.app));
    });

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
