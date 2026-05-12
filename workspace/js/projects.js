/**
 * projects.js — Project sidebar list + create / edit / delete.
 *
 * State:
 *   currentProjectId  — the active project id (null = no selection)
 *   currentProject    — the active project data object
 *
 * Emits a custom event "projectSelected" on window when the user selects a project.
 */

/** Admin account — has full read/write access to all users' data. */
const ADMIN_EMAIL = "maze.development.admin@gmail.com";

import {
    onSnapshot, addDoc, updateDoc, deleteDoc, getDoc,
    doc, query, orderBy, serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth } from "./app.js";

import { refs }                    from "./db.js";
import { openModal, closeModal,
         setModalTitle, toast,
         confirm, escHtml, fmtDate } from "./ui.js";
import { materialIcons }           from "./icons.js";

/* ── Module state ── */
let _db             = null;
let _user           = null;
let _unsub          = null;
let _unsubMemberships = null;
let _projects       = [];    // [{id, ...data}]  — own projects
let _sharedProjects = [];    // [{id, ...data, ownerUid, _isShared}]
let _adminProjects  = [];    // [{id, ...data, ownerUid, _isAdmin}] — all users' projects (admin only)
let _adminFilterUid = null;  // null = all accounts; string = filter by ownerUid

export let currentProjectId = null;
export let currentProject   = null;

/**
 * Returns the uid that owns the data for the currently selected project.
 * For own projects this equals the logged-in uid; for shared projects it is
 * the original owner's uid.
 */
export function getDataUid() {
    return currentProject?.ownerUid ?? auth.currentUser?.uid;
}

/** Returns true if the currently logged-in user is the global admin. */
export function isCurrentUserAdmin() {
    return auth.currentUser?.email === ADMIN_EMAIL;
}

/**
 * Returns true if the current user can add/edit/delete items in the active project.
 * Owners, contributors, and the admin can edit; viewers cannot.
 */
export function canCurrentUserEdit() {
    if (isCurrentUserAdmin()) return true;
    if (!currentProject) return true;
    const isOwner = !currentProject.ownerUid || currentProject.ownerUid === auth.currentUser?.uid;
    return isOwner || currentProject.memberRole === "contributor";
}

/* ── Init ── */
export function initProjects(db, user) {
    _db   = db;
    _user = user;

    // Wire buttons
    document.getElementById("btn-new-project")
        .addEventListener("click", () => openProjectForm(null));
    document.getElementById("btn-new-project-empty")
        .addEventListener("click", () => openProjectForm(null));
    document.getElementById("btn-edit-project")
        .addEventListener("click", () => openProjectForm(currentProjectId));
    document.getElementById("btn-delete-project")
        .addEventListener("click", deleteCurrentProject);

    document.getElementById("form-project")
        .addEventListener("submit", onProjectFormSubmit);

    document.getElementById("btn-pick-icon").addEventListener("click", _openIconPicker);
    document.getElementById("btn-clear-icon").addEventListener("click", () => _setProjectIcon(""));
    document.getElementById("ip-search").addEventListener("input", (e) => _renderIconPicker(e.target.value));
    document.getElementById("ip-grid").addEventListener("click", (e) => {
        const btn = e.target.closest(".ip-icon-btn");
        if (btn) {
            _setProjectIcon(btn.dataset.icon);
            closeModal("modal-icon-picker");
        }
    });

    // Live project list
    _subscribeProjects();
    _subscribeMemberships();

    // Admin: also load every other user's projects
    if (user.email === ADMIN_EMAIL) {
        _loadAllUsersProjects();
    }
}

let _restored = false;

