/**
 * sections/kanban.js — Kanban board with 5 columns + GitHub Projects v2 sync.
 * Columns: backlog | todo | inprogress | review | done
 *
 * GitHub integration (requires a classic PAT with "project" scope, stored in
 * users/{uid}/settings/github, and project config in
 * users/{uid}/projects/{pid}/settings/github_project):
 *   — Setup: creates or links a GitHub Project board and maps columns to its Status field options
 *   — Creating a task  → adds a draft item to the GitHub Project
 *   — Editing a task   → updates the draft item title/body
 *   — Moving a card    → updates the item's Status field on the project board
 *   — Deleting a task  → removes the item from the project
 *   — "Sync"           → imports items from the GitHub Project not yet on the board
 */

import {
    onSnapshot, addDoc, updateDoc, deleteDoc, getDoc, setDoc, getDocs,
    doc, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }                        from "../app.js";
import { currentProjectId, currentProject } from "../projects.js";
import { refs }                            from "../db.js";
import { openModal, closeModal,
         setModalTitle, toast,
         confirm, escHtml }               from "../ui.js";

const COLUMNS = ["backlog", "todo", "inprogress", "review", "done"];
const COL_LABELS = {
    backlog:    "Backlog",
    todo:       "To Do",
    inprogress: "In Progress",
    review:     "Review",
    done:       "Done",
};

let _pid        = null;
let _uid        = null;
let _unsub      = null;
let _editId     = null;
let _defaultCol = "todo";

/* ── task data cache (id → data) for drag-and-drop lookups ── */
const _taskCache = new Map();

/* ── GitHub state ── */
let _ghToken           = null;
let _ghOwner           = null;   // repo owner (for project lookup)
let _ghRepo            = null;   // repo name (for Issues REST API)
let _ghProjectId       = null;   // GitHub Projects v2 node ID
let _ghProjectUrl      = null;   // human URL e.g. github.com/users/x/projects/3
let _ghFieldId         = null;   // Status single-select field node ID
let _ghOptions         = {};     // { backlog: "optId", todo: "optId", … }
let _ghPriorityFieldId = null;   // Priority single-select field node ID
let _ghPriorityOptions = {};     // { low: "optId", medium: "optId", high: "optId" }
let _ghLabelsEnsured   = false;  // true after priority labels verified to exist in repo

/* ═══════════════════════════════════════════════════════════ init ══ */

export function init() {
    window.addEventListener("projectSelected", ({ detail }) => {
        _pid = detail.id;
        _uid = auth.currentUser?.uid;
        _subscribe();
        _loadGhSettings();
    });

    window.addEventListener("sectionActivated", (e) => {
        if (e.detail.section === "kanban" && currentProjectId !== _pid) {
            _pid = currentProjectId;
            _uid = auth.currentUser?.uid;
            _subscribe();
            _loadGhSettings();
        }
    });

    document.getElementById("btn-add-kanban-task")
        .addEventListener("click", () => _openForm(null, "todo"));

    document.querySelectorAll(".kanban-add-inline").forEach(btn => {
        btn.addEventListener("click", () => _openForm(null, btn.dataset.col || "todo"));
    });

    document.getElementById("form-kanban-task")
        .addEventListener("submit", _onFormSubmit);

    // GitHub buttons
    document.getElementById("btn-kanban-gh-sync")
        .addEventListener("click", _syncFromProject);
    document.getElementById("btn-kanban-gh-settings")
        .addEventListener("click", _openGhSettings);
    document.getElementById("form-gh-settings")
        .addEventListener("submit", _onGhSettingsSubmit);
    document.getElementById("btn-gh-token-clear")
        .addEventListener("click", async () => {
            document.getElementById("gh-pat-field").value         = "";
            document.getElementById("gh-project-url-field").value = "";
            await setDoc(doc(db, "users", _uid, "settings", "github"), { pat: "" }, { merge: true });
            await _saveProjectConfig(null, null, null, {}, null, {});
            _ghToken = null; _ghProjectId = null; _ghProjectUrl = null;
            _ghFieldId = null; _ghOptions = {};
            _ghPriorityFieldId = null; _ghPriorityOptions = {};
            _updateGhUI();
            closeModal("modal-gh-settings");
            toast("GitHub disconnected", "success");
        });

    _wireDragAndDrop();

    if (currentProjectId) {
        _pid = currentProjectId;
        _uid = auth.currentUser?.uid;
        _subscribe();
        _loadGhSettings();
    }
}

