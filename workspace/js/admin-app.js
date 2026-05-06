/**
 * admin-app.js — Admin Panel logic.
 *
 * Uses the workspace shell layout (hub-nav, ws-sidebar, ws-main).
 * Only accessible by maze.development.admin@gmail.com.
 */

import { initializeApp }
    from "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
    from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";
import { getFirestore, getDocs, deleteDoc, updateDoc,
         doc, collection, query, orderBy }
    from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

const ADMIN_EMAIL = "maze.development.admin@gmail.com";

/* ── Firebase bootstrap ── */
let firebaseConfig;
try  { ({ firebaseConfig } = await import("../../firebase.local.js")); }
catch { ({ firebaseConfig } = await import("../../firebase.js")); }

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

/* ── State ── */
let _allUsers     = [];
let _selectedUid  = null;
let _selectedUser = null;
let _userProjects = [];
let _userLinks    = [];
let _activeTab    = "projects";
let _userSearch   = "";

/* ════════════════════════════════════════════════════════════
   SIDEBAR TOGGLE  (reuse workspace behaviour)
   ════════════════════════════════════════════════════════════ */
const _sidebar   = document.getElementById("ws-sidebar");
const _toggleBtn = document.getElementById("ws-sidebar-toggle");
const _overlay   = document.getElementById("ws-sidebar-overlay");

_toggleBtn?.addEventListener("click", () => {
    const collapsed = _sidebar.classList.toggle("collapsed");
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    _toggleBtn.classList.toggle("rotated", collapsed);
});
_overlay?.addEventListener("click", () => {
    _sidebar.classList.remove("mobile-open");
    _overlay.classList.remove("visible");
});

/* ════════════════════════════════════════════════════════════
   AUTH
   ════════════════════════════════════════════════════════════ */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "../login.html?redirect=workspace/admin.html";
        return;
    }
    if (user.email !== ADMIN_EMAIL) {
        window.location.href = "index.html";
        return;
    }

    // Update hub-nav avatar
    const nameEl   = document.getElementById("user-name");
    const avatarEl = document.getElementById("user-avatar");
    const display  = user.displayName || user.email || "Admin";
    if (nameEl)   nameEl.textContent = display;
    if (avatarEl) avatarEl.textContent = display[0].toUpperCase();

    const popupEl      = document.getElementById("avatar-popup");
    const popupSignout = document.getElementById("avatar-popup-signout");
    avatarEl?.addEventListener("click", e => {
        e.stopPropagation();
        popupEl?.classList.toggle("open");
    });
    document.addEventListener("click", () => popupEl?.classList.remove("open"));
    popupSignout?.addEventListener("click", async () => {
        await signOut(auth);
        window.location.href = "../login.html";
    });

    await _loadAllUsers();
    _renderUserList();
});

/* ════════════════════════════════════════════════════════════
   USER LIST
   ════════════════════════════════════════════════════════════ */
async function _loadAllUsers() {
    const snap = await getDocs(collection(db, "user_profiles"));
    _allUsers = snap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .sort((a, b) => (a.email || "").localeCompare(b.email || ""));

    document.getElementById("adm-user-count").textContent =
        `(${_allUsers.length})`;
}

function _renderUserList() {
    const list = document.getElementById("adm-user-list");
    const term = _userSearch.toLowerCase();

    const filtered = _allUsers.filter(u =>
        !term ||
        (u.email       || "").toLowerCase().includes(term) ||
        (u.displayName || "").toLowerCase().includes(term)
    );

    if (filtered.length === 0) {
        list.innerHTML = `<p style="font-size:0.74rem;color:#444;padding:0.4rem 0.9rem;">${_userSearch ? "No match." : "No accounts found."}</p>`;
        return;
    }

    list.innerHTML = filtered.map(u => {
        const init   = (u.displayName || u.email || "?")[0].toUpperCase();
        const active = _selectedUid === u.uid ? " active" : "";
        const name   = _esc(u.displayName || u.email || u.uid);
        const email  = _esc(u.email || u.uid);
        return `
        <button class="ws-project-item${active}" data-uid="${_esc(u.uid)}">
            <span class="adm-list-avatar">${_esc(init)}</span>
            <span class="ws-project-item-name" style="min-width:0">
                <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span>
                <span style="display:block;font-size:0.62rem;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${email}</span>
            </span>
        </button>`;
    }).join("");

    list.querySelectorAll(".ws-project-item").forEach(btn =>
        btn.addEventListener("click", () => _selectUser(btn.dataset.uid))
    );
}

