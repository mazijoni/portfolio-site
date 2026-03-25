/**
 * sections/kanban.js — Kanban board with 5 columns.
 * Columns: backlog | todo | inprogress | review | done
 */

import {
    onSnapshot, addDoc, updateDoc, deleteDoc,
    doc, query, orderBy, serverTimestamp, where
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }               from "../app.js";
import { currentProjectId }       from "../projects.js";
import { refs }                   from "../db.js";
import { openModal, closeModal,
         setModalTitle, toast,
         confirm, escHtml }       from "../ui.js";

const COLUMNS = ["backlog", "todo", "inprogress", "review", "done"];
const COL_LABELS = {
    backlog:    "Backlog",
    todo:       "To Do",
    inprogress: "In Progress",
    review:     "Review",
    done:       "Done",
};

let _pid   = null;
let _uid   = null;
let _unsub = null;
let _editId = null;
let _defaultCol = "todo";

export function init() {
    window.addEventListener("projectSelected", ({ detail }) => {
        _pid = detail.id;
        _uid = auth.currentUser?.uid;
        _subscribe();
    });

    window.addEventListener("sectionActivated", (e) => {
        if (e.detail.section === "kanban" && currentProjectId !== _pid) {
            _pid = currentProjectId;
            _uid = auth.currentUser?.uid;
            _subscribe();
        }
    });

    document.getElementById("btn-add-kanban-task")
        .addEventListener("click", () => _openForm(null, "todo"));

    document.querySelectorAll(".kanban-add-inline").forEach(btn => {
        btn.addEventListener("click", () => _openForm(null, btn.dataset.col || "todo"));
    });

    document.getElementById("form-kanban-task")
        .addEventListener("submit", _onFormSubmit);

    _wireDragAndDrop();

    if (currentProjectId) {
        _pid = currentProjectId;
        _uid = auth.currentUser?.uid;
        _subscribe();
    }
}

function _subscribe() {
    if (_unsub) _unsub();
    if (!_pid || !_uid) return;

    const q = query(refs.kanbanTasks(db, _uid, _pid), orderBy("order", "asc"));
    _unsub = onSnapshot(q, (snap) => {
        // Clear all columns
        COLUMNS.forEach(col => {
            const list = document.getElementById(`col-${col}`);
            if (list) list.querySelectorAll(".kanban-card").forEach(el => el.remove());
        });

        // Reset counts
        COLUMNS.forEach(col => {
            const cnt = document.getElementById(`count-${col}`);
            if (cnt) cnt.textContent = "0";
        });

        if (snap.empty) return;

        const counts = {};
        snap.forEach(d => {
            const data = d.data();
            const col  = COLUMNS.includes(data.col) ? data.col : "backlog";
            _renderCard(d.id, data, col);
            counts[col] = (counts[col] || 0) + 1;
        });

        COLUMNS.forEach(col => {
            const cnt = document.getElementById(`count-${col}`);
            if (cnt) cnt.textContent = String(counts[col] || 0);
        });
    });
}

function _renderCard(id, data, col) {
    const list = document.getElementById(`col-${col}`);
    if (!list) return;

    const priority = data.priority || "medium";

    const el = document.createElement("div");
    el.className = "kanban-card";
    el.dataset.id = id;
    el.dataset.col = col;
    el.draggable = true;
    el.innerHTML = `
        <div class="kanban-card-header">
            <span class="kanban-priority kanban-priority--${priority}">${priority}</span>
            <div class="kanban-card-actions">
                <button class="kanban-card-edit" title="Edit">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="kanban-card-del" title="Delete">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
        <div class="kanban-card-title">${escHtml(data.title || "Untitled")}</div>
        ${data.desc ? `<div class="kanban-card-desc">${escHtml(data.desc)}</div>` : ""}`;

    // Drag events
    el.addEventListener("dragstart", _onDragStart);
    el.addEventListener("dragend",   _onDragEnd);

    el.querySelector(".kanban-card-edit").addEventListener("click", () => _openForm(id, col, data));

    el.querySelector(".kanban-card-del").addEventListener("click", async () => {
        const ok = await confirm(`Delete "${data.title}"?`);
        if (!ok) return;
        deleteDoc(doc(db, "users", _uid, "projects", _pid, "kanban_tasks", id)).catch(console.error);
    });

    list.appendChild(el);
}

function _openForm(id, col, data) {
    _editId = id;
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

    try {
        if (_editId) {
            await updateDoc(
                doc(db, "users", _uid, "projects", _pid, "kanban_tasks", _editId),
                { title, desc, priority, col, updatedAt: serverTimestamp() }
            );
        } else {
            await addDoc(refs.kanbanTasks(db, _uid, _pid), {
                title, desc, priority, col,
                order: Date.now(),
                createdAt: serverTimestamp(),
            });
        }
        closeModal("modal-kanban-task");
    } catch (err) {
        console.error(err);
        toast("Error saving task", "error");
    }
}

// ── Drag-and-drop between columns ──────────────────────────────────────────

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
            if (!taskId || !newCol || _dragging.dataset.col === newCol) return;

            updateDoc(
                doc(db, "users", _uid, "projects", _pid, "kanban_tasks", taskId),
                { col: newCol, updatedAt: serverTimestamp() }
            ).catch(console.error);
        });
    });
}
