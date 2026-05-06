/**
 * projects.js — Project sidebar list + create / edit / delete.
 *
 * State:
 *   currentProjectId  — the active project id (null = no selection)
 *   currentProject    — the active project data object
 *
 * Emits a custom event "projectSelected" on window when the user selects a project.
 */

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

/**
 * Returns true if the current user can add/edit/delete items in the active project.
 * Owners and contributors can edit; viewers cannot.
 */
export function canCurrentUserEdit() {
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

function _renderProjectList() {
    const list = document.getElementById("project-list");
    list.innerHTML = "";

    const allProjects = [
        ..._projects,
        ..._sharedProjects.filter(s => !_projects.some(p => p.id === s.id)),
    ];

    if (allProjects.length === 0) {
        list.innerHTML = `<p style="font-size:0.74rem;color:#444;padding:0.4rem 0.9rem;">No projects yet.</p>`;
        return;
    }

    // Own projects
    if (_projects.length > 0) {
        _projects.forEach(p => list.appendChild(_makeProjectBtn(p)));
    }

    // Shared projects section
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
        || _sharedProjects.find(p => p.id === id);
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
    const isOwner = !project.ownerUid || project.ownerUid === _user.uid;
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

    // Share button: only visible to the project owner
    const isOwner = !p.ownerUid || p.ownerUid === _user.uid;
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

    // Edit/delete buttons hidden for viewers and shared contributors too (server-enforced via rules)
    const canEdit = isOwner || p.memberRole === "contributor";
    document.getElementById("btn-edit-project")?.style && (
        document.getElementById("btn-edit-project").style.display = isOwner ? "" : "none"
    );
    document.getElementById("btn-delete-project")?.style && (
        document.getElementById("btn-delete-project").style.display = isOwner ? "" : "none"
    );
}

/* ── Project form (create / edit) ── */
function openProjectForm(editId) {
    const form = document.getElementById("form-project");
    form.reset();
    document.getElementById("project-id-field").value = "";

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
    } else {
        setModalTitle("modal-project", "New Project");
        document.getElementById("btn-project-submit").textContent = "Create Project";
        _setProjectIcon("");
    }

    openModal("modal-project");
    setTimeout(() => document.getElementById("field-title").focus(), 60);
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