/* ═══════════════════════════════════════════════════════ subscribe ══ */

function _subscribe() {
    if (_unsub) _unsub();
    if (!_pid || !_uid) return;

    const q = query(refs.kanbanTasks(db, _uid, _pid), orderBy("order", "asc"));
    _unsub = onSnapshot(q, (snap) => {
        _taskCache.clear();

        COLUMNS.forEach(col => {
            const list = document.getElementById(`col-${col}`);
            if (list) list.querySelectorAll(".kanban-card").forEach(el => el.remove());
            const cnt = document.getElementById(`count-${col}`);
            if (cnt) cnt.textContent = "0";
        });

        if (snap.empty) return;

        const counts = {};
        snap.forEach(d => {
            const data = d.data();
            _taskCache.set(d.id, data);
            const col = COLUMNS.includes(data.col) ? data.col : "backlog";
            _renderCard(d.id, data, col);
            counts[col] = (counts[col] || 0) + 1;
        });

        COLUMNS.forEach(col => {
            const cnt = document.getElementById(`count-${col}`);
            if (cnt) cnt.textContent = String(counts[col] || 0);
        });
    });
}

/* ═══════════════════════════════════════════════════ render card ══ */

function _renderCard(id, data, col) {
    const list = document.getElementById(`col-${col}`);
    if (!list) return;

    const priority = data.priority || "medium";
    const ghItemId     = data.githubProjectItemId || null;
    const issueNumber  = data.githubIssueNumber   || null;
    const issueUrl     = (ghItemId && issueNumber && _ghOwner && _ghRepo)
        ? `https://github.com/${encodeURIComponent(_ghOwner)}/${encodeURIComponent(_ghRepo)}/issues/${issueNumber}`
        : null;

    const projectBadge = ghItemId
        ? `<a class="kanban-issue-badge" ${issueUrl ? `href="${escHtml(issueUrl)}" target="_blank" rel="noopener noreferrer"` : ""} onclick="event.stopPropagation()" title="View issue on GitHub">
               <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>
               ${issueNumber ? `#${issueNumber}` : "Issue"}
           </a>`
        : "";

    // Use closed-circle (purple) icon for Done column, open-circle (green) for all others
    const isDone = col === "done";
    const issueIconSvg = isDone
        ? `<svg class="kanban-issue-open-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z"/></svg>`
        : `<svg class="kanban-issue-open-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>`;

    const el = document.createElement("div");
    el.className = "kanban-card";
    el.dataset.id  = id;
    el.dataset.col = col;
    el.draggable   = true;
    el.innerHTML = `
        <div class="kanban-card-top">
            ${issueIconSvg}
            <div class="kanban-card-content">
                <div class="kanban-card-title">${escHtml(data.title || "Untitled")}</div>
                ${data.desc ? `<div class="kanban-card-desc">${escHtml(data.desc)}</div>` : ""}
            </div>
            <div class="kanban-card-actions">
                <button class="kanban-card-edit" title="Edit">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="kanban-card-del" title="Delete">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
        <div class="kanban-card-footer">
            ${projectBadge}
            <span class="kanban-priority kanban-priority--${priority}">${priority}</span>
        </div>`;

    el.addEventListener("dragstart", _onDragStart);
    el.addEventListener("dragend",   _onDragEnd);

    el.querySelector(".kanban-card-edit").addEventListener("click", () => _openForm(id, col, data));

    el.querySelector(".kanban-card-del").addEventListener("click", async () => {
        const ok = await confirm(`Delete "${data.title}"?`);
        if (!ok) return;

        // Remove from GitHub Project and close the Issue
        if (data.githubProjectItemId && _ghToken && _ghProjectId) {
            _ghDeleteItem(data.githubProjectItemId, data.githubIssueNumber || null).catch(err =>
                console.warn("GitHub project item remove failed:", err.message)
            );
        }
        deleteDoc(doc(db, "users", _uid, "projects", _pid, "kanban_tasks", id)).catch(console.error);
    });

    list.appendChild(el);
}

/* ═══════════════════════════════════════════════════════ task form ══ */