document.getElementById("adm-user-search").addEventListener("input", e => {
    _userSearch = e.target.value;
    _renderUserList();
});

/* ════════════════════════════════════════════════════════════
   SELECT USER
   ════════════════════════════════════════════════════════════ */
async function _selectUser(uid) {
    _selectedUid  = uid;
    _selectedUser = _allUsers.find(u => u.uid === uid);
    _renderUserList();

    if (!_selectedUser) return;

    const u = _selectedUser;

    // Show topbar + tabs
    document.getElementById("ws-topbar").classList.remove("hidden");
    document.getElementById("ws-tabs").classList.remove("hidden");

    // Topbar content
    const init = (u.displayName || u.email || "?")[0].toUpperCase();
    document.getElementById("adm-topbar-avatar").textContent = init;
    document.getElementById("adm-topbar-name").textContent   = u.displayName || u.email || uid;
    document.getElementById("adm-topbar-email").textContent  = u.email || "";

    // Account tab
    document.getElementById("adm-acct-name").textContent  = u.displayName || "—";
    document.getElementById("adm-acct-email").textContent = u.email || "—";
    document.getElementById("adm-acct-uid").textContent   = uid;
    const photoEl = document.getElementById("adm-acct-photo");
    photoEl.textContent = u.photoURL || "—";
    photoEl.href        = u.photoURL || "#";

    // Show first tab
    _switchTab("projects");

    // Hide empty state
    document.getElementById("adm-section-empty").classList.remove("active");
    document.getElementById("adm-section-empty").style.display = "none";

    await _refreshAll(uid);
}

document.getElementById("adm-btn-refresh")?.addEventListener("click", () => {
    if (_selectedUid) _refreshAll(_selectedUid);
});

async function _refreshAll(uid) {
    await Promise.all([_loadUserProjects(uid), _loadUserGallery(uid)]);
}

/* ════════════════════════════════════════════════════════════
   TABS  (reuse ws-tab classes)
   ════════════════════════════════════════════════════════════ */
const _sectionMap = {
    projects: "adm-section-projects",
    gallery:  "adm-section-gallery",
    account:  "adm-section-account",
};

function _switchTab(tab) {
    _activeTab = tab;
    document.querySelectorAll(".ws-tab").forEach(btn =>
        btn.classList.toggle("active", btn.dataset.tab === tab)
    );
    Object.entries(_sectionMap).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = key === tab ? "" : "none";
        el.classList.toggle("active", key === tab);
    });
}

document.querySelectorAll(".ws-tab[data-tab]").forEach(btn =>
    btn.addEventListener("click", () => _switchTab(btn.dataset.tab))
);

/* ════════════════════════════════════════════════════════════
   PROJECTS
   ════════════════════════════════════════════════════════════ */
async function _loadUserProjects(uid) {
    const container = document.getElementById("adm-projects-list");
    container.innerHTML = `<p class="ws-placeholder">Loading projects&#8230;</p>`;
    try {
        const snap = await getDocs(
            query(collection(db, "users", uid, "projects"), orderBy("createdAt", "desc"))
        );
        _userProjects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const countEl = document.getElementById("adm-tab-count-projects");
        if (countEl) countEl.textContent = _userProjects.length || "";
        _renderProjects(uid);
    } catch (err) {
        console.error(err);
        container.innerHTML = `<p style="color:var(--danger);font-size:.78rem">Failed to load: ${_esc(err.message)}</p>`;
    }
}

