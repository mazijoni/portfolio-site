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
const isLocal =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";

if (isLocal) {
    try { ({ firebaseConfig, googleClientId, tmdbKey } = await import("../../firebase.local.js")); }
    catch { ({ firebaseConfig, googleClientId, tmdbKey } = await import("../../firebase.js")); }
} else {
    ({ firebaseConfig, googleClientId, tmdbKey } = await import("../../firebase.js"));
}

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

/* ── Export Firebase handles for all modules ── */
export { auth, db, tmdbKey };

/* ── Boot sequence ── */
initHub();
initUI();
initAuth(auth, db, onUserReady);

function onUserReady(user) {
    runMigrations(user.uid);   // auto-import private.html categories as projects
    initProjects(db, user);
    initSections();
    initLinks(db, user);
    initGmail(db, user, googleClientId ?? "");
}