function _openForm(id, col, data) {
    _editId     = id;
    _defaultCol = col || "todo";
    const form = document.getElementById("form-kanban-task");
    form.reset();

    if (data) {
        setModalTitle("modal-kanban-task", "Edit Task");
        document.getElementById("kanban-field-title").value    = data.title    || "";
        document.getElementById("kanban-field-desc").value     = data.desc     || "";
        document.getElementById("kanban-field-priority").value = data.priority || "medium";
        document.getElementById("kanban-field-col").value      = data.col      || col;
    } else {
        setModalTitle("modal-kanban-task", "Add Task");
        document.getElementById("kanban-field-col").value      = col;
        document.getElementById("kanban-field-priority").value = "medium";
    }

    openModal("modal-kanban-task");
    setTimeout(() => document.getElementById("kanban-field-title").focus(), 60);
}

async function _onFormSubmit(e) {
    e.preventDefault();
    if (!_pid || !_uid) return;

    const title    = document.getElementById("kanban-field-title").value.trim();
    const desc     = document.getElementById("kanban-field-desc").value.trim();
    const priority = document.getElementById("kanban-field-priority").value;
    const col      = document.getElementById("kanban-field-col").value;

    if (!title) return;

    const canUseGh = !!(  _ghToken && _ghProjectId && _ghFieldId);

    try {
        if (_editId) {
            // ── Edit existing task ──────────────────────────────────
            const existingData = _taskCache.get(_editId);
            const existingIssueNumber = existingData?.githubIssueNumber || null;

            await updateDoc(
                doc(db, "users", _uid, "projects", _pid, "kanban_tasks", _editId),
                { title, desc, priority, col, updatedAt: serverTimestamp() }
            );

            if (canUseGh && existingIssueNumber) {
                _ghUpdateIssue(existingIssueNumber, title, desc).catch(err =>
                    toast(`GitHub update failed: ${err.message}`, "warn")
                );
                const oldCol  = existingData?.col;
                const itemId  = existingData?.githubProjectItemId;
                if (itemId) {
                    if (oldCol !== col) {
                        _ghSetItemStatus(itemId, col).catch(err =>
                            console.warn("GitHub status update failed:", err.message)
                        );
                    }
                    const oldPriority = existingData?.priority;
                    if (oldPriority !== priority) {
                        _ghSetItemPriority(itemId, priority).catch(() => {});
                        _ghSetIssuePriorityLabel(existingData?.githubIssueNumber, priority).catch(() => {});
                    }
                }
            }
        } else {
            // ── Create new task ─────────────────────────────────────
            let githubProjectItemId = null;
            let githubIssueId       = null;
            let githubIssueNumber   = null;

            if (canUseGh) {
                try {
                    const ids = await _ghAddItem(title, desc, col, priority);
                    githubProjectItemId = ids.itemId;
                    githubIssueId       = ids.issueId;
                    githubIssueNumber   = ids.issueNumber;
                    if (ids.itemId) _ghSetItemPriority(ids.itemId, priority).catch(() => {});
                } catch (err) {
                    toast(`GitHub project item not created: ${err.message}`, "warn");
                }
            }

            await addDoc(refs.kanbanTasks(db, _uid, _pid), {
                title, desc, priority, col,
                order:                Date.now(),
                githubProjectItemId:  githubProjectItemId,
                githubIssueId:        githubIssueId,
                githubIssueNumber:    githubIssueNumber,
                createdAt:            serverTimestamp(),
            });
        }

        closeModal("modal-kanban-task");
    } catch (err) {
        console.error(err);
        toast("Error saving task", "error");
    }
}

/* ═══════════════════════════════════════════════════ drag and drop ══ */

let _dragging = null;

function _onDragStart(e) {
    _dragging = this;
    this.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", this.dataset.id);
}

function _onDragEnd() {
    this.classList.remove("is-dragging");
    document.querySelectorAll(".kanban-col").forEach(col => col.classList.remove("drag-over"));
    _dragging = null;
}

function _wireDragAndDrop() {
    document.querySelectorAll(".kanban-col").forEach(colEl => {
        colEl.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            colEl.classList.add("drag-over");
        });
        colEl.addEventListener("dragleave", () => {
            colEl.classList.remove("drag-over");
        });
        colEl.addEventListener("drop", async (e) => {
            e.preventDefault();
            colEl.classList.remove("drag-over");
            if (!_dragging) return;

            const taskId = e.dataTransfer.getData("text/plain");
            const newCol = colEl.dataset.col;
            const oldCol = _dragging.dataset.col;
            if (!taskId || !newCol || oldCol === newCol) return;

            updateDoc(
                doc(db, "users", _uid, "projects", _pid, "kanban_tasks", taskId),
                { col: newCol, updatedAt: serverTimestamp() }
            ).catch(console.error);

            // Sync column change to GitHub Project Status field
            const cachedData = _taskCache.get(taskId);
            const itemId     = cachedData?.githubProjectItemId || null;
            if (itemId && _ghToken && _ghProjectId && _ghFieldId) {
                _ghSetItemStatus(itemId, newCol).catch(err =>
                    console.warn("GitHub status sync failed:", err.message)
                );
            }
        });
    });
}