function _subscribeProjects() {
    if (_unsub) _unsub();
    const q = query(refs.projects(_db, _user.uid), orderBy("createdAt", "desc"));
    _unsub = onSnapshot(q, (snap) => {
        _projects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _renderProjectList();
        // Keep currentProject in sync with Firestore data
        if (currentProjectId && !currentProject?._isShared) {
            const updated = _projects.find(p => p.id === currentProjectId);
            if (updated) currentProject = updated;
        }
        // Restore last-open project once on first load
        if (!_restored) {
            _restored = true;
            const savedId = sessionStorage.getItem("ws_project");
            const inOwn    = _projects.find(p => p.id === savedId);
            const inShared = _sharedProjects.find(p => p.id === savedId);
            if (savedId && (inOwn || inShared)) {
                selectProject(savedId);
            }
        }
    });
}

function _subscribeMemberships() {
    if (_unsubMemberships) _unsubMemberships();
    _unsubMemberships = onSnapshot(refs.memberships(_db, _user.uid), async (snap) => {
        // Fetch each shared project doc
        const fetched = await Promise.all(
            snap.docs.map(async (d) => {
                const { ownerUid, projectId, role } = d.data();
                if (!ownerUid || !projectId) return null;
                try {
                    const pSnap = await getDoc(refs.project(_db, ownerUid, projectId));
                    if (!pSnap.exists()) return null;
                    return {
                        id: pSnap.id,
                        ...pSnap.data(),
                        ownerUid,
                        memberRole: role,
                        _isShared: true,
                    };
                } catch {
                    return null;
                }
            })
        );
        _sharedProjects = fetched.filter(Boolean);
        _renderProjectList();

        // Restore shared project on first load if needed
        if (!_restored) {
            _restored = true;
            const savedId  = sessionStorage.getItem("ws_project");
            const inShared = _sharedProjects.find(p => p.id === savedId);
            if (savedId && inShared) selectProject(savedId);
        }

        // Sync currentProject if it is a shared project
        if (currentProjectId && currentProject?._isShared) {
            const updated = _sharedProjects.find(p => p.id === currentProjectId);
            if (updated) currentProject = updated;
        }
    });
}

/* ── Admin: load every user's projects ── */
async function _loadAllUsersProjects() {
    try {
        const profilesSnap = await getDocs(refs.userProfiles(_db));
        const allUsers = profilesSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
        const otherUsers = allUsers.filter(u => u.uid !== _user.uid);

        const fetched = await Promise.all(
            otherUsers.map(async (u) => {
                try {
                    const projectsSnap = await getDocs(
                        query(refs.projects(_db, u.uid), orderBy("createdAt", "desc"))
                    );
                    return projectsSnap.docs.map(d => ({
                        id: d.id,
                        ...d.data(),
                        ownerUid:    u.uid,
                        _ownerEmail: u.email       || u.uid,
                        _ownerName:  u.displayName || u.email || u.uid,
                        memberRole:  "contributor",
                        _isShared:   true,
                        _isAdmin:    true,
                    }));
                } catch {
                    return [];
                }
            })
        );

        _adminProjects = fetched.flat();
        _renderProjectList();
        _renderAdminUserFilter(allUsers);
    } catch (err) {
        console.error("Admin: failed to load all users' projects:", err);
    }
}

