/**
 * sections/overview.js — Overview section: description, meta, stats, quick notes.
 */

import {
    onSnapshot, updateDoc, query, getCountFromServer
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }                     from "../app.js";
import { currentProjectId,
         currentProject }               from "../projects.js";
import { refs }                         from "../db.js";
import { toast, escHtml, fmtDate }      from "../ui.js";

let _unsub = null;

export function init() {
    window.addEventListener("projectSelected", onProjectSelected);
    window.addEventListener("sectionActivated", (e) => {
        if (e.detail.section === "overview") _loadOverview();
    });

    document.getElementById("btn-save-notes")
        .addEventListener("click", saveNotes);

    _loadOverview();
}

function onProjectSelected() {
    _loadOverview();
}

function _loadOverview() {
    if (!currentProject) return;
    const p = currentProject;

    document.getElementById("overview-description").textContent =
        p.description || "No description.";

    document.getElementById("meta-type").textContent    = p.type    || "—";
    document.getElementById("meta-status").textContent  = p.status  || "—";
    document.getElementById("meta-created").textContent = fmtDate(p.createdAt);
    document.getElementById("meta-updated").textContent = fmtDate(p.updatedAt);

    document.getElementById("overview-notes").value = p.notes || "";

    _loadStats();
}

async function _loadStats() {
    if (!currentProjectId) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    try {
        const [tasksSnap, mediaSnap, nodesSnap] = await Promise.all([
            getCountFromServer(refs.kanbanTasks(db, uid, currentProjectId)),
            getCountFromServer(refs.media(db, uid, currentProjectId)),
            getCountFromServer(refs.nodes(db, uid, currentProjectId)),
        ]);
        document.getElementById("stat-tasks").textContent = tasksSnap.data().count;
        document.getElementById("stat-media").textContent = mediaSnap.data().count;
        document.getElementById("stat-nodes").textContent = nodesSnap.data().count;
    } catch { /* getCountFromServer not supported on older SDK — silently skip */ }
}

async function saveNotes() {
    if (!currentProjectId) return;
    const uid   = auth.currentUser?.uid;
    const notes = document.getElementById("overview-notes").value;

    try {
        await updateDoc(refs.project(db, uid, currentProjectId), { notes });
        const hint = document.getElementById("notes-saved-hint");
        hint.textContent = "Saved";
        hint.classList.add("visible");
        setTimeout(() => hint.classList.remove("visible"), 2000);
    } catch (err) {
        console.error(err);
        toast("Error saving notes", "error");
    }
}