/* ══════════════════════════════════════════════ GitHub integration ══ */

/** Parse owner from a GitHub repo or project URL. */
function _ghParseOwner(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== "github.com") return null;
        const parts = u.pathname.replace(/^\//, "").split("/");
        return parts[0] || null;
    } catch { return null; }
}

/** Parse repo name from a GitHub repo URL (e.g. https://github.com/owner/repo). */
function _ghParseRepo(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== "github.com") return null;
        const parts = u.pathname.replace(/^\//, "").split("/");
        return parts[1] || null;
    } catch { return null; }
}

/** Load saved token + project config for the current project. */
async function _loadGhSettings() {
    _ghOwner      = null;
    _ghRepo       = null;
    _ghToken      = null;
    _ghProjectId  = null;
    _ghProjectUrl = null;
    _ghFieldId    = null;
    _ghOptions    = {};
    _ghLabelsEnsured   = false;
    _updateGhUI();

    if (!_uid) return;

    const repoUrl = currentProject?.githubRepo;
    if (repoUrl) {
        _ghOwner = _ghParseOwner(repoUrl);
        _ghRepo  = _ghParseRepo(repoUrl);
    }

    try {
        const snap = await getDoc(doc(db, "users", _uid, "settings", "github"));
        if (snap.exists()) _ghToken = snap.data().pat || null;
    } catch { /* ignore */ }

    // Load per-project GitHub Project config
    try {
        const snap = await getDoc(doc(db, "users", _uid, "projects", _pid, "settings", "github_project"));
        if (snap.exists()) {
            const d = snap.data();
            _ghProjectId       = d.projectId       || null;
            _ghProjectUrl      = d.projectUrl      || null;
            _ghFieldId         = d.fieldId         || null;
            _ghOptions         = d.options         || {};
            _ghPriorityFieldId = d.priorityFieldId || null;
            _ghPriorityOptions = d.priorityOptions || {};
        }
    } catch { /* ignore */ }

    _updateGhUI();
}

function _updateGhUI() {
    const syncBtn     = document.getElementById("btn-kanban-gh-sync");
    const settingsBtn = document.getElementById("btn-kanban-gh-settings");
    const hasProject  = !!_ghProjectId;
    if (syncBtn)     syncBtn.style.display    = hasProject ? "" : "none";
    if (settingsBtn) settingsBtn.style.display = (_ghOwner) ? "" : "none";
    if (syncBtn) {
        const ready = !!(  _ghToken && _ghProjectId && _ghFieldId);
        syncBtn.title = ready ? "Sync from GitHub Project" : "GitHub project not set up — click ⚙";
        syncBtn.classList.toggle("kanban-gh-no-token", !ready);
    }
}

function _openGhSettings() {
    document.getElementById("gh-pat-field").value         = _ghToken || "";
    document.getElementById("gh-project-url-field").value = _ghProjectUrl || "";
    openModal("modal-gh-settings");
    setTimeout(() => document.getElementById("gh-pat-field").focus(), 60);
}