function _renderAdminUserFilter(allUsers) {
    const filterWrap = document.getElementById("adm-user-filter");
    if (!filterWrap) return;
    filterWrap.style.display = "";

    const users = [...allUsers].sort((a, b) => (a.email || "").localeCompare(b.email || ""));

    // Build the user list UI
    filterWrap.innerHTML = `
        <div class="ws-sb-section-label" style="margin-bottom:0.15rem">
            Account
            <button class="adm-user-refresh-btn" title="Refresh" id="adm-user-refresh">
                <span class="material-symbols-outlined" style="font-size:13px">refresh</span>
            </button>
        </div>
        <div id="adm-user-list" class="adm-user-list"></div>
    `;

    const userList = filterWrap.querySelector("#adm-user-list");

    // "All" entry
    const allBtn = document.createElement("button");
    allBtn.className = "adm-user-item" + (_adminFilterUid === null ? " active" : "");
    allBtn.dataset.uid = "";
    allBtn.innerHTML = `
        <span class="adm-user-item-avatar">★</span>
        <span class="adm-user-item-label">All accounts</span>
        <span class="adm-user-item-count">${_adminProjects.length}</span>
    `;
    allBtn.addEventListener("click", () => _selectAdminUser(null, users));
    userList.appendChild(allBtn);

    // One button per user
    users.forEach(u => {
        const count = _adminProjects.filter(p => p.ownerUid === u.uid).length;
        const initials = ((u.displayName || u.email || "?")[0]).toUpperCase();
        const btn = document.createElement("button");
        btn.className = "adm-user-item" + (_adminFilterUid === u.uid ? " active" : "");
        btn.dataset.uid = u.uid;
        btn.innerHTML = `
            <span class="adm-user-item-avatar">${escHtml(initials)}</span>
            <span class="adm-user-item-label">${escHtml(u.displayName || u.email || u.uid)}</span>
            <span class="adm-user-item-count">${count}</span>
        `;
        btn.addEventListener("click", () => _selectAdminUser(u.uid, users));
        userList.appendChild(btn);
    });

    // Refresh button
    filterWrap.querySelector("#adm-user-refresh")
        ?.addEventListener("click", () => _loadAllUsersProjects());

    // Show/hide "Projects" label
    const projectsLabel = document.getElementById("adm-projects-label");
    if (projectsLabel) projectsLabel.style.display = _adminFilterUid !== null ? "" : "none";
}

function _selectAdminUser(uid, users) {
    _adminFilterUid = uid;

    // Update active state on user buttons
    document.querySelectorAll(".adm-user-item").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.uid === (uid || ""));
    });

    // Show/hide "Projects" label below user list
    const projectsLabel = document.getElementById("adm-projects-label");
    if (projectsLabel) projectsLabel.style.display = uid !== null ? "" : "none";

    _renderProjectList();
}

function _renderProjectList() {
    const list = document.getElementById("project-list");
    list.innerHTML = "";

    // Admin: when a user is selected, show only their projects
    if (isCurrentUserAdmin()) {
        if (_adminFilterUid !== null) {
            const filtered = _adminProjects.filter(a => a.ownerUid === _adminFilterUid);
            if (filtered.length === 0) {
                list.innerHTML = `<p style="font-size:0.74rem;color:#666;padding:0.4rem 0.9rem;">No projects for this user.</p>`;
            } else {
                filtered.forEach(p => list.appendChild(_makeProjectBtn(p)));
            }
        }
        // When no user selected (All), project list stays empty — pick a user first
        return;
    }

    // Normal user path below
    const allProjects = [
        ..._projects,
        ..._sharedProjects.filter(s => !_projects.some(p => p.id === s.id)),
    ];

    if (allProjects.length === 0) {
        list.innerHTML = `<p style="font-size:0.74rem;color:#444;padding:0.4rem 0.9rem;">No projects yet.</p>`;
        return;
    }

    _projects.forEach(p => list.appendChild(_makeProjectBtn(p)));

    if (_sharedProjects.length > 0) {
        const label = document.createElement("div");
        label.className = "ws-sb-section-label ws-sb-shared-label";
        label.textContent = "Shared with me";
        list.appendChild(label);
        _sharedProjects.forEach(p => list.appendChild(_makeProjectBtn(p)));
    }
}

function _makeProjectBtn(p) {
    const btn = document.createElement("button");
    btn.className = "ws-project-item" + (p.id === currentProjectId ? " active" : "");
    btn.dataset.id = p.id;

    const iconName = p.icon ? p.icon.trim() : "";
    const iconHtml = iconName
        ? `<span class="material-symbols-outlined ws-project-item-icon">${escHtml(iconName)}</span>`
        : `<span class="ws-project-item-dot"></span>`;

    const sharedBadge = p._isShared
        ? `<span class="ws-project-shared-badge" title="Shared · ${escHtml(p.memberRole || 'viewer')}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>`
        : "";

    btn.innerHTML = `
        ${iconHtml}
        <span class="ws-project-item-name">${escHtml(p.title)}</span>
        ${sharedBadge}`;
    btn.addEventListener("click", () => selectProject(p.id));
    return btn;
}

