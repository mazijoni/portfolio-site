/**
 * sections/board.js — Milanote-style freeform visual board.
 *
 * Card types:
 *   note     — coloured sticky note (editable textarea)
 *   link     — bookmark card with screenshot preview
 *   image    — image card (URL or picked from media)
 *   todo     — checklist card
 *   heading  — large section label
 *
 * Interactions:
 *   — Drag cards freely on the infinite canvas
 *   — Pan canvas with middle-mouse or Space+drag
 *   — Click card text to edit in-place
 *   — "From Media" picker copies image/site from users/{uid}/links
 */

import {
    onSnapshot, addDoc, deleteDoc, updateDoc, getDocs,
    query, orderBy, doc, serverTimestamp, collection
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }                    from "../app.js";
import { currentProjectId }            from "../projects.js";
import { refs }                        from "../db.js";
import { openModal, closeModal,
         toast, confirm, escHtml }     from "../ui.js";

/* ── State ── */
let _unsub      = null;
let _pid        = null;
let _uid        = null;
let _colorSel   = "#1e1e1e";
let _editingId  = null;   // id of card being in-place edited

// Pan state
let _panX = 0, _panY = 0;
let _panning = false, _panStart = null;

// Media picker callback
let _mediaCb = null;

// Drop position for link/image forms opened via palette drag
let _pendingDropX = null, _pendingDropY = null;

// Multiselect
let _boardSel = new Set();

// Box-select state
let _boxSel = null; // { startX, startY, el } in canvas-relative coords

/* ──────────────────────────────────────────────────────── init ── */

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

    // Toolbar buttons
    // (removed — now using drag-and-drop palette)

    // Palette drag-and-drop
    document.querySelectorAll("#board-palette .palette-item").forEach(item => {
        item.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", item.dataset.type);
            e.dataTransfer.effectAllowed = "copy";
        });
    });

    const canvas = document.getElementById("board-canvas");
    canvas.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });
    canvas.addEventListener("drop", (e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData("text/plain");
        if (!type) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left - _panX;
        const y = e.clientY - rect.top  - _panY;
        if (type === "link") {
            _pendingDropX = x; _pendingDropY = y;
            _openLinkForm();
        } else if (type === "image") {
            _pendingDropX = x; _pendingDropY = y;
            _openImageForm();
        } else {
            _addCard(type, x, y);
        }
    });

    // Link form
    document.getElementById("form-board-link")
        .addEventListener("submit", _onLinkSubmit);

    // Image form
    document.getElementById("form-board-image")
        .addEventListener("submit", _onImageSubmit);
    document.getElementById("btn-board-from-media")
        .addEventListener("click", () => _openMediaPicker((link) => {
            document.getElementById("board-image-url-field").value =
                link.imageUrl || link.thumbUrl || link.url || "";
            document.getElementById("board-image-label-field").value = link.name || "";
        }));

    // Color swatches (link form)
    document.getElementById("board-color-swatches")
        .addEventListener("click", (e) => {
            const sw = e.target.closest(".color-swatch");
            if (!sw) return;
            document.querySelectorAll("#board-color-swatches .color-swatch")
                .forEach(s => s.classList.remove("active"));
            sw.classList.add("active");
            _colorSel = sw.dataset.color;
        });

    // Canvas pan + box-select
    canvas.addEventListener("mousedown", _onCanvasMouseDown);
    document.addEventListener("mousemove", _onCanvasMouseMove);
    document.addEventListener("mouseup",   _onCanvasMouseUp);
    canvas.addEventListener("wheel", _onCanvasWheel, { passive: false });

    // Delete key removes selected cards
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        if (!document.getElementById("section-board").classList.contains("active")) return;
        if (e.target.matches("input, textarea, [contenteditable]")) return;
        if (!_boardSel.size || !_pid || !_uid) return;
        e.preventDefault();
        const ids = [..._boardSel];
        _clearBoardSel();
        Promise.all(ids.map(id =>
            deleteDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id)).catch(console.error)
        ));
    });

    // Media picker form
    document.getElementById("board-media-search")
        .addEventListener("input", _filterMediaPicker);

    if (currentProjectId) {
        _pid = currentProjectId;
        _uid = auth.currentUser?.uid;
        _subscribe();
    }
}

/* ────────────────────────────────────────────── subscribe ── */