async function _onGhSettingsSubmit(e) {
    e.preventDefault();
    const pat        = document.getElementById("gh-pat-field").value.trim();
    const projectUrl = document.getElementById("gh-project-url-field").value.trim();

    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    btn.textContent = "Saving…";

    try {
        // Save PAT
        await setDoc(doc(db, "users", _uid, "settings", "github"), { pat }, { merge: true });
        _ghToken = pat || null;

        if (!pat) {
            await _saveProjectConfig(null, null, null, {}, null, {});
            _ghToken = null; _ghProjectId = null; _ghProjectUrl = null;
            _ghFieldId = null; _ghOptions = {};
            _ghPriorityFieldId = null; _ghPriorityOptions = {};
            _updateGhUI();
            closeModal("modal-gh-settings");
            toast("GitHub disconnected", "success");
            return;
        }

        // Parse and set up the project
        const projectConfig = await _ghSetupProject(pat, projectUrl);
        await _saveProjectConfig(
            projectConfig.projectId,
            projectConfig.projectUrl,
            projectConfig.fieldId,
            projectConfig.options,
            projectConfig.priorityFieldId,
            projectConfig.priorityOptions
        );

        _ghProjectId       = projectConfig.projectId;
        _ghProjectUrl      = projectConfig.projectUrl;
        _ghFieldId         = projectConfig.fieldId;
        _ghOptions         = projectConfig.options;
        _ghPriorityFieldId = projectConfig.priorityFieldId;
        _ghPriorityOptions = projectConfig.priorityOptions;
        _updateGhUI();

        // Ensure priority labels exist in the repo, then mark done for this session
        await _ghEnsurePriorityLabels().catch(() => {});
        _ghLabelsEnsured = true;

        closeModal("modal-gh-settings");
        toast("GitHub Project connected!", "success");
    } catch (err) {
        console.error(err);
        toast(`Setup failed: ${err.message}`, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Connect";
    }
}

async function _saveProjectConfig(projectId, projectUrl, fieldId, options, priorityFieldId, priorityOptions) {
    await setDoc(
        doc(db, "users", _uid, "projects", _pid, "settings", "github_project"),
        {
            projectId:       projectId       || null,
            projectUrl:      projectUrl      || null,
            fieldId:         fieldId         || null,
            options:         options         || {},
            priorityFieldId: priorityFieldId || null,
            priorityOptions: priorityOptions || {},
        },
        { merge: true }
    );
}

/* ── GraphQL helper ───────────────────────────────────────────────── */

async function _ghGraphQL(query, variables = {}, token = null) {
    const tok = token || _ghToken;
    if (!tok) throw new Error("No GitHub token configured");
    const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${tok}`,
            "Content-Type":  "application/json",
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    return json.data;
}

/* ── Project setup ───────────────────────────────────────────────── */

const COL_TO_GH_NAME = {
    backlog:    "Backlog",
    todo:       "Todo",
    inprogress: "In Progress",
    review:     "Review",
    done:       "Done",
};
const GH_COLORS = {
    backlog: "GRAY", todo: "BLUE", inprogress: "PURPLE", review: "YELLOW", done: "GREEN",
};

/**
 * Given a PAT and optionally an existing project URL, either link the existing
 * project or create a new one, set up the Status field with our 5 options,
 * and return { projectId, projectUrl, fieldId, options }.
 */
async function _ghSetupProject(pat, projectUrl) {
    // --- Resolve owner node ID ---
    if (!_ghOwner) throw new Error("No GitHub repository URL set on this project");

    const ownerData = await _ghGraphQL(`
        query($login: String!) {
            user(login: $login) { id }
        }
    `, { login: _ghOwner }, pat).catch(() => null);

    const ownerId = ownerData?.user?.id;
    if (!ownerId) throw new Error(`GitHub user "${_ghOwner}" not found. Is the repo URL correct?`);

    let projectId, resolvedUrl;

    if (projectUrl) {
        // --- Link existing project ---
        // URL format: https://github.com/users/owner/projects/N  OR  /orgs/owner/projects/N
        const match = projectUrl.match(/\/projects\/(\d+)/);
        if (!match) throw new Error("Invalid GitHub Project URL");
        const projectNumber = parseInt(match[1], 10);

        const pd = await _ghGraphQL(`
            query($login: String!, $number: Int!) {
                user(login: $login) {
                    projectV2(number: $number) { id url }
                }
            }
        `, { login: _ghOwner, number: projectNumber }, pat);

        const project = pd?.user?.projectV2;
        if (!project) throw new Error("Project not found — check the URL and token permissions");
        projectId    = project.id;
        resolvedUrl  = project.url;
    } else {
        // --- Create new project ---
        const title = currentProject?.name || "Workspace Board";
        const pd = await _ghGraphQL(`
            mutation($ownerId: ID!, $title: String!) {
                createProjectV2(input: { ownerId: $ownerId, title: $title }) {
                    projectV2 { id url }
                }
            }
        `, { ownerId, title }, pat);

        const project = pd?.createProjectV2?.projectV2;
        if (!project) throw new Error("Failed to create GitHub Project");
        projectId   = project.id;
        resolvedUrl = project.url;
    }

    // --- Get or update Status field ---
    const fieldsData = await _ghGraphQL(`
        query($id: ID!) {
            node(id: $id) {
                ... on ProjectV2 {
                    fields(first: 20) {
                        nodes {
                            __typename
                            ... on ProjectV2SingleSelectField { id name options { id name } }
                        }
                    }
                }
            }
        }
    `, { id: projectId }, pat);

    const fields = fieldsData?.node?.fields?.nodes || [];
    const statusField = fields.find(f => f.__typename === "ProjectV2SingleSelectField" && f.name === "Status");
    if (!statusField) throw new Error("No Status field found on this project");

    // Build desired options list
    const desiredOptions = COLUMNS.map(col => ({
        name:  COL_TO_GH_NAME[col],
        color: GH_COLORS[col],
        description: "",
    }));

    // Update the Status field options to match our columns
    const updatedField = await _ghGraphQL(`
        mutation($fieldId: ID!, $opts: [ProjectV2SingleSelectFieldOptionInput!]!) {
            updateProjectV2Field(input: {
                fieldId: $fieldId
                singleSelectOptions: $opts
            }) {
                projectV2Field {
                    ... on ProjectV2SingleSelectField { id options { id name } }
                }
            }
        }
    `, { fieldId: statusField.id, opts: desiredOptions }, pat);

    const updatedOptions = updatedField?.updateProjectV2Field?.projectV2Field?.options || [];

    // Map column keys to option IDs
    const options = {};
    COLUMNS.forEach(col => {
        const ghName = COL_TO_GH_NAME[col];
        const opt    = updatedOptions.find(o => o.name === ghName);
        if (opt) options[col] = opt.id;
    });

    // --- Get or create Priority field ---
    const priorityField = fields.find(f =>
        f.__typename === "ProjectV2SingleSelectField" && f.name === "Priority");

    let priorityFieldId = null;
    const priorityOptions = {};

    const priorityMutation = priorityField
        ? `mutation($fid: ID!) {
              updateProjectV2Field(input: {
                  fieldId: $fid
                  singleSelectOptions: [
                      {name: "Low",    color: GREEN,  description: ""}
                      {name: "Medium", color: YELLOW, description: ""}
                      {name: "High",   color: RED,    description: ""}
                  ]
              }) {
                  projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } }
              }
           }`
        : `mutation($pid: ID!) {
              createProjectV2Field(input: {
                  projectId: $pid
                  dataType: SINGLE_SELECT
                  name: "Priority"
                  singleSelectOptions: [
                      {name: "Low",    color: GREEN,  description: ""}
                      {name: "Medium", color: YELLOW, description: ""}
                      {name: "High",   color: RED,    description: ""}
                  ]
              }) {
                  projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } }
              }
           }`;

    const prVars = priorityField ? { fid: priorityField.id } : { pid: projectId };
    const prResult = await _ghGraphQL(priorityMutation, prVars, pat).catch(() => null);
    const prField  = prResult?.updateProjectV2Field?.projectV2Field
                  || prResult?.createProjectV2Field?.projectV2Field;
    if (prField) {
        priorityFieldId = prField.id;
        (prField.options || []).forEach(o => {
            if (o.name === "Low")    priorityOptions.low    = o.id;
            if (o.name === "Medium") priorityOptions.medium = o.id;
            if (o.name === "High")   priorityOptions.high   = o.id;
        });
    }

    return { projectId, projectUrl: resolvedUrl, fieldId: statusField.id, options, priorityFieldId, priorityOptions };
}

/**
 * Ensure the three priority labels exist in the repo.
 * Uses PUT (upsert) so it won't fail if the label already exists.
 */
async function _ghEnsurePriorityLabels() {
    if (!_ghOwner || !_ghRepo || !_ghToken) return;
    const labels = [
        { name: "priority: low",    color: "2da44e", description: "Low priority"    },
        { name: "priority: medium", color: "e3b341", description: "Medium priority" },
        { name: "priority: high",   color: "cf222e", description: "High priority"   },
    ];
    const base = `https://api.github.com/repos/${encodeURIComponent(_ghOwner)}/${encodeURIComponent(_ghRepo)}/labels`;
    const headers = { "Authorization": `Bearer ${_ghToken}`, "Content-Type": "application/json" };
    for (const label of labels) {
        // Try creating; if 422 (already exists) try updating color/description instead
        const resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(label) });
        if (resp.status === 422) {
            await fetch(`${base}/${encodeURIComponent(label.name)}`,
                { method: "PATCH", headers, body: JSON.stringify({ color: label.color, description: label.description }) }
            ).catch(() => {});
        }
    }
}

