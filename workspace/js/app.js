/**
 * app.js — Entry point. Bootstraps Firebase, auth, and wires everything together.
 *
 * Module map:
 *   app.js          ← you are here (entry, Firebase init, wires)
 *   auth.js         ← Firebase Auth guard + UI updates
 *   db.js           ← Firestore helpers (refs, CRUD wrappers)
 *   projects.js     ← Project list sidebar + CRUD
 *   sections.js     ← Section/tab switching
 *   ui.js           ← Shared UI helpers (modal, toast, confirm)
 *   sections/
 *     overview.js   ← Overview section
 *     board.js      ← Visual board section
 *     nodes.js      ← Node flow section
 *     media.js      ← Media & links section
 *     kanban.js     ← Kanban section
 */

import { initializeApp }   from "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js";
import { getAuth }         from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";
import { getFirestore }    from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { initAuth }        from "./auth.js";
import { initProjects }    from "./projects.js";
import { initSections }    from "./sections.js";
import { initUI }          from "./ui.js";
import { runMigrations }   from "./migrate.js";
import { initHub }         from "./hub.js";
import { initLinks }       from "./apps/links.js";
import { initGmail }       from "./apps/gmail.js";

/* ── Firebase bootstrap ── */
let firebaseConfig;
let googleClientId = "";
let tmdbKey = "";
try { ({ firebaseConfig, googleClientId, tmdbKey } = await import("../../firebase.local.js")); }
catch { ({ firebaseConfig, googleClientId, tmdbKey } = await import("../../firebase.js")); }

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

/* ── Export Firebase handles for all modules ── */
export { auth, db, tmdbKey };

/* ── Boot sequence ── */
initHub();
initUI();
initAuth(auth, db, onUserReady);
_initBlueMap();

function _initBlueMap() {
    const urlEl  = document.getElementById("bluemap-url");
    const goBtn  = document.getElementById("bluemap-go");
    const content = document.getElementById("bluemap-content");
    const navBtn = document.getElementById("hub-btn-bluemap");
    if (!urlEl || !content) return;

    const saved = localStorage.getItem("bluemap_url");
    if (saved) urlEl.value = saved;

    function _apply() {
        const raw = urlEl.value.trim() || "https://server.tail8d3368.ts.net/";
        localStorage.setItem("bluemap_url", raw);

        let url;
        try { url = new URL(raw); } catch {
            content.innerHTML = `<div class="bluemap-open-wrap"><p style="color:var(--text-muted)">Invalid URL.</p></div>`;
            return;
        }

        if (url.protocol === "https:") {
            // Embedded iframe — works on HTTPS pages
            content.innerHTML = `<iframe src="${url.href}" class="bluemap-frame" title="BlueMap" allowfullscreen></iframe>`;
        } else {
            // HTTP — show open-tab fallback with setup instructions
            content.innerHTML = `
                <div class="bluemap-open-wrap">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="opacity:.3"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
                    <p><strong>HTTP can't be embedded here.</strong> To get the full in-page experience:</p>
                    <p class="bluemap-hint">Run this on your Minecraft server (Tailscale must be installed):</p>
                    <code class="bluemap-code">tailscale serve https / http://localhost:8182</code>
                    <p class="bluemap-hint">Then paste the resulting <code>https://…ts.net</code> URL above and click&nbsp;Go.</p>
                    <a href="${url.href}" target="_blank" rel="noopener noreferrer" class="ws-btn ws-btn-ghost" style="margin-top:.75rem">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        Open in new tab for now
                    </a>
                </div>`;
        }
    }

    goBtn.addEventListener("click", _apply);
    urlEl.addEventListener("keydown", e => { if (e.key === "Enter") _apply(); });

    // Probe Tailscale reachability — show the nav button only if the server responds
    const probeUrl = urlEl.value.trim() || "https://server.tail8d3368.ts.net/";
    const controller = new AbortController();
    const probeTimeout = setTimeout(() => controller.abort(), 3000);
    fetch(probeUrl, { mode: "no-cors", signal: controller.signal })
        .then(() => {
            clearTimeout(probeTimeout);
            if (navBtn) navBtn.style.display = "";
            _apply();
        })
        .catch(() => {
            clearTimeout(probeTimeout);
            // Not on Tailscale — keep button hidden
        });
}

function onUserReady(user) {
    runMigrations(user.uid);   // auto-import private.html categories as projects
    initProjects(db, user);
    initSections();
    initLinks(db, user);
    initGmail(db, user, googleClientId ?? "");
}