/* ── Select project ── */
export function selectProject(id) {
    const project = _projects.find(p => p.id === id)
        || _sharedProjects.find(p => p.id === id)
        || _adminProjects.find(p => p.id === id);
    if (!project) return;

    currentProjectId = id;
    currentProject   = project;
    sessionStorage.setItem("ws_project", id);

    // Update sidebar active state
    document.querySelectorAll(".ws-project-item").forEach(el => {
        el.classList.toggle("active", el.dataset.id === id);
    });

    // Update top bar
    _setTopBar(project);

    // Notify sections
    const isAdmin = isCurrentUserAdmin();
    const isOwner = !project.ownerUid || project.ownerUid === _user.uid || isAdmin;
    const canEdit = isOwner || project.memberRole === "contributor";
    window.dispatchEvent(new CustomEvent("projectSelected", { detail: { project, id, canEdit } }));
}

function _setTopBar(p) {
    document.getElementById("ws-topbar").classList.remove("hidden");
    document.getElementById("ws-tabs").classList.remove("hidden");
    document.getElementById("project-title").textContent      = p.title;
    document.getElementById("project-type-badge").textContent = p.type || "general";

    const statusBadge = document.getElementById("project-status-badge");
    statusBadge.textContent    = p.status || "active";
    statusBadge.dataset.status = p.status || "active";

    // Share button: visible to the project owner and admin
    const isOwner = !p.ownerUid || p.ownerUid === _user.uid || isCurrentUserAdmin();
    const shareBtn = document.getElementById("btn-share-project");
    if (shareBtn) shareBtn.style.display = isOwner ? "" : "none";

    // Role badge for shared projects
    const roleEl = document.getElementById("project-member-role");
    if (roleEl) {
        if (p._isShared) {
            roleEl.textContent = p.memberRole || "viewer";
            roleEl.style.display = "";
        } else {
            roleEl.style.display = "none";
        }
    }

    // Edit/delete buttons hidden for viewers (admin always sees them)
    const canEdit = isOwner || p.memberRole === "contributor";
    document.getElementById("btn-edit-project")?.style && (
        document.getElementById("btn-edit-project").style.display = canEdit ? "" : "none"
    );
    document.getElementById("btn-delete-project")?.style && (
        document.getElementById("btn-delete-project").style.display = isOwner ? "" : "none"
    );

    /* Apply per-project tab visibility */
    _applyProjectTabPrefs(p);
}

function _applyProjectTabPrefs(p) {
    const prefs = p.tabPrefs || _defaultTabPrefs(p.type);
    const sections = ["board", "media", "kanban", "files", "animation", "concept"];
    sections.forEach(s => {
        const tab = document.querySelector(`.ws-tab[data-section="${s}"]`);
        if (!tab) return;
        const show = prefs[s] !== false;
        tab.style.display = show ? "" : "none";
        /* If the currently active section gets hidden, fall back to overview */
        if (!show && tab.classList.contains("active")) {
            window.dispatchEvent(new CustomEvent("activateSection", { detail: { section: "overview" } }));
        }
    });
}