/* ── Project item CRUD ───────────────────────────────────────────── */

/** Create a real GitHub Issue and add it to the project board; returns { itemId, issueId, issueNumber }. */
async function _ghAddItem(title, body, col, priority) {
    if (!_ghOwner || !_ghRepo) throw new Error("No GitHub repository URL set on this project");

    // Ensure priority labels exist (only runs once per session)
    if (!_ghLabelsEnsured) {
        await _ghEnsurePriorityLabels().catch(() => {});
        _ghLabelsEnsured = true;
    }

    // 1. Create a real GitHub Issue via REST API
    const label = priority ? `priority: ${priority}` : null;
    const issueResp = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(_ghOwner)}/${encodeURIComponent(_ghRepo)}/issues`,
        {
            method: "POST",
            headers: { "Authorization": `Bearer ${_ghToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ title, body: body || "", ...(label ? { labels: [label] } : {}) }),
        }
    );
    if (!issueResp.ok) {
        const e = await issueResp.json().catch(() => ({}));
        throw new Error(e.message || `GitHub API error ${issueResp.status}`);
    }
    const issue = await issueResp.json();
    const issueNumber = issue.number;
    const issueId     = issue.node_id;

    // 2. Add issue to the project board
    const addData = await _ghGraphQL(`
        mutation($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
                item { id }
            }
        }
    `, { projectId: _ghProjectId, contentId: issueId });

    const itemId = addData?.addProjectV2ItemById?.item?.id;
    if (!itemId) throw new Error("Failed to add issue to GitHub Project board");

    // 3. Set Status field
    if (_ghFieldId && _ghOptions[col]) {
        await _ghSetItemStatus(itemId, col).catch(() => {});
    }

    return { itemId, issueId, issueNumber };
}

