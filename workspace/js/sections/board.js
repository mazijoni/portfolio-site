/**
 * sections/board.js — Milanote-style visual board.
 * Items can be: note | link | image
 * Items are freely draggable on the canvas.
 * Position (x, y) is stored in Firestore.
 */

import {
    onSnapshot, addDoc, deleteDoc, updateDoc,
    query, orderBy, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }                from "../app.js";
import { currentProjectId }        from "../projects.js";
import { refs }                    from "../db.js";
import { openModal, closeModal,
         toast, escHtml }          from "../ui.js";

let _unsub     = null;
let _pid       = null;
let _uid       = null;
let _colorSel  = "#1e1e1e";

export function init() {
    window.addEventListener("projectSelected", ({ detail }) => {
        _pid = detail.id;
        _uid = auth.currentUser?.uid;
        _subscribe();
    });

    window.addEventListener("sectionActivated", (e) => {
        if (e.detail.section === "board" && currentProjectId !== _pid) {
            _pid = currentProjectId;
            _uid = auth.currentUser?.uid;
            _subscribe();
        }
    });

    document.getElementById("btn-add-board-note")
        .addEventListener("click", () => _openBoardForm("note"));
    document.getElementById("btn-add-board-link")
        .addEventListener("click", () => _openBoardForm("link"));
    document.getElementById("btn-add-board-image")
        .addEventListener("click", () => _openBoardForm("image"));

    document.getElementById("form-board-item")
        .addEventListener("submit", _onFormSubmit);

    // Color swatches
    document.getElementById("board-color-swatches")
        .addEventListener("click", (e) => {
            const sw = e.target.closest(".color-swatch");
            if (!sw) return;
            document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
            sw.classList.add("active");
            _colorSel = sw.dataset.color;
        });

    if (currentProjectId) {
        _pid = currentProjectId;
        _uid = auth.currentUser?.uid;
        _subscribe();
    }
}

function _subscribe() {
    if (_unsub) _unsub();
    if (!_pid || !_uid) return;

    const q = query(refs.boardItems(db, _uid, _pid), orderBy("createdAt"));
    _unsub = onSnapshot(q, (snap) => {
        const canvas = document.getElementById("board-canvas");
        const empty  = document.getElementById("board-empty");

        // Remove existing cards (keep empty placeholder)
        canvas.querySelectorAll(".board-item").forEach(el => el.remove());

        if (snap.empty) {
            empty.style.display = "";
            return;
        }
        empty.style.display = "none";

        snap.forEach(d => _renderItem(d.id, d.data()));
    });
}

function _renderItem(id, data) {
    const canvas = document.getElementById("board-canvas");

    const el = document.createElement("div");
    el.className     = "board-item";
    el.dataset.id    = id;
    el.style.left    = (data.x ?? 40) + "px";
    el.style.top     = (data.y ?? 40) + "px";
    el.style.background = data.color || "#1e1e1e";

    el.innerHTML = `
        <div class="board-item-type">${escHtml(data.type || "note")}</div>
        <div class="board-item-content">${escHtml(data.content || "")}</div>
        ${data.url ? `<a class="board-item-link" href="${escHtml(data.url)}" target="_blank" rel="noopener">${escHtml(data.label || data.url)}</a>` : ""}
        <div class="board-item-actions">
            <button class="board-item-del" title="Delete">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>`;

    el.querySelector(".board-item-del").addEventListener("click", () => _deleteItem(id));

    _makeDraggable(el, id);
    canvas.appendChild(el);
}

function _makeDraggable(el, id) {
    let startX, startY, startLeft, startTop;

    el.addEventListener("mousedown", (e) => {
        if (e.target.closest(".board-item-del") || e.target.closest("a")) return;
        e.preventDefault();
        startX    = e.clientX;
        startY    = e.clientY;
        startLeft = parseInt(el.style.left) || 0;
        startTop  = parseInt(el.style.top)  || 0;

        const onMove = (ev) => {
            el.style.left = (startLeft + ev.clientX - startX) + "px";
            el.style.top  = (startTop  + ev.clientY - startY) + "px";
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup",   onUp);
            // Persist new position
            const x = parseInt(el.style.left);
            const y = parseInt(el.style.top);
            updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id), { x, y })
                .catch(console.error);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
    });
}

async function _deleteItem(id) {
    try {
        await deleteDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id));
    } catch (err) {
        console.error(err);
        toast("Error deleting item", "error");
    }
}

/* ── Form ── */

function _openBoardForm(type) {
    const form    = document.getElementById("form-board-item");
    const titleEl = document.getElementById("modal-board-item-title");

    form.reset();
    document.getElementById("board-item-id-field").value   = "";
    document.getElementById("board-item-type-field").value = type;

    // Show/hide fields by type
    document.getElementById("board-field-content-group").style.display =
        type === "link" ? "none" : "";
    document.getElementById("board-field-url-group").style.display =
        type === "link" || type === "image" ? "" : "none";
    document.getElementById("board-field-label-group").style.display =
        type === "link" ? "" : "none";

    titleEl.textContent = type === "note" ? "Add Note"
        : type === "link" ? "Add Link" : "Add Image";

    _colorSel = "#1e1e1e";
    document.querySelectorAll(".color-swatch").forEach((s, i) => {
        s.classList.toggle("active", i === 0);
    });

    openModal("modal-board-item");
}

async function _onFormSubmit(e) {
    e.preventDefault();
    if (!_pid || !_uid) return;

    const type    = document.getElementById("board-item-type-field").value;
    const content = document.getElementById("board-field-content").value.trim();
    const url     = document.getElementById("board-field-url").value.trim();
    const label   = document.getElementById("board-field-label").value.trim();

    // Offset new cards slightly so they don't all stack
    const canvas = document.getElementById("board-canvas");
    const count  = canvas.querySelectorAll(".board-item").length;
    const x = 32 + (count % 5) * 240;
    const y = 32 + Math.floor(count / 5) * 130;

    try {
        await addDoc(refs.boardItems(db, _uid, _pid), {
            type, content, url, label,
            color: _colorSel,
            x, y,
            createdAt: serverTimestamp(),
        });
        closeModal("modal-board-item");
    } catch (err) {
        console.error(err);
        toast("Error adding item", "error");
    }
}