/* ── Project form (create / edit) ── */
function openProjectForm(editId) {
    const form = document.getElementById("form-project");
    form.reset();
    document.getElementById("project-id-field").value = "";

    /* Default tab prefs (all on, animation + concept off) */
    _setTabCheckboxes({ board: true, media: true, kanban: true, files: true, animation: false, concept: false });

    if (editId) {
        const p = _projects.find(x => x.id === editId);
        if (!p) return;
        setModalTitle("modal-project", "Edit Project");
        document.getElementById("btn-project-submit").textContent = "Save Changes";
        document.getElementById("project-id-field").value  = editId;
        document.getElementById("field-title").value       = p.title       || "";
        document.getElementById("field-description").value = p.description || "";
        _setProjectIcon(p.icon || "");
        document.getElementById("field-github").value      = p.githubRepo  || "";
        document.getElementById("field-type").value        = p.type        || "general";
        document.getElementById("field-status").value      = p.status      || "active";
        /* Restore tab prefs — fall back to type-based defaults */
        if (p.tabPrefs) {
            _setTabCheckboxes(p.tabPrefs);
        } else {
            _setTabCheckboxes(_defaultTabPrefs(p.type));
        }
    } else {
        setModalTitle("modal-project", "New Project");
        document.getElementById("btn-project-submit").textContent = "Create Project";
        _setProjectIcon("");
    }

    /* Auto-toggle animation checkbox when type changes in form */
    const typeEl = document.getElementById("field-type");
    typeEl.onchange = () => {
        const animCheck = document.getElementById("ptab-animation");
        if (animCheck && !animCheck.dataset.userSet) {
            animCheck.checked = ["animation", "media"].includes(typeEl.value);
        }
    };
    const animCheck = document.getElementById("ptab-animation");
    if (animCheck) animCheck.addEventListener("change", () => { animCheck.dataset.userSet = "1"; }, { once: true });

    openModal("modal-project");
    setTimeout(() => document.getElementById("field-title").focus(), 60);
}

function _defaultTabPrefs(type) {
    return { board: true, media: true, kanban: true, files: true, animation: ["animation", "media"].includes(type), concept: false };
}

function _setTabCheckboxes(prefs) {
    const keys = ["board", "media", "kanban", "files", "animation", "concept"];
    keys.forEach(k => {
        const el = document.getElementById(`ptab-${k}`);
        if (el) {
            el.checked = prefs[k] !== false;
            delete el.dataset.userSet;
        }
    });
}

function _readTabCheckboxes() {
    const keys = ["board", "media", "kanban", "files", "animation", "concept"];
    const prefs = {};
    keys.forEach(k => {
        const el = document.getElementById(`ptab-${k}`);
        prefs[k] = el ? el.checked : true;
    });
    return prefs;
}

async function onProjectFormSubmit(e) {
    e.preventDefault();

    const id    = document.getElementById("project-id-field").value;
    const data  = {
        title:       document.getElementById("field-title").value.trim(),
        description: document.getElementById("field-description").value.trim(),
        icon:        document.getElementById("field-icon").value.trim(),
        githubRepo:  document.getElementById("field-github").value.trim(),
        type:        document.getElementById("field-type").value,
        status:      document.getElementById("field-status").value,
        tabPrefs:    _readTabCheckboxes(),
        updatedAt:   serverTimestamp(),
    };

    if (!data.title) return;

    try {
        if (id) {
            // Edit
            await updateDoc(doc(_db, "users", _user.uid, "projects", id), data);
            if (id === currentProjectId) _setTopBar({ ...currentProject, ...data });
            toast("Project updated", "success");
        } else {
            // Create
            const newRef = await addDoc(refs.projects(_db, _user.uid), {
                ...data,
                createdAt: serverTimestamp(),
            });
            closeModal("modal-project");
            selectProject(newRef.id);
            toast("Project created", "success");
            return;
        }
    } catch (err) {
        console.error(err);
        toast("Error saving project", "error");
    }

    closeModal("modal-project");
}

async function deleteCurrentProject() {
    if (!currentProjectId) return;
    const ok = await confirm(`Delete "${currentProject.title}"? All project data will be lost.`);
    if (!ok) return;

    const pidToDelete   = currentProjectId;
    const srcCategoryId = currentProject.sourceCategoryId || null;

    try {
        await deleteDoc(refs.project(_db, _user.uid, pidToDelete));
        // If this project was migrated from a private-dashboard category,
        // stamp migrated:true so the migration won't recreate it on next load.
        if (srcCategoryId) {
            try {
                await updateDoc(
                    doc(_db, "users", _user.uid, "categories", srcCategoryId),
                    { migrated: true }
                );
            } catch { /* category may already be deleted — ignore */ }
        }
        currentProjectId = null;
        currentProject   = null;
        sessionStorage.removeItem("ws_project");
        sessionStorage.removeItem("ws_section");
        document.getElementById("ws-tabs").classList.add("hidden");
        window.dispatchEvent(new CustomEvent("projectDeselected"));
        toast("Project deleted");
    } catch (err) {
        console.error(err);
        toast("Error deleting project", "error");
    }
}