function _subscribe() {
    if (_unsub) _unsub();
    if (!_pid || !_uid) return;

    const q = query(refs.boardItems(db, _uid, _pid), orderBy("createdAt"));
    _unsub = onSnapshot(q, (snap) => {
        const canvas = document.getElementById("board-canvas-inner");
        const empty  = document.getElementById("board-empty");

        canvas.querySelectorAll(".board-card").forEach(el => el.remove());

        if (snap.empty) { empty.style.display = ""; return; }
        empty.style.display = "none";

        snap.forEach(d => _renderCard(d.id, d.data()));
    });
}

/* ────────────────────────────────────────────── render ── */

function _renderCard(id, data) {
    const inner = document.getElementById("board-canvas-inner");
    const el    = document.createElement("div");

    el.className     = "board-card board-card--" + (data.type || "note");
    el.dataset.id    = id;
    el.style.left    = (data.x ?? 40) + "px";
    el.style.top     = (data.y ?? 40) + "px";
    if (data.w) el.style.width  = data.w + "px";
    if (data.h) el.style.height = data.h + "px";
    if (data.color) el.style.setProperty("--card-bg", data.color);

    el.innerHTML = _cardHTML(id, data);

    // Re-apply selected state after re-render
    if (_boardSel.has(id)) el.classList.add("selected");

    // Delete button
    el.querySelector(".board-card-del")?.addEventListener("click", (e) => {
        e.stopPropagation();
        _deleteCard(id);
    });

    // Click to edit
    if (data.type === "todo") {
        // Whole card opens editor, except checkboxes / delete / resize
        el.addEventListener("click", (e) => {
            if (e.target.closest(".board-todo-check") ||
                e.target.closest(".board-card-del") ||
                e.target.closest(".board-card-resize")) return;
            e.stopPropagation();
            _openTodoEditor(id, data);
        });
    } else if (data.type === "note" || data.type === "heading") {
        const contentEl = el.querySelector(".board-card-text");
        if (contentEl) {
            el.querySelector(".board-card-edit")?.addEventListener("click", (e) => {
                e.stopPropagation();
                _startEdit(el, id, data);
            });
            contentEl.addEventListener("click", (e) => {
                e.stopPropagation();
                _startEdit(el, id, data);
            });
        }
    }

    // Checkbox toggles (todo)
    el.querySelectorAll(".board-todo-check").forEach(cb => {
        cb.addEventListener("change", () => _toggleTodo(id, cb.dataset.idx, cb.checked, data));
    });

    // Resize handle
    const resizeHandle = el.querySelector(".board-card-resize");
    if (resizeHandle) _makeResizable(el, resizeHandle, id);

    _makeDraggable(el, id);
    inner.appendChild(el);
}

