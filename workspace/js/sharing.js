/**
 * sharing.js — Project sharing: browse all accounts, add contributors / viewers.
 *
 * Firestore paths:
 *   users/{ownerUid}/projects/{pid}.members     — map of { [memberUid]: { role, email, displayName } }
 *   users/{memberUid}/memberships/{pid}         — { ownerUid, projectId, role, title, icon, ownerName }
 *   user_profiles/{uid}                         — { uid, email, displayName, photoURL }  (written on login)
 */

import {
    getDocs, updateDoc, setDoc, deleteDoc,
    query, where, arrayUnion
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { refs }                                    from "./db.js";
import { currentProjectId, currentProject,
         isCurrentUserAdmin, getDataUid }          from "./projects.js";
import { openModal, toast, escHtml }               from "./ui.js";

let _db        = null;
let _user      = null;
let _allUsers  = [];   // [{ uid, email, displayName }]
let _loaded    = false;
let _search    = "";

/* ── Init ── */
export function initSharing(db, user) {
    _db   = db;
    _user = user;

    document.getElementById("btn-share-project")
        ?.addEventListener("click", openShareModal);

    document.getElementById("btn-topbar-share")
        ?.addEventListener("click", () => {
            document.getElementById("topbar-more-popup")?.classList.remove("open");
            openShareModal();
        });

    document.getElementById("share-user-search")
        ?.addEventListener("input", (e) => {
            _search = e.target.value.trim().toLowerCase();
            _renderUserList();
        });
}

/* ── Open modal ── */
export async function openShareModal() {
    if (!currentProjectId || !currentProject) return;

    const isOwner = !currentProject.ownerUid || currentProject.ownerUid === _user.uid
        || isCurrentUserAdmin();

    document.getElementById("share-project-name").textContent = currentProject.title || "Project";
    document.getElementById("share-add-section").style.display = isOwner ? "" : "none";
    document.getElementById("share-user-search").value = "";
    document.getElementById("share-add-error").textContent = "";
    _search = "";

    _renderMembers(isOwner);
    openModal("modal-share");

    if (isOwner) {
        await _ensureUsersLoaded();
        _renderUserList();
    }
}

/* ── Load all user profiles once ── */
async function _ensureUsersLoaded() {
    if (_loaded) return;
    try {
        const snap = await getDocs(refs.userProfiles(_db));
        _allUsers = snap.docs
            .map(d => ({ uid: d.id, ...d.data() }))
            .filter(u => u.uid !== _user.uid);  // exclude self
        _loaded = true;
    } catch (err) {
        console.error("Failed to load user profiles:", err);
        document.getElementById("share-user-list").innerHTML =
            `<p class="share-user-loading" style="color:var(--danger,#e05c5c)">Could not load accounts.</p>`;
    }
}

/* ── Render the browseable user list ── */
function _renderUserList() {
    const container = document.getElementById("share-user-list");
    const members   = currentProject?.members || {};

    const filtered = _allUsers.filter(u => {
        if (!_search) return true;
        return (u.displayName || "").toLowerCase().includes(_search) ||
               (u.email      || "").toLowerCase().includes(_search);
    });

    if (filtered.length === 0) {
        container.innerHTML = `<p class="share-no-members">${_search ? "No accounts match." : "No other accounts found."}</p>`;
        return;
    }

    container.innerHTML = filtered.map(u => {
        const isMember = !!members[u.uid];
        const initial  = (u.displayName || u.email || "?")[0].toUpperCase();
        const name     = escHtml(u.displayName || u.email || u.uid);
        const email    = escHtml(u.email || "");
        return `
        <div class="share-pick-row ${isMember ? "share-pick-row--added" : ""}" data-uid="${escHtml(u.uid)}">
            <div class="share-member-avatar">${initial}</div>
            <div class="share-member-info">
                <div class="share-member-name">${name}</div>
                <div class="share-member-email">${email}</div>
            </div>
            ${isMember
                ? `<span class="share-pick-added-badge">Added</span>`
                : `<button class="ws-btn ws-btn-accent ws-btn--xs share-pick-add-btn"
                          data-uid="${escHtml(u.uid)}"
                          data-name="${name}"
                          data-email="${email}">Add</button>`
            }
        </div>`;
    }).join("");

    container.querySelectorAll(".share-pick-add-btn").forEach(btn => {
        btn.addEventListener("click", () => _addMember(btn.dataset.uid, btn.dataset.name, btn.dataset.email));
    });
}

/* ── Render current members list ── */
function _renderMembers(isOwner) {
    const list    = document.getElementById("share-members-list");
    const members = currentProject?.members || {};
    const entries = Object.entries(members);

    if (entries.length === 0) {
        list.innerHTML = `<p class="share-no-members">No members yet.</p>`;
        return;
    }

    list.innerHTML = entries.map(([uid, m]) => `
        <div class="share-member-row" data-uid="${escHtml(uid)}">
            <div class="share-member-avatar">${escHtml((m.displayName || m.email || "?")[0].toUpperCase())}</div>
            <div class="share-member-info">
                <div class="share-member-name">${escHtml(m.displayName || m.email || uid)}</div>
                <div class="share-member-email">${escHtml(m.email || "")}</div>
            </div>
            ${isOwner ? `
            <select class="share-role-select ws-select-sm" data-uid="${escHtml(uid)}">
                <option value="contributor"${m.role === "contributor" ? " selected" : ""}>Contributor</option>
                <option value="viewer"${m.role === "viewer" ? " selected" : ""}>Viewer</option>
            </select>
            <button class="share-remove-btn ws-icon-btn" data-uid="${escHtml(uid)}" title="Remove">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            ` : `<span class="share-role-badge">${escHtml(m.role || "viewer")}</span>`}
        </div>
    `).join("");

    if (isOwner) {
        list.querySelectorAll(".share-role-select").forEach(sel => {
            sel.addEventListener("change", () => _changeRole(sel.dataset.uid, sel.value));
        });
        list.querySelectorAll(".share-remove-btn").forEach(btn => {
            btn.addEventListener("click", () => _removeMember(btn.dataset.uid));
        });
    }
}

/* ── Add member by uid (from picker) ── */
async function _addMember(memberUid, displayName, email) {
    if (!currentProjectId || !currentProject) return;

    const errorEl = document.getElementById("share-add-error");
    const role    = document.getElementById("share-add-role")?.value || "contributor";
    errorEl.textContent = "";

    const btn = document.querySelector(`.share-pick-add-btn[data-uid="${memberUid}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }

    try {
        const ownerUid       = getDataUid();
        const memberEntry    = { role, email, displayName };
        const updatedMembers = { ...(currentProject.members || {}), [memberUid]: memberEntry };

        await updateDoc(refs.project(_db, ownerUid, currentProjectId), { members: updatedMembers });

        await setDoc(refs.membershipDoc(_db, memberUid, currentProjectId), {
            ownerUid:  ownerUid,
            projectId: currentProjectId,
            role,
            title:     currentProject.title || "",
            icon:      currentProject.icon  || "",
            ownerName: (currentProject._ownerName) || _user.displayName || _user.email || "",
        });

        toast(`${displayName} added as ${role}`, "success");
        _renderMembers(true);
        _renderUserList();
    } catch (err) {
        console.error(err);
        errorEl.textContent = "Error adding member. Try again.";
        if (btn) { btn.disabled = false; btn.textContent = "Add"; }
    }
}

/* ── Change role ── */
async function _changeRole(memberUid, newRole) {
    if (!currentProjectId) return;
    try {
        const ownerUid = getDataUid();
        const existing = { ...(currentProject.members || {}) };
        if (!existing[memberUid]) return;
        existing[memberUid] = { ...existing[memberUid], role: newRole };

        await updateDoc(refs.project(_db, ownerUid, currentProjectId), { members: existing });
        await setDoc(refs.membershipDoc(_db, memberUid, currentProjectId), { role: newRole }, { merge: true });

        toast("Role updated", "success");
    } catch (err) {
        console.error(err);
        toast("Error updating role", "error");
    }
}

/* ── Remove member ── */
async function _removeMember(memberUid) {
    if (!currentProjectId) return;
    try {
        const ownerUid = getDataUid();
        const existing = { ...(currentProject.members || {}) };
        const name = existing[memberUid]?.displayName || existing[memberUid]?.email || memberUid;
        delete existing[memberUid];

        await updateDoc(refs.project(_db, ownerUid, currentProjectId), { members: existing });
        await deleteDoc(refs.membershipDoc(_db, memberUid, currentProjectId));

        toast(`${name} removed`, "success");
        _renderMembers(true);
        _renderUserList();
    } catch (err) {
        console.error(err);
        toast("Error removing member", "error");
    }
}