/** Update the Priority single-select field for a project item. */
async function _ghSetItemPriority(itemId, priority) {
    const optionId = _ghPriorityOptions[priority];
    if (!optionId || !_ghPriorityFieldId) return;
    await _ghGraphQL(`
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
            updateProjectV2ItemFieldValue(input: {
                projectId: $projectId
                itemId:    $itemId
                fieldId:   $fieldId
                value:     { singleSelectOptionId: $optionId }
            }) {
                projectV2Item { id }
            }
        }
    `, { projectId: _ghProjectId, itemId, fieldId: _ghPriorityFieldId, optionId });
}

/** Set priority label on a GitHub Issue (removes any existing priority: label first). */
async function _ghSetIssuePriorityLabel(issueNumber, priority) {
    if (!_ghOwner || !_ghRepo || !issueNumber) return;
    const headers = { "Authorization": `Bearer ${_ghToken}`, "Content-Type": "application/json" };
    const base    = `https://api.github.com/repos/${encodeURIComponent(_ghOwner)}/${encodeURIComponent(_ghRepo)}/issues/${issueNumber}`;

    // Fetch current labels, remove any existing priority: ones, add the new one
    const current = await fetch(base, { headers }).then(r => r.json()).catch(() => ({ labels: [] }));
    const kept    = (current.labels || []).map(l => l.name).filter(n => !n.startsWith("priority: "));
    const newLabel = priority ? `priority: ${priority}` : null;
    const labels   = newLabel ? [...kept, newLabel] : kept;
    await fetch(base, { method: "PATCH", headers, body: JSON.stringify({ labels }) }).catch(() => {});
}