function _renderProjects(uid) {
    const container = document.getElementById("adm-projects-list");
    if (_userProjects.length === 0) {
        container.innerHTML = `<p class="ws-placeholder">No projects.</p>`;
        return;
    }

    container.innerHTML = _userProjects.map(p => {
        const memberCount = Object.keys(p.members || {}).length;
        const iconHtml = p.icon
            ? `<span class="material-symbols-outlined adm-project-icon">${_esc(p.icon)}</span>`
            : `<span class="adm-project-dot"></span>`;
        const membersBadge = memberCount > 0
            ? `<span class="adm-chip adm-chip--purple">${memberCount} member${memberCount !== 1 ? "s" : ""}</span>`
            : "";

        return `
        <div class="adm-project-card">
            <div class="adm-project-card-main">
                <div class="adm-project-card-left">
                    ${iconHtml}
                    <div class="adm-project-card-info">
                        <div class="adm-project-title">${_esc(p.title || "Untitled")}</div>
                        <div class="adm-project-meta">
                            <span class="adm-chip adm-chip--dim">${_esc(p.type || "general")}</span>
                            <span class="adm-status-badge adm-status-${_esc((p.status || "active").replace(/\s/g,"-"))}">${_esc(p.status || "active")}</span>
                            ${membersBadge}
                        </div>
                    </div>
                </div>
                <div class="adm-project-card-actions">
                    <button class="ws-icon-btn adm-edit-project"
                            data-id="${_esc(p.id)}" data-uid="${_esc(uid)}"
                            title="Edit project">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="ws-icon-btn adm-delete-project"
                            data-id="${_esc(p.id)}" data-uid="${_esc(uid)}"
                            data-title="${_esc(p.title || "Untitled")}"
                            title="Delete project"
                            style="color:var(--danger,#e05c5c)">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                </div>
            </div>
            ${p.description ? `<div class="adm-project-desc">${_esc(p.description)}</div>` : ""}
        </div>`;
    }).join("");

    container.querySelectorAll(".adm-edit-project").forEach(btn =>
        btn.addEventListener("click", () => _openEditProject(btn.dataset.uid, btn.dataset.id))
    );
    container.querySelectorAll(".adm-delete-project").forEach(btn =>
        btn.addEventListener("click", () => _deleteProject(btn.dataset.uid, btn.dataset.id, btn.dataset.title))
    );
}

function _openEditProject(uid, pid) {
    const p = _userProjects.find(x => x.id === pid);
    if (!p) return;
    document.getElementById("adm-edit-project-id").value  = pid;
    document.getElementById("adm-edit-project-uid").value = uid;
    document.getElementById("adm-edit-title").value       = p.title       || "";
    document.getElementById("adm-edit-desc").value        = p.description || "";
    document.getElementById("adm-edit-type").value        = p.type        || "general";
    document.getElementById("adm-edit-status").value      = p.status      || "active";
    document.getElementById("adm-modal-edit-project").classList.remove("hidden");
    setTimeout(() => document.getElementById("adm-edit-title").focus(), 60);
}

document.getElementById("adm-form-project").addEventListener("submit", async e => {
    e.preventDefault();
    const pid  = document.getElementById("adm-edit-project-id").value;
    const uid  = document.getElementById("adm-edit-project-uid").value;
    const data = {
        title:       document.getElementById("adm-edit-title").value.trim(),
        description: document.getElementById("adm-edit-desc").value.trim(),
        type:        document.getElementById("adm-edit-type").value,
        status:      document.getElementById("adm-edit-status").value,
    };
    try {
        await updateDoc(doc(db, "users", uid, "projects", pid), data);
        const idx = _userProjects.findIndex(p => p.id === pid);
        if (idx !== -1) _userProjects[idx] = { ..._userProjects[idx], ...data };
        _renderProjects(uid);
        _closeModal();
        _toast("Project updated", "success");
    } catch (err) {
        console.error(err);
        _toast("Failed: " + err.message, "error");
    }
});

async function _deleteProject(uid, pid, title) {
    if (!window.confirm(`Delete project "${title}"?\n\nNote: sub-collection data (board items, kanban tasks, etc.) must be deleted via Firebase Console.\n\nContinue?`)) return;
    try {
        await deleteDoc(doc(db, "users", uid, "projects", pid));
        _userProjects = _userProjects.filter(p => p.id !== pid);
        const countEl = document.getElementById("adm-tab-count-projects");
        if (countEl) countEl.textContent = _userProjects.length || "";
        _renderProjects(uid);
        _toast("Project deleted");
    } catch (err) {
        console.error(err);
        _toast("Failed: " + err.message, "error");
    }
}

/* ════════════════════════════════════════════════════════════
   LINK GALLERY
   ════════════════════════════════════════════════════════════ */