/* ── Icon Picker Logic ── */
let _activeCat = "all";

function _openIconPicker() {
    openModal("modal-icon-picker");
    _renderIconPickerCats();
    document.getElementById("ip-search").value = "";
    _renderIconPicker("");
    setTimeout(() => document.getElementById("ip-search").focus(), 60);
}

function _renderIconPickerCats() {
    const catsEl = document.getElementById("ip-cats");
    catsEl.innerHTML = `
        <button type="button" class="icon-cat-btn${_activeCat === "all" ? " active" : ""}" data-cat="all">All</button>
        <button type="button" class="icon-cat-btn${_activeCat === "general" ? " active" : ""}" data-cat="general">General</button>
        <button type="button" class="icon-cat-btn${_activeCat === "files" ? " active" : ""}" data-cat="files">Files</button>
        <button type="button" class="icon-cat-btn${_activeCat === "tech" ? " active" : ""}" data-cat="tech">Tech</button>
        <button type="button" class="icon-cat-btn${_activeCat === "chat" ? " active" : ""}" data-cat="chat">Communicate</button>
        <button type="button" class="icon-cat-btn${_activeCat === "media" ? " active" : ""}" data-cat="media">Media</button>
        <button type="button" class="icon-cat-btn${_activeCat === "objects" ? " active" : ""}" data-cat="objects">Objects</button>
        <button type="button" class="icon-cat-btn${_activeCat === "actions" ? " active" : ""}" data-cat="actions">Actions</button>
        <button type="button" class="icon-cat-btn${_activeCat === "activities" ? " active" : ""}" data-cat="activities">Activities</button>
        <button type="button" class="icon-cat-btn${_activeCat === "business" ? " active" : ""}" data-cat="business">Business</button>
        <button type="button" class="icon-cat-btn${_activeCat === "home" ? " active" : ""}" data-cat="home">Home</button>
        <button type="button" class="icon-cat-btn${_activeCat === "maps" ? " active" : ""}" data-cat="maps">Maps</button>
        <button type="button" class="icon-cat-btn${_activeCat === "social" ? " active" : ""}" data-cat="social">Social</button>
        <button type="button" class="icon-cat-btn${_activeCat === "text" ? " active" : ""}" data-cat="text">Text</button>
    `;
    
    catsEl.querySelectorAll(".icon-cat-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            _activeCat = e.target.dataset.cat;
            catsEl.querySelectorAll(".icon-cat-btn").forEach(b => b.classList.toggle("active", b === e.target));
            _renderIconPicker(document.getElementById("ip-search").value);
        });
    });
}

function _renderIconPicker(search) {
    const grid = document.getElementById("ip-grid");
    const term = search.toLowerCase().trim();
    
    const html = materialIcons
        .filter(i => (_activeCat === "all" || i.cat === _activeCat))
        .filter(i => i.name.includes(term.replace(' ', '_')))
        .map(i => `<button type="button" class="ip-icon-btn" title="${escHtml(i.name)}" data-icon="${escHtml(i.name)}"><span class="material-symbols-outlined">${escHtml(i.name)}</span></button>`)
        .join("");
        
    grid.innerHTML = html || "<div class='ws-placeholder'>No icons match.</div>";
}

function _setProjectIcon(name) {
    document.getElementById("field-icon").value = name;
    document.getElementById("btn-pick-icon-display").textContent = name;
    document.getElementById("btn-pick-icon-text").textContent = name ? name.replace(/_/g, ' ') : "Choose an icon...";
}