function _cardHTML(id, data) {
    const type = data.type || "note";
    const del  = `<button class="board-card-del" title="Delete">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
    const editBtn = `<button class="board-card-edit" title="Edit">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>`;
    const resize = `<div class="board-card-resize"></div>`;

    if (type === "heading") {
        return `<div class="board-card-actions">${editBtn}${del}</div>
            <div class="board-card-text board-heading-text">${escHtml(data.content || "Heading")}</div>`;
    }

    if (type === "note") {
        return `<div class="board-card-actions">${editBtn}${del}</div>
            <div class="board-card-text">${escHtml(data.content || "").replace(/\n/g, "<br>")}</div>
            ${resize}`;
    }

    if (type === "link") {
        const faviconUrl = _getFavicon(data.url);
        const thumbSrc   = data.imageUrl || _getScreenshot(data.url);
        const pretty     = _prettyUrl(data.url);
        const fbId       = "bfb_" + id;
        return `<div class="board-card-actions">${del}</div>
            <a class="board-link-inner" href="${escHtml(data.url || "#")}" target="_blank" rel="noopener noreferrer">
                <div class="board-link-thumb">
                    <img class="board-link-thumb-img" src="${escHtml(thumbSrc)}" alt=""
                         onerror="this.style.display='none';document.getElementById('${fbId}').style.display='flex'">
                    <div class="board-link-thumb-fb" id="${fbId}" style="display:none">
                        <img src="${escHtml(faviconUrl)}" alt="" onerror="this.style.display='none'">
                    </div>
                </div>
                <div class="board-link-body">
                    <div class="board-link-name">${escHtml(data.label || data.url || "")}</div>
                    <div class="board-link-url">${escHtml(pretty)}</div>
                </div>
            </a>`;
    }

    if (type === "image") {
        return `<div class="board-card-actions">${del}</div>
            <div class="board-image-wrap">
                ${data.url
                    ? `<img src="${escHtml(data.url)}" alt="${escHtml(data.label || "")}">`
                    : `<div class="board-image-empty">No image</div>`}
            </div>
            ${data.label ? `<div class="board-image-label">${escHtml(data.label)}</div>` : ""}
            ${resize}`;
    }

    if (type === "todo") {
        const items = Array.isArray(data.todos) ? data.todos : [];
        const rows  = items.map((t, i) => `
            <label class="board-todo-row">
                <input type="checkbox" class="board-todo-check" data-idx="${i}" ${t.done ? "checked" : ""}>
                <span class="${t.done ? "board-todo-done" : ""}">${escHtml(t.text || "")}</span>
            </label>`).join("");
        return `<div class="board-card-actions">${editBtn}${del}</div>
            <div class="board-card-text board-todo-title">${escHtml(data.content || "Checklist")}</div>
            <div class="board-todo-list">${rows}</div>
            ${resize}`;
    }

    return `<div class="board-card-content">${escHtml(data.content || "")}</div>${del}`;
}

/* ────────────────────────────────────────────── in-place edit ── */

function _startEdit(el, id, data) {
    if (_editingId === id) return;
    _editingId = id;

    const textEl = el.querySelector(".board-card-text");
    const type   = data.type || "note";

    if (type === "todo") {
        // Open a simple prompt-style modal for the title + items
        _openTodoEditor(id, data);
        _editingId = null;
        return;
    }

    const prev = data.content || "";
    textEl.style.display = "none";

    const ta = document.createElement("textarea");
    ta.className     = "board-card-textarea";
    ta.value         = prev;
    ta.style.height  = Math.max(80, textEl.offsetHeight) + "px";
    el.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const save = async () => {
        const val = ta.value.trim();
        ta.remove();
        textEl.style.display = "";
        _editingId = null;
        if (val !== prev) {
            textEl.innerHTML = type === "heading"
                ? escHtml(val)
                : escHtml(val).replace(/\n/g, "<br>");
            await updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
                { content: val }).catch(console.error);
        }
    };

    ta.addEventListener("blur", save);
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { ta.value = prev; ta.blur(); }
        if (e.key === "Enter" && !e.shiftKey && type === "heading") { e.preventDefault(); ta.blur(); }
    });
}

function _openTodoEditor(id, data) {
    const items    = Array.isArray(data.todos) ? data.todos : [];
    const titleEl  = document.getElementById("board-todo-title-field");
    const listEl   = document.getElementById("board-todo-editor-list");

    titleEl.value = data.content || "";
    listEl.innerHTML = "";

    const renderRows = () => {
        listEl.innerHTML = "";
        items.forEach((t, i) => {
            const row = document.createElement("div");
            row.className = "todo-editor-row";
            row.innerHTML = `
                <input type="checkbox" class="te-check" ${t.done ? "checked" : ""}>
                <input type="text" class="te-text" value="${escHtml(t.text || "")}" placeholder="Item…">
                <button type="button" class="te-del">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>`;
            row.querySelector(".te-check").addEventListener("change", (e) => {
                items[i].done = e.target.checked;
            });
            row.querySelector(".te-text").addEventListener("input", (e) => {
                items[i].text = e.target.value;
            });
            row.querySelector(".te-del").addEventListener("click", () => {
                items.splice(i, 1);
                renderRows();
            });
            listEl.appendChild(row);
        });
    };
    renderRows();

    document.getElementById("btn-todo-add-item").onclick = () => {
        items.push({ text: "", done: false });
        renderRows();
        listEl.lastElementChild?.querySelector(".te-text")?.focus();
    };

    document.getElementById("btn-todo-save").onclick = async () => {
        const title = titleEl.value.trim() || "Checklist";
        const todos = items.map(t => ({ text: t.text.trim(), done: t.done }))
                           .filter(t => t.text);
        await updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
            { content: title, todos }).catch(console.error);
        closeModal("modal-board-todo");
    };

    document.getElementById("board-todo-id-field").value = id;
    openModal("modal-board-todo");
}

/* ────────────────────────────────────────────── actions ── */

async function _addCard(type, dropX, dropY) {
    if (!_pid || !_uid) return;
    let x, y;
    if (dropX != null && dropY != null) {
        x = Math.round(dropX);
        y = Math.round(dropY);
    } else {
        const inner = document.getElementById("board-canvas-inner");
        const count = inner.querySelectorAll(".board-card").length;
        x = 32 + (count % 5) * 250 - _panX;
        y = 32 + Math.floor(count / 5) * 160 - _panY;
    }

    const base = { type, x, y, createdAt: serverTimestamp() };
    if (type === "note")    base.content = "Note";
    if (type === "heading") base.content = "Heading";
    if (type === "todo")    { base.content = "Checklist"; base.todos = []; }

    try {
        const ref = await addDoc(refs.boardItems(db, _uid, _pid), base);
        // Open editor right away for todo
        if (type === "todo") {
            setTimeout(() => _openTodoEditor(ref.id, base), 150);
        } else {
            // Brief flash then start editing
            setTimeout(() => {
                const newEl = document.querySelector(`.board-card[data-id="${ref.id}"]`);
                if (newEl) _startEdit(newEl, ref.id, { ...base, content: "" });
            }, 200);
        }
    } catch (err) {
        console.error(err);
        toast("Error adding card", "error");
    }
}

/* ── Link form ── */

function _openLinkForm() {
    document.getElementById("form-board-link").reset();
    _colorSel = "#1e1e1e";
    document.querySelectorAll("#board-color-swatches .color-swatch")
        .forEach((s, i) => s.classList.toggle("active", i === 0));
    openModal("modal-board-link");
    setTimeout(() => document.getElementById("board-link-url-field").focus(), 60);
}

async function _onLinkSubmit(e) {
    e.preventDefault();
    if (!_pid || !_uid) return;
    const url   = document.getElementById("board-link-url-field").value.trim();
    const label = document.getElementById("board-link-label-field").value.trim();
    if (!url) return;
    let x, y;
    if (_pendingDropX != null && _pendingDropY != null) {
        x = _pendingDropX; y = _pendingDropY;
        _pendingDropX = _pendingDropY = null;
    } else {
        const inner = document.getElementById("board-canvas-inner");
        const count = inner.querySelectorAll(".board-card").length;
        x = 32 + (count % 4) * 250 - _panX;
        y = 32 + Math.floor(count / 4) * 180 - _panY;
    }
    try {
        await addDoc(refs.boardItems(db, _uid, _pid), {
            type: "link", url, label, x, y, createdAt: serverTimestamp()
        });
        closeModal("modal-board-link");
    } catch (err) {
        console.error(err);
        toast("Error adding link", "error");
    }
}

/* ── Image form ── */

function _openImageForm() {
    document.getElementById("form-board-image").reset();
    openModal("modal-board-image");
    setTimeout(() => document.getElementById("board-image-url-field").focus(), 60);
}

async function _onImageSubmit(e) {
    e.preventDefault();
    if (!_pid || !_uid) return;
    const url   = document.getElementById("board-image-url-field").value.trim();
    const label = document.getElementById("board-image-label-field").value.trim();
    if (!url) return;
    let x, y;
    if (_pendingDropX != null && _pendingDropY != null) {
        x = _pendingDropX; y = _pendingDropY;
        _pendingDropX = _pendingDropY = null;
    } else {
        const inner = document.getElementById("board-canvas-inner");
        const count = inner.querySelectorAll(".board-card").length;
        x = 32 + (count % 4) * 250 - _panX;
        y = 32 + Math.floor(count / 4) * 220 - _panY;
    }
    try {
        await addDoc(refs.boardItems(db, _uid, _pid), {
            type: "image", url, label, x, y, createdAt: serverTimestamp()
        });
        closeModal("modal-board-image");
    } catch (err) {
        console.error(err);
        toast("Error adding image", "error");
    }
}

async function _deleteCard(id) {
    _boardSel.delete(id);
    try {
        await deleteDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id));
    } catch (err) {
        console.error(err);
        toast("Error deleting card", "error");
    }
}

function _toggleBoardSel(id, el) {
    if (_boardSel.has(id)) {
        _boardSel.delete(id);
        el.classList.remove("selected");
    } else {
        _boardSel.add(id);
        el.classList.add("selected");
    }
}

function _clearBoardSel() {
    _boardSel.forEach(id => {
        document.querySelector(`.board-card[data-id="${id}"]`)?.classList.remove("selected");
    });
    _boardSel.clear();
}

async function _toggleTodo(id, idx, done, data) {
    const todos = Array.isArray(data.todos) ? [...data.todos] : [];
    if (todos[idx]) todos[idx] = { ...todos[idx], done };
    await updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
        { todos }).catch(console.error);
}

/* ────────────────────────────────────────────── drag ── */

function _makeDraggable(el, id) {
    el.addEventListener("mousedown", (e) => {
        if (e.target.closest(".board-card-del") ||
            e.target.closest(".board-card-edit") ||
            e.target.closest(".board-card-resize") ||
            e.target.closest(".board-card-textarea") ||
            e.target.closest(".board-card-text") ||
            e.target.closest("a") ||
            e.target.closest(".board-todo-check") ||
            e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        let moved    = false;

        // Group drag: if this card is selected, move all selected cards together
        const isGroup = _boardSel.has(id);
        const group   = isGroup
            ? [...document.querySelectorAll(".board-card")].filter(c => _boardSel.has(c.dataset.id))
            : [el];
        const starts  = group.map(c => ({
            el:   c,
            id:   c.dataset.id,
            left: parseInt(c.style.left) || 0,
            top:  parseInt(c.style.top)  || 0,
        }));

        group.forEach(c => c.classList.add("dragging"));

        const onMove = (ev) => {
            moved = true;
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            starts.forEach(g => {
                g.el.style.left = (g.left + dx) + "px";
                g.el.style.top  = (g.top  + dy) + "px";
            });
        };
        const onUp = () => {
            group.forEach(c => c.classList.remove("dragging"));
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup",   onUp);
            if (!moved) return;
            starts.forEach(g => {
                updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", g.id),
                    { x: parseInt(g.el.style.left), y: parseInt(g.el.style.top) })
                    .catch(console.error);
            });
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
    });
}

/* ────────────────────────────────────────────── resize ── */

function _makeResizable(el, handle, id) {
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = el.offsetWidth;
        const startH = el.offsetHeight;

        const onMove = (ev) => {
            const w = Math.max(160, startW + ev.clientX - startX);
            const h = Math.max(80,  startH + ev.clientY - startY);
            el.style.width  = w + "px";
            el.style.height = h + "px";
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup",   onUp);
            updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
                { w: el.offsetWidth, h: el.offsetHeight }).catch(console.error);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
    });
}

/* ────────────────────────────────────────────── canvas pan ── */

function _onCanvasMouseDown(e) {
    const isMiddle = e.button === 1;
    const isSpace  = e._spaceDown;
    if (isMiddle || isSpace) {
        // Pan
        if (isMiddle) e.preventDefault();
        _panning  = true;
        _panStart = { x: e.clientX - _panX, y: e.clientY - _panY };
        return;
    }
    if (e.button !== 0) return;
    // Start box-select only if clicking on empty canvas (not a card)
    if (e.target.closest(".board-card")) return;
    e.preventDefault();
    const canvas = document.getElementById("board-canvas");
    const rect   = canvas.getBoundingClientRect();
    const sx     = e.clientX - rect.left;
    const sy     = e.clientY - rect.top;
    const boxEl  = document.createElement("div");
    boxEl.className = "board-select-box";
    boxEl.style.left = sx + "px";
    boxEl.style.top  = sy + "px";
    canvas.appendChild(boxEl);
    _boxSel = { startX: sx, startY: sy, el: boxEl };
}

function _onCanvasMouseMove(e) {
    if (_panning && _panStart) {
        _panX = e.clientX - _panStart.x;
        _panY = e.clientY - _panStart.y;
        document.getElementById("board-canvas-inner").style.transform =
            `translate(${_panX}px, ${_panY}px)`;
        return;
    }
    if (!_boxSel) return;
    const canvas = document.getElementById("board-canvas");
    const rect   = canvas.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const x  = Math.min(cx, _boxSel.startX);
    const y  = Math.min(cy, _boxSel.startY);
    const w  = Math.abs(cx - _boxSel.startX);
    const h  = Math.abs(cy - _boxSel.startY);
    _boxSel.el.style.left   = x + "px";
    _boxSel.el.style.top    = y + "px";
    _boxSel.el.style.width  = w + "px";
    _boxSel.el.style.height = h + "px";
}

function _onCanvasMouseUp(e) {
    if (_panning) {
        _panning  = false;
        _panStart = null;
        return;
    }
    if (!_boxSel) return;
    const canvas    = document.getElementById("board-canvas");
    const rect      = canvas.getBoundingClientRect();
    const cx        = e.clientX - rect.left;
    const cy        = e.clientY - rect.top;
    const selLeft   = Math.min(cx, _boxSel.startX);
    const selTop    = Math.min(cy, _boxSel.startY);
    const selRight  = selLeft + Math.abs(cx - _boxSel.startX);
    const selBottom = selTop  + Math.abs(cy - _boxSel.startY);
    _boxSel.el.remove();
    _boxSel = null;

    // Tiny drag / plain click on empty canvas → deselect
    if (selRight - selLeft < 4 && selBottom - selTop < 4) {
        _clearBoardSel();
        return;
    }
    _clearBoardSel();

    // Use bounding rects — automatically handles pan/transform
    document.querySelectorAll(".board-card").forEach(card => {
        const cr   = card.getBoundingClientRect();
        const cl_v = cr.left   - rect.left;
        const ct_v = cr.top    - rect.top;
        const cr_v = cr.right  - rect.left;
        const cb_v = cr.bottom - rect.top;
        if (cr_v > selLeft && cl_v < selRight && cb_v > selTop && ct_v < selBottom) {
            _boardSel.add(card.dataset.id);
            card.classList.add("selected");
        }
    });
}

function _onCanvasWheel(e) {
    if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        _panX -= e.deltaX;
        _panY -= e.deltaY;
        document.getElementById("board-canvas-inner").style.transform =
            `translate(${_panX}px, ${_panY}px)`;
    }
}

// Track Space key for pan mode
document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.target.matches("input,textarea")) {
        e.preventDefault();
        document.getElementById("board-canvas")?.classList.add("canvas-pan-mode");
    }
});
document.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
        document.getElementById("board-canvas")?.classList.remove("canvas-pan-mode");
    }
});

/* ────────────────────────────────────────────── media picker ── */

let _mediaLinks = [];

async function _openMediaPicker(cb) {
    _mediaCb = cb;
    _mediaLinks = [];
    const listEl = document.getElementById("board-media-picker-list");
    listEl.innerHTML = `<div class="bmp-loading">Loading…</div>`;
    document.getElementById("board-media-search").value = "";
    openModal("modal-board-media");

    try {
        const snap = await getDocs(
            query(collection(db, "users", _uid, "links"), orderBy("createdAt"))
        );
        _mediaLinks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _renderMediaPicker(_mediaLinks);
    } catch (err) {
        console.error(err);
        listEl.innerHTML = `<div class="bmp-loading">Failed to load.</div>`;
    }
}

function _renderMediaPicker(links) {
    const listEl = document.getElementById("board-media-picker-list");
    if (!links.length) {
        listEl.innerHTML = `<div class="bmp-loading">No media found in your Media tab.</div>`;
        return;
    }
    listEl.innerHTML = "";
    links.forEach(link => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "bmp-item";
        const thumb = link.imageUrl || link.thumbUrl || link.avatarUrl || "";
        const favicon = _getFavicon(link.url);
        item.innerHTML = `
            <div class="bmp-thumb">
                ${thumb
                    ? `<img src="${escHtml(thumb)}" alt="" onerror="this.style.display='none'">`
                    : `<img src="${escHtml(favicon)}" alt="" style="width:24px;height:24px;object-fit:contain" onerror="this.style.display='none'">`}
            </div>
            <div class="bmp-name">${escHtml(link.name || link.url || "")}</div>`;
        item.addEventListener("click", () => {
            if (_mediaCb) _mediaCb(link);
            closeModal("modal-board-media");
        });
        listEl.appendChild(item);
    });
}

function _filterMediaPicker() {
    const q = document.getElementById("board-media-search").value.toLowerCase();
    const filtered = _mediaLinks.filter(l =>
        (l.name || "").toLowerCase().includes(q) ||
        (l.url  || "").toLowerCase().includes(q));
    _renderMediaPicker(filtered);
}

/* ────────────────────────────────────────────── helpers ── */

function _getFavicon(url) {
    try { return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`; }
    catch { return ""; }
}

function _getScreenshot(url) {
    if (!url) return "";
    return `https://image.thum.io/get/width/400/crop/225/noanimate/${encodeURIComponent(url)}`;
}

function _prettyUrl(url) {
    try { const u = new URL(url); return (u.hostname + u.pathname).replace(/\/$/, ""); }
    catch { return url || ""; }
}