async function _loadUserGallery(uid) {
    const container = document.getElementById("adm-gallery-list");
    container.innerHTML = `<p class="ws-placeholder">Loading&#8230;</p>`;
    try {
        const snap = await getDocs(
            query(collection(db, "users", uid, "gallery-links"), orderBy("createdAt", "desc"))
        );
        _userLinks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const countEl = document.getElementById("adm-tab-count-gallery");
        if (countEl) countEl.textContent = _userLinks.length || "";
        _renderGallery(uid);
    } catch (err) {
        console.error(err);
        container.innerHTML = `<p style="color:var(--danger);font-size:.78rem">Failed: ${_esc(err.message)}</p>`;
    }
}

function _renderGallery(uid) {
    const container = document.getElementById("adm-gallery-list");
    if (_userLinks.length === 0) {
        container.innerHTML = `<p class="ws-placeholder">No links in gallery.</p>`;
        return;
    }

    const byCategory = new Map();
    byCategory.set("_uncat", []);
    _userLinks.forEach(l => {
        const cat = l.category || "_uncat";
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat).push(l);
    });

    let html = "";
    byCategory.forEach((links, cat) => {
        if (links.length === 0) return;
        if (cat !== "_uncat") {
            html += `<div class="adm-gallery-category">${_esc(cat)}</div>`;
        }
        html += links.map(l => `
        <div class="adm-link-card">
            <div class="adm-link-card-body">
                <div class="adm-link-title">${_esc(l.title || l.url || "Untitled")}</div>
                <a class="adm-link-url" href="${_esc(l.url || "#")}"
                   target="_blank" rel="noopener noreferrer">${_esc(l.url || "")}</a>
                ${l.type ? `<span class="adm-chip adm-chip--dim" style="margin-top:3px">${_esc(l.type)}</span>` : ""}
            </div>
            <button class="ws-icon-btn adm-delete-link"
                    data-id="${_esc(l.id)}" data-uid="${_esc(uid)}"
                    data-title="${_esc(l.title || l.url || "link")}"
                    title="Delete link"
                    style="color:var(--danger,#e05c5c)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
        </div>`).join("");
    });

    container.innerHTML = html;

    container.querySelectorAll(".adm-delete-link").forEach(btn =>
        btn.addEventListener("click", () => _deleteLink(btn.dataset.uid, btn.dataset.id, btn.dataset.title))
    );
}

async function _deleteLink(uid, linkId, title) {
    if (!window.confirm(`Delete link "${title}"?`)) return;
    try {
        await deleteDoc(doc(db, "users", uid, "gallery-links", linkId));
        _userLinks = _userLinks.filter(l => l.id !== linkId);
        const countEl = document.getElementById("adm-tab-count-gallery");
        if (countEl) countEl.textContent = _userLinks.length || "";
        _renderGallery(uid);
        _toast("Link deleted");
    } catch (err) {
        console.error(err);
        _toast("Failed: " + err.message, "error");
    }
}

/* ════════════════════════════════════════════════════════════
   MODAL
   ════════════════════════════════════════════════════════════ */
function _closeModal() {
    document.getElementById("adm-modal-edit-project")?.classList.add("hidden");
}

document.getElementById("adm-modal-close")?.addEventListener("click", _closeModal);
document.getElementById("adm-modal-cancel")?.addEventListener("click", _closeModal);

document.getElementById("adm-modal-edit-project")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) _closeModal();
});
document.addEventListener("keydown", e => {
    if (e.key === "Escape") _closeModal();
});

/* ── Copy UID button ── */
document.querySelectorAll(".adm-copy-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const src = document.getElementById(btn.dataset.copyId);
        if (!src) return;
        navigator.clipboard.writeText(src.textContent).then(() => _toast("Copied!"));
    });
});

/* ════════════════════════════════════════════════════════════
   UTILITIES
   ════════════════════════════════════════════════════════════ */
function _esc(str) {
    return String(str ?? "")
        .replace(/&/g,  "&amp;")
        .replace(/</g,  "&lt;")
        .replace(/>/g,  "&gt;")
        .replace(/"/g,  "&quot;");
}

let _toastTimer;
function _toast(msg, type = "") {
    const el = document.getElementById("ws-toast");
    if (!el) return;
    clearTimeout(_toastTimer);
    el.textContent = msg;
    el.className   = "ws-toast show" + (type ? " " + type : "");
    _toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