/** Update the title/body of a GitHub Issue via REST API. */
async function _ghUpdateIssue(issueNumber, title, body) {
    if (!_ghOwner || !_ghRepo || !issueNumber) return;
    await fetch(
        `https://api.github.com/repos/${encodeURIComponent(_ghOwner)}/${encodeURIComponent(_ghRepo)}/issues/${issueNumber}`,
        {
            method: "PATCH",
            headers: { "Authorization": `Bearer ${_ghToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ title, body: body || "" }),
        }
    );
}

/** Update the Status single-select field for a project item. */
async function _ghSetItemStatus(itemId, col) {
    const optionId = _ghOptions[col];
    if (!optionId || !_ghFieldId) return;
    await _ghGraphQL(`
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
            updateProjectV2ItemFieldValue(input: {
                projectId: $projectId
                itemId:    $itemId
                fieldId:   $fieldId
                value:     { singleSelectOptionId: $optionId }
            }) {
                projectV2Item { id }
            }
        }
    `, { projectId: _ghProjectId, itemId, fieldId: _ghFieldId, optionId });
}

/** Remove an item from the project and close the GitHub Issue. */
async function _ghDeleteItem(itemId, issueNumber) {
    await _ghGraphQL(`
        mutation($projectId: ID!, $itemId: ID!) {
            deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
                deletedItemId
            }
        }
    `, { projectId: _ghProjectId, itemId });

    // Also close the Issue so it doesn't stay open on GitHub
    if (issueNumber && _ghOwner && _ghRepo) {
        await fetch(
            `https://api.github.com/repos/${encodeURIComponent(_ghOwner)}/${encodeURIComponent(_ghRepo)}/issues/${issueNumber}`,
            {
                method: "PATCH",
                headers: { "Authorization": `Bearer ${_ghToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ state: "closed" }),
            }
        ).catch(() => {});
    }
}

/* ── Sync from GitHub Project ──────────────────────────────────────── */

async function _syncFromProject() {
    if (!_ghToken || !_ghProjectId || !_ghFieldId) {
        toast("Connect a GitHub Project first — click ⚙", "warn");
        _openGhSettings();
        return;
    }

    const btn = document.getElementById("btn-kanban-gh-sync");
    if (btn) { btn.disabled = true; btn.textContent = "Syncing…"; }

    try {
        // Fetch all project items (draft issues only, max 100)
        const data = await _ghGraphQL(`
            query($projectId: ID!) {
                node(id: $projectId) {
                    ... on ProjectV2 {
                        items(first: 100) {
                            nodes {
                                id
                                status: fieldValueByName(name: "Status") {
                                    ... on ProjectV2ItemFieldSingleSelectValue { optionId }
                                }
                                priority: fieldValueByName(name: "Priority") {
                                    ... on ProjectV2ItemFieldSingleSelectValue { optionId }
                                }
                                content {
                                    ... on Issue      { id number title body }
                                    ... on DraftIssue { id title body }
                                }
                            }
                        }
                    }
                }
            }
        `, { projectId: _ghProjectId });

        const items = data?.node?.items?.nodes || [];

        // Build a set of already-tracked item IDs → doc map
        const existingSnap = await getDocs(refs.kanbanTasks(db, _uid, _pid));
        const trackedItems = new Map(); // ghItemId → firestoreDoc
        existingSnap.forEach(d => {
            const ghId = d.data().githubProjectItemId;
            if (ghId) trackedItems.set(ghId, d);
        });

        // Build reverse maps
        const optionToCol = {};
        for (const [col, optId] of Object.entries(_ghOptions)) optionToCol[optId] = col;
        const optionToPriority = {};
        for (const [pri, optId] of Object.entries(_ghPriorityOptions)) optionToPriority[optId] = pri;
        const hasPriorityMap = Object.keys(optionToPriority).length > 0;

        let imported = 0, updated = 0;
        for (const item of items) {
            if (!item.content?.id) continue; // skip items without content

            const col     = optionToCol[item.status?.optionId] || "todo";
            // Only resolve priority if the mapping exists; otherwise null = keep existing
            const ghPriority = hasPriorityMap
                ? (optionToPriority[item.priority?.optionId] || null)
                : null;
            const isIssue = item.content.__typename === "Issue" || item.content.number != null;

            if (trackedItems.has(item.id)) {
                // Update col/priority if they changed on GitHub
                const existingDoc  = trackedItems.get(item.id);
                const existingData = existingDoc.data();
                const updates = {};
                if (existingData.col !== col) updates.col = col;
                // Only overwrite priority if GitHub returned a real value
                if (ghPriority && existingData.priority !== ghPriority) updates.priority = ghPriority;
                if (Object.keys(updates).length > 0) {
                    updates.updatedAt = serverTimestamp();
                    await updateDoc(
                        doc(db, "users", _uid, "projects", _pid, "kanban_tasks", existingDoc.id),
                        updates
                    );
                    updated++;
                }
                continue;
            }

            // Import new item — fall back to "medium" only for fresh imports
            const importPriority = ghPriority || "medium";
            await addDoc(refs.kanbanTasks(db, _uid, _pid), {
                title:               item.content.title || "Untitled",
                desc:                (item.content.body || "").slice(0, 500).trim(),
                priority:            importPriority,
                col,
                order:               Date.now() + imported,
                githubProjectItemId: item.id,
                githubIssueId:       item.content.id,
                githubIssueNumber:   isIssue ? item.content.number : null,
                createdAt:           serverTimestamp(),
            });
            imported++;
        }

        const parts = [];
        if (imported > 0) parts.push(`${imported} imported`);
        if (updated  > 0) parts.push(`${updated} updated`);
        toast(parts.length ? parts.join(", ") : "Board is up to date", "success");
    } catch (err) {
        console.error(err);
        toast(`Sync failed: ${err.message}`, "error");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Sync"; }
    }
}
