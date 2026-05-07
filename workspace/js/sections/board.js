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
    query, orderBy, where, doc, serverTimestamp, collection, deleteField
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }                    from "../app.js";
import { currentProjectId, currentProject, getDataUid, canCurrentUserEdit } from "../projects.js";
import { refs }                        from "../db.js";
import { openModal, closeModal,
         toast, confirm, escHtml }     from "../ui.js";

/* ── State ── */
let _unsub      = null;
let _pid        = null;
let _uid        = null;
let _canEdit    = true;
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

// Card data cache id → data (for duplicate, context menu)
let _cardData = new Map();

// Prevents accidental link-click / embed-activation after a drag
let _justDragged = false;

// Context menu / color picker state
let _ctxMenuId  = null;
let _ctxCanvasX = 0;
let _ctxCanvasY = 0;

// Arrow/connection state
let _arrowUnsub   = null;
let _arrowData    = new Map(); // arrowId → { fromId, toId, fromAnchor, toAnchor }
let _drawingArrow = null;      // { fromId, fromAnchor, tempPath, tempEndX, tempEndY }
let _selectedArrowId = null;

/* ──────────────────────────────────────────────────────── init ── */

export function init() {
    window.addEventListener("projectSelected", ({ detail }) => {
        _pid = detail.id;
        _uid = getDataUid();
        _canEdit = detail.canEdit ?? true;
        _subscribe();
        _subscribeArrows();
    });

    window.addEventListener("sectionActivated", (e) => {
        if (e.detail.section === "board" && currentProjectId !== _pid) {
            _pid = currentProjectId;
            _uid = getDataUid();
            _canEdit = canCurrentUserEdit();
            _subscribe();
            _subscribeArrows();
        }
    });

    // Toolbar buttons — click to add at center
    document.querySelectorAll("#board-toolbar .btb-btn[data-type]").forEach(btn => {
        btn.addEventListener("click", () => {
            if (!_canEdit) { toast("View-only access", "info"); return; }
            const type = btn.dataset.type;
            const cvs  = document.getElementById("board-canvas");
            const rect = cvs?.getBoundingClientRect();
            const cx   = (rect ? rect.width  / 2 : 400) - _panX;
            const cy   = (rect ? rect.height / 3 : 200) - _panY;
            if      (type === "link")  { _pendingDropX = cx; _pendingDropY = cy; _openLinkForm(); }
            else if (type === "image") { _openImagePicker(cx, cy); }
            else if (type === "embed") { _pendingDropX = cx; _pendingDropY = cy; _openEmbedForm(); }
            else                       { _addCard(type, cx, cy); }
        });

        // Drag-from-toolbar
        btn.setAttribute("draggable", "true");
        btn.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("board-type", btn.dataset.type);
            e.dataTransfer.effectAllowed = "copy";
        });
    });

    // Canvas drop handler for drag-from-toolbar
    const canvas = document.getElementById("board-canvas");
    canvas.addEventListener("dragover", (e) => {
        if (e.dataTransfer.types.includes("board-type")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        }
    });
    canvas.addEventListener("drop", (e) => {
        const type = e.dataTransfer.getData("board-type");
        if (!type) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const x = Math.round(e.clientX - rect.left - _panX);
        const y = Math.round(e.clientY - rect.top  - _panY);
        if      (type === "link")  { _pendingDropX = x; _pendingDropY = y; _openLinkForm(); }
        else if (type === "image") { _openImagePicker(x, y); }
        else if (type === "embed") { _pendingDropX = x; _pendingDropY = y; _openEmbedForm(); }
        else                       { _addCard(type, x, y); }
    });

    // Double-click canvas → create note
    canvas.addEventListener("dblclick", (e) => {
        if (e.target.closest(".board-card")) return;
        const rect = canvas.getBoundingClientRect();
        const x = Math.round(e.clientX - rect.left - _panX);
        const y = Math.round(e.clientY - rect.top  - _panY);
        _addCard("note", x, y);
    });

    // Link form
    document.getElementById("form-board-link")
        ?.addEventListener("submit", _onLinkSubmit);

    // Image form (legacy URL form - keep listener safe)
    document.getElementById("form-board-image")
        ?.addEventListener("submit", _onImageSubmit);

    // Embed form
    document.getElementById("form-board-embed")
        ?.addEventListener("submit", _onEmbedSubmit);

    // Media picker source tabs
    document.querySelectorAll("#board-media-tabs .bmp-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            _pickerSource = tab.dataset.source;
            document.querySelectorAll("#board-media-tabs .bmp-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            _filterMediaPicker();
        });
    });

    // Canvas pan + box-select
    canvas.addEventListener("mousedown", _onCanvasMouseDown);
    document.addEventListener("mousemove", _onCanvasMouseMove);
    document.addEventListener("mouseup",   _onCanvasMouseUp);
    canvas.addEventListener("wheel", _onCanvasWheel, { passive: false });

    // Delete key removes selected cards or selected arrow
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        if (!document.getElementById("section-board").classList.contains("active")) return;
        if (e.target.matches("input, textarea, [contenteditable]")) return;

        // Delete selected arrow
        if (_selectedArrowId) {
            const aid = _selectedArrowId;
            _selectedArrowId = null;
            _deselectArrow();
            deleteDoc(doc(db, "users", _uid, "projects", _pid, "board_arrows", aid)).catch(console.error);
            return;
        }

        if (!_boardSel.size || !_pid || !_uid) return;
        e.preventDefault();
        const ids = [..._boardSel];
        _clearBoardSel();
        Promise.all(ids.map(id =>
            deleteDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id)).catch(console.error)
        ));
    });

    // Paste from Milanote (or plain text / URL / image)
    document.addEventListener("paste", _onBoardPaste);

    // Dedicated Milanote import modal
    document.getElementById("btn-board-milanote-import")?.addEventListener("click", () => {
        if (!_canEdit) { toast("View-only access", "info"); return; }
        _openImportModal();
    });
    document.getElementById("board-import-capture")?.addEventListener("paste", _onImportCapturePaste);

    // Media picker form
    document.getElementById("board-media-search")
        ?.addEventListener("input", _filterMediaPicker);

    // Context menu: right-click on canvas or card
    document.getElementById("board-canvas")?.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const cardEl = e.target.closest(".board-card");
        const cvs    = document.getElementById("board-canvas");
        const rect   = cvs.getBoundingClientRect();
        _ctxCanvasX  = e.clientX - rect.left - _panX;
        _ctxCanvasY  = e.clientY - rect.top  - _panY;
        if (cardEl) {
            _showCardCtxMenu(cardEl.dataset.id, e.clientX, e.clientY);
        } else {
            _showCanvasCtxMenu(e.clientX, e.clientY);
        }
    });

    // Delegated canvas click: embed activate + code copy
    document.getElementById("board-canvas")?.addEventListener("click", (e) => {
        // Suppress click that immediately follows a drag (prevents link nav + embed load)
        if (_justDragged) { e.preventDefault(); _justDragged = false; return; }
        // Activate embed iframe on placeholder click
        const placeholder = e.target.closest(".board-embed-placeholder");
        if (placeholder) {
            e.stopPropagation();
            const wrap     = placeholder.closest(".board-embed-wrap");
            const embedUrl = wrap?.dataset.embed;
            if (!embedUrl) return;
            const iframe   = document.createElement("iframe");
            iframe.src     = embedUrl;
            iframe.allowFullscreen = true;
            iframe.allow   = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
            iframe.style.cssText = "width:100%;height:100%;border:none;display:block;position:absolute;inset:0;";
            placeholder.replaceWith(iframe);
            return;
        }

        const btn = e.target.closest(".board-code-copy");
        if (!btn) return;
        const code = btn.closest(".board-card")?.querySelector("code")?.textContent || "";
        navigator.clipboard?.writeText(code).then(() => {
            btn.classList.add("copied");
            setTimeout(() => btn.classList.remove("copied"), 1500);
        }).catch(console.error);
    });

    // Color picker swatches
    document.getElementById("board-color-picker")?.addEventListener("click", (e) => {
        const sw = e.target.closest(".bcp-swatch");
        if (!sw || !_ctxMenuId) return;
        _setCardColor(_ctxMenuId, sw.dataset.color);
        _hideCtxMenu();
    });

    // Custom color input
    const bcpCustom = document.getElementById("bcp-custom-color");
    const bcpHex    = document.getElementById("bcp-hex-input");
    if (bcpCustom && bcpHex) {
        bcpCustom.addEventListener("input", () => { bcpHex.value = bcpCustom.value.toUpperCase(); });
        bcpHex.addEventListener("input", () => {
            if (/^#[0-9A-Fa-f]{6}$/.test(bcpHex.value)) bcpCustom.value = bcpHex.value;
        });
        const applyCustomColor = () => {
            if (!_ctxMenuId) return;
            const hex = bcpHex.value.trim();
            if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return;
            _setCardColor(_ctxMenuId, hex);
            _hideCtxMenu();
        };
        bcpHex.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyCustomColor(); } });
        document.getElementById("bcp-apply-btn")?.addEventListener("click", applyCustomColor);
    }

    // Shape picker
    document.getElementById("board-shape-picker")?.addEventListener("click", (e) => {
        const btn = e.target.closest(".bsp-btn");
        if (!btn || !_ctxMenuId) return;
        _setCardShape(_ctxMenuId, btn.dataset.shape);
        document.getElementById("board-shape-picker").classList.add("hidden");
    });

    // Close menus on outside click
    document.addEventListener("click", (e) => {
        if (!e.target.closest("#board-ctx-menu") &&
            !e.target.closest("#board-color-picker") &&
            !e.target.closest("#board-shape-picker")) {
            _hideCtxMenu();
        }
    });

    if (currentProjectId) {
        _pid = currentProjectId;
        _uid = getDataUid();
        _subscribe();
        _subscribeArrows();
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
        _cardData.clear();

        if (snap.empty) { empty.style.display = ""; return; }
        empty.style.display = "none";

        const docs = snap.docs.map(d => ({ id: d.id, data: d.data() }));
        // 1) Render columns first so their bodies exist
        docs.filter(d => d.data.type === "column").forEach(d => _renderCard(d.id, d.data));
        // 2) Top-level canvas cards
        docs.filter(d => d.data.type !== "column" && !d.data.columnId).forEach(d => _renderCard(d.id, d.data));
        // 3) Column children
        docs.filter(d => d.data.type !== "column" && d.data.columnId).forEach(d => _renderCard(d.id, d.data));
    });
}

/* ────────────────────────────────────────────── render ── */

function _renderCard(id, data) {
    const inner = document.getElementById("board-canvas-inner");
    const el    = document.createElement("div");
    _cardData.set(id, data);

    el.className     = "board-card board-card--" + (data.type || "note");
    el.dataset.id    = id;
    el.style.left    = (data.x ?? 40) + "px";
    el.style.top     = (data.y ?? 40) + "px";
    if (data.w) el.style.width  = data.w + "px";
    if (data.h) el.style.height = data.h + "px";
    if (data.color) _applyCardColor(el, data.color);
    else if (data.type === "shape" && data.shapeColor) _applyCardColor(el, data.shapeColor);

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
    } else if (data.type === "note" || data.type === "heading" || data.type === "quote") {
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
    } else if (data.type === "code") {
        el.addEventListener("click", (e) => {
            if (e.target.closest(".board-card-del") ||
                e.target.closest(".board-card-dup") ||
                e.target.closest(".board-code-copy") ||
                e.target.closest(".board-card-resize")) return;
            e.stopPropagation();
            _openCodeEditor(id, _cardData.get(id) || data);
        });
    } else if (data.type === "tag") {
        el.addEventListener("click", (e) => {
            if (e.target.closest(".board-card-del")) return;
            e.stopPropagation();
            const textEl2 = el.querySelector(".board-tag-text");
            if (!textEl2 || textEl2.tagName === "INPUT") return;
            const prev2 = data.content || "";
            const inp = document.createElement("input");
            inp.type = "text"; inp.value = prev2; inp.className = "board-tag-input";
            textEl2.replaceWith(inp); inp.focus(); inp.select();
            const saveTag = async () => {
                const val2 = inp.value.trim() || prev2;
                inp.replaceWith(Object.assign(document.createElement("span"), {
                    className: "board-tag-text", textContent: val2
                }));
                if (val2 !== prev2) {
                    data.content = val2;
                    _cardData.set(id, data);
                    await updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
                        { content: val2 }).catch(console.error);
                }
            };
            inp.addEventListener("blur", saveTag);
            inp.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter")  { ev.preventDefault(); inp.blur(); }
                if (ev.key === "Escape") { inp.value = prev2;   inp.blur(); }
            });
        });
    } else if (data.type === "shape") {
        const contentEl = el.querySelector(".board-shape-text");
        if (contentEl) {
            contentEl.addEventListener("click", (e) => { e.stopPropagation(); _startEdit(el, id, data); });
        } else {
            el.addEventListener("dblclick", (e) => {
                if (e.target.closest(".board-card-del") || e.target.closest(".board-card-resize")) return;
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

    // Duplicate button
    el.querySelector(".board-card-dup")?.addEventListener("click", (e) => {
        e.stopPropagation();
        _duplicateCard(id, data);
    });

    // ── DOM insertion + type-specific finishing ──
    if (data.type === "column") {
        // Save title on blur/enter
        const titleInput = el.querySelector(".board-column-title");
        if (titleInput) {
            const saveTitle = async () => {
                const val = titleInput.value.trim() || "Group";
                if (val !== (data.content || "Group")) {
                    await updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
                        { content: val }).catch(console.error);
                }
            };
            titleInput.addEventListener("blur", saveTitle);
            titleInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter")  { e.preventDefault(); titleInput.blur(); }
                if (e.key === "Escape") { titleInput.value = data.content || "Group"; titleInput.blur(); }
            });
            titleInput.addEventListener("mousedown", (e) => e.stopPropagation());
            titleInput.addEventListener("click", (e) => e.stopPropagation());
        }
        // Columns sit behind all other cards
        inner.prepend(el);
        _makeDraggable(el, id);
        // no conn dots on columns

    } else if (data.columnId) {
        // ── Column child ──
        el.classList.add("board-card--column-child");
        // Override position so it flows naturally in the column body
        el.style.left = "";
        el.style.top  = "";
        el.style.width  = el.style.width  || "";
        el.style.height = el.style.height || "";

        // Add eject button to pull the card back onto the canvas
        const ejectBtn = document.createElement("button");
        ejectBtn.type      = "button";
        ejectBtn.className = "board-col-eject";
        ejectBtn.title     = "Remove from group";
        ejectBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
        ejectBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            _ejectFromColumn(id, data.columnId);
        });
        const actions = el.querySelector(".board-card-actions");
        if (actions) actions.prepend(ejectBtn);

        const colEl = document.querySelector(`.board-card[data-id="${data.columnId}"]`);
        const body  = colEl?.querySelector(".board-column-body");
        (body || inner).appendChild(el);
        // Column children are not free-draggable; no conn dots

    } else {
        inner.appendChild(el);
        _makeDraggable(el, id);
        _addConnDots(el, id);
    }
}

function _cardHTML(id, data) {
    const type = data.type || "note";
    const del = `<button class="board-card-del" title="Delete">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
    const editBtn = `<button class="board-card-edit" title="Edit">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>`;
    const dupBtn = `<button class="board-card-dup" title="Duplicate">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>`;
    const resize = `<div class="board-card-resize"></div>`;

    if (type === "heading") {
        return `<div class="board-card-actions">${editBtn}${dupBtn}${del}</div>
            <div class="board-card-text board-heading-text">${escHtml(data.content || "Heading")}</div>`;
    }

    if (type === "note") {
        return `<div class="board-card-actions">${editBtn}${dupBtn}${del}</div>
            <div class="board-card-text">${escHtml(data.content || "").replace(/\n/g, "<br>")}</div>
            ${resize}`;
    }

    if (type === "link") {
        const faviconUrl = _getFavicon(data.url);
        const thumbSrc   = data.imageUrl || _getScreenshot(data.url);
        const pretty     = _prettyUrl(data.url);
        const fbId       = "bfb_" + id;
        return `<div class="board-card-actions">${dupBtn}${del}</div>
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
        return `<div class="board-card-actions">${dupBtn}${del}</div>
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
        return `<div class="board-card-actions">${editBtn}${dupBtn}${del}</div>
            <div class="board-card-text board-todo-title">${escHtml(data.content || "Checklist")}</div>
            <div class="board-todo-list">${rows}</div>
            ${resize}`;
    }

    if (type === "code") {
        return `<div class="board-card-actions">${editBtn}${dupBtn}${del}</div>
            <div class="board-code-header">
                <span class="board-code-lang">${escHtml(data.lang || "code")}</span>
                <button class="board-code-copy" title="Copy code">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
            </div>
            <pre class="board-code-pre"><code>${escHtml(data.content || "")}</code></pre>
            ${resize}`;
    }

    if (type === "quote") {
        return `<div class="board-card-actions">${editBtn}${dupBtn}${del}</div>
            <div class="board-quote-accent"></div>
            <div class="board-card-text board-quote-text">${escHtml(data.content || "Quote…").replace(/\n/g, "<br>")}</div>
            ${data.author ? `<div class="board-quote-author">— ${escHtml(data.author)}</div>` : ""}
            ${resize}`;
    }

    if (type === "divider") {
        return `<div class="board-card-actions">${dupBtn}${del}</div>
            <div class="board-divider-inner">
                ${data.label ? `<span class="board-divider-label">${escHtml(data.label)}</span>` : ""}
                <div class="board-divider-line"></div>
            </div>`;
    }

    if (type === "file") {
        const ext   = _getExt(data.url || "");
        const thumb = data.imageUrl || "";
        const thumbHtml = thumb
            ? `<img src="${escHtml(thumb)}" alt="">`
            : `<div class="board-file-ext-badge">${escHtml(ext)}</div>`;
        return `<div class="board-card-actions">${dupBtn}${del}</div>
            <a class="board-file-inner" href="${escHtml(data.url || "#")}" target="_blank" rel="noopener noreferrer">
                <div class="board-file-thumb">${thumbHtml}</div>
                <div class="board-file-meta">
                    <div class="board-file-name">${escHtml(data.label || "File")}</div>
                    <div class="board-file-url">${escHtml(_prettyUrl(data.url || ""))}</div>
                </div>
            </a>`;
    }

    if (type === "tag") {
        return `<div class="board-tag-inner">
            <div class="board-tag-dot"></div>
            <span class="board-tag-text">${escHtml(data.content || "Tag")}</span>
            <button class="board-card-del board-tag-del" title="Delete">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>`;
    }

    if (type === "embed") {
        const eUrl  = _toEmbedUrl(data.url || "");
        const thumb = _embedThumb(data.url || "");
        const plat  = _detectPlatform(data.url || "");
        return `<div class="board-card-actions">${dupBtn}${del}</div>
            <div class="board-embed-wrap" ${eUrl ? `data-embed="${escHtml(eUrl)}"` : ''}>
                ${eUrl
                    ? `<div class="board-embed-placeholder">
                        ${thumb ? `<img class="board-embed-thumb" src="${escHtml(thumb)}" alt="" onerror="this.style.display='none'">` : ""}
                        <div class="board-embed-overlay">
                            <button class="board-embed-play" title="Load embed">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            </button>
                            ${plat ? `<div class="board-embed-platform">${escHtml(plat)}</div>` : ""}
                        </div>
                    </div>`
                    : `<div class="board-embed-fallback">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".4"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="10 9 15 12 10 15 10 9"/></svg>
                        <span>No URL set</span>
                      </div>`}
            </div>
            ${data.label ? `<div class="board-embed-label">${escHtml(data.label)}</div>` : ""}
            ${resize}`;
    }

    if (type === "swatch") {
        return `<div class="board-card-actions">${dupBtn}${del}</div>
            <div class="board-swatch-fill"></div>
            ${data.label ? `<div class="board-swatch-label">${escHtml(data.label)}</div>` : ""}`;
    }

    if (type === "shape") {
        const shapeClass = "board-shape--" + (data.shape || "rect");
        return `<div class="board-card-actions">${editBtn}${dupBtn}${del}</div>
            <div class="board-shape-inner ${shapeClass}">
                ${data.content ? `<div class="board-card-text board-shape-text">${escHtml(data.content)}</div>` : ""}
            </div>
            ${resize}`;
    }

    if (type === "column") {
        return `
            <div class="board-column-header">
                <div class="board-column-drag-handle" title="Drag to move">
                    <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" opacity=".45"><circle cx="2" cy="2" r="1.5"/><circle cx="6" cy="2" r="1.5"/><circle cx="2" cy="6" r="1.5"/><circle cx="6" cy="6" r="1.5"/><circle cx="2" cy="10" r="1.5"/><circle cx="6" cy="10" r="1.5"/></svg>
                </div>
                <input class="board-column-title" value="${escHtml(data.content || 'Group')}" placeholder="Group…" spellcheck="false">
                <div class="board-column-actions">${dupBtn}${del}</div>
            </div>
            <div class="board-column-body"></div>
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
    if (type === "code")    { base.content = "// code"; base.lang = ""; }
    if (type === "quote")   { base.content = "A great quote goes here."; }
    if (type === "divider") { base.label = ""; base.w = 300; base.h = 32; }
    if (type === "tag")     { base.content = "Tag"; }
    if (type === "column")  { base.content = "Column"; base.w = 240; base.h = 240; }
    if (type === "embed")   { base.url = ""; base.label = ""; base.w = 320; base.h = 200; }
    if (type === "swatch")  { base.label = ""; base.w = 140; base.h = 140; base.color = "#F9E4A5"; }
    if (type === "shape")   { base.shape = "rect"; base.color = "#c772fe"; base.content = ""; base.w = 140; base.h = 140; }

    try {
        const ref = await addDoc(refs.boardItems(db, _uid, _pid), base);
        // Open editor right away for todo / code
        if (type === "todo") {
            setTimeout(() => _openTodoEditor(ref.id, base), 150);
        } else if (type === "code") {
            setTimeout(() => _openCodeEditor(ref.id, { ...base }), 200);
        } else if (type !== "divider" && type !== "tag" && type !== "quote" && type !== "file" && type !== "column" && type !== "embed" && type !== "swatch" && type !== "shape") {
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

/* ── Embed form ── */

function _openEmbedForm() {
    document.getElementById("form-board-embed")?.reset();
    openModal("modal-board-embed");
    setTimeout(() => document.getElementById("board-embed-url-field")?.focus(), 60);
}

async function _onEmbedSubmit(e) {
    e.preventDefault();
    if (!_pid || !_uid) return;
    const url   = document.getElementById("board-embed-url-field").value.trim();
    const label = document.getElementById("board-embed-label-field").value.trim();
    if (!url) return;
    let x, y;
    if (_pendingDropX != null && _pendingDropY != null) {
        x = _pendingDropX; y = _pendingDropY;
        _pendingDropX = _pendingDropY = null;
    } else {
        const inner = document.getElementById("board-canvas-inner");
        const count = inner.querySelectorAll(".board-card").length;
        x = 32 + (count % 4) * 340 - _panX;
        y = 32 + Math.floor(count / 4) * 240 - _panY;
    }
    try {
        await addDoc(refs.boardItems(db, _uid, _pid), {
            type: "embed", url, label, x, y, w: 320, h: 200, createdAt: serverTimestamp()
        });
        closeModal("modal-board-embed");
    } catch (err) {
        console.error(err);
        toast("Error adding embed", "error");
    }
}

function _toEmbedUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
            const id = u.hostname === "youtu.be" ? u.pathname.slice(1).split("?")[0] : u.searchParams.get("v");
            return id ? `https://www.youtube.com/embed/${id}?rel=0` : null;
        }
        if (u.hostname.includes("vimeo.com")) {
            const id = u.pathname.split("/").filter(Boolean).pop();
            return id ? `https://player.vimeo.com/video/${id}` : null;
        }
        if (u.hostname.includes("spotify.com")) {
            return url.replace("open.spotify.com/", "open.spotify.com/embed/").split("?")[0];
        }
        if (u.hostname.includes("figma.com")) {
            return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(url)}`;
        }
        if (u.hostname.includes("loom.com")) {
            const id = u.pathname.split("/").filter(Boolean).pop();
            return id ? `https://www.loom.com/embed/${id}` : null;
        }
        if (u.hostname.includes("codepen.io")) {
            return url.replace("/pen/", "/embed/") + "?theme-id=dark&default-tab=result";
        }
        return null;
    } catch { return null; }
}

function _embedThumb(url) {
    if (!url) return "";
    try {
        const u = new URL(url);
        if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
            const id = u.hostname === "youtu.be" ? u.pathname.slice(1).split("?")[0] : u.searchParams.get("v");
            return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : "";
        }
    } catch {}
    return _getScreenshot(url);
}

function _detectPlatform(url) {
    if (!url) return "";
    try {
        const h = new URL(url).hostname;
        if (h.includes("youtube.com") || h.includes("youtu.be")) return "YouTube";
        if (h.includes("vimeo.com"))   return "Vimeo";
        if (h.includes("spotify.com")) return "Spotify";
        if (h.includes("figma.com"))   return "Figma";
        if (h.includes("loom.com"))    return "Loom";
        if (h.includes("codepen.io"))  return "CodePen";
    } catch {}
    return "";
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

/* ─────────────────────────────────────────── duplicate ── */

async function _duplicateCard(id, data) {
    if (!_pid || !_uid || !data) return;
    const { createdAt: _, ...rest } = data;
    await addDoc(refs.boardItems(db, _uid, _pid), {
        ...rest,
        x: (rest.x || 0) + 24,
        y: (rest.y || 0) + 24,
        createdAt: serverTimestamp()
    }).catch(console.error);
}

/* ───────────────────────────────────────── code editor ── */

function _openCodeEditor(id, data) {
    document.getElementById("board-code-content-field").value = data.content || "";
    document.getElementById("board-code-lang-field").value   = data.lang    || "";
    document.getElementById("btn-code-save").onclick = async () => {
        const content = document.getElementById("board-code-content-field").value;
        const lang    = document.getElementById("board-code-lang-field").value.trim() || "code";
        await updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
            { content, lang }).catch(console.error);
        closeModal("modal-board-code");
    };
    openModal("modal-board-code");
    setTimeout(() => document.getElementById("board-code-content-field").focus(), 60);
}

/* ──────────────────────────────── color / context menus ── */

async function _setCardColor(id, color) {
    if (!_pid || !_uid || !id) return;
    // Update immediately in DOM, don't wait for snapshot
    const el = document.querySelector(`.board-card[data-id="${id}"]`);
    if (el) _applyCardColor(el, color || null);
    await updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
        { color }).catch(console.error);
}

async function _setCardShape(id, shape) {
    if (!_pid || !_uid || !id) return;
    await updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
        { shape }).catch(console.error);
}

function _showShapePicker(id, screenX, screenY) {
    _ctxMenuId = id;
    const data = _cardData.get(id);
    const currentShape = data?.shape || "rect";
    const picker = document.getElementById("board-shape-picker");
    picker.querySelectorAll(".bsp-btn").forEach(btn =>
        btn.classList.toggle("active", btn.dataset.shape === currentShape));
    picker.style.left = screenX + "px";
    picker.style.top  = screenY + "px";
    picker.classList.remove("hidden");
    requestAnimationFrame(() => {
        const pw = picker.offsetWidth  || 200;
        const ph = picker.offsetHeight || 100;
        picker.style.left = Math.max(4, Math.min(screenX, window.innerWidth  - pw - 8)) + "px";
        picker.style.top  = Math.max(4, Math.min(screenY, window.innerHeight - ph - 8)) + "px";
    });
}

function _showCanvasCtxMenu(screenX, screenY) {
    const types  = ["note", "heading", "todo", "code", "link", "embed", "swatch", "shape", "column"];
    const labels = { note: "Note", heading: "Heading", todo: "Checklist", code: "Code",
                     link: "Link", embed: "Embed", swatch: "Color", shape: "Shape", column: "Group" };
    const menu = document.getElementById("board-ctx-menu");
    menu.innerHTML = `<div class="ctx-menu-label">Add here</div>` +
        types.map(t => `<button class="ctx-menu-item" data-type="${t}">${labels[t]}</button>`).join("");
    menu.querySelectorAll("[data-type]").forEach(btn => {
        btn.addEventListener("click", () => {
            _hideCtxMenu();
            const type = btn.dataset.type;
            if      (type === "link")  { _pendingDropX = _ctxCanvasX; _pendingDropY = _ctxCanvasY; _openLinkForm(); }
            else if (type === "image") { _pendingDropX = _ctxCanvasX; _pendingDropY = _ctxCanvasY; _openImageForm(); }
            else if (type === "embed") { _pendingDropX = _ctxCanvasX; _pendingDropY = _ctxCanvasY; _openEmbedForm(); }
            else                       { _addCard(type, _ctxCanvasX, _ctxCanvasY); }
        });
    });
    _positionCtxMenu(menu, screenX, screenY);
}

function _showCardCtxMenu(id, screenX, screenY) {
    const menu     = document.getElementById("board-ctx-menu");
    const cardData = _cardData.get(id);
    const isShape  = cardData?.type === "shape";
    const inGroup  = !!cardData?.columnId;
    menu.innerHTML = `
        ${inGroup ? `<button class="ctx-menu-item" data-action="eject">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            Remove from Group
        </button>
        <div class="ctx-menu-sep"></div>` : ""}
        <button class="ctx-menu-item" data-action="dup">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Duplicate
        </button>
        <button class="ctx-menu-item" data-action="color">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 0 20 5 5 0 0 0 0-10 5 5 0 0 1 0-10z"/></svg>
            Change Color
        </button>
        ${isShape ? `<button class="ctx-menu-item" data-action="shape">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><polyline points="21 15 16 10 5 21"/></svg>
            Change Shape
        </button>` : ""}
        <div class="ctx-menu-sep"></div>
        <button class="ctx-menu-item ctx-menu-item--danger" data-action="del">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            Delete
        </button>`;
    menu.querySelector("[data-action='eject']")?.addEventListener("click", () => {
        _hideCtxMenu();
        _ejectFromColumn(id, cardData.columnId);
    });
    menu.querySelector("[data-action='dup']").addEventListener("click", () => {
        _hideCtxMenu();
        _duplicateCard(id, _cardData.get(id));
    });
    menu.querySelector("[data-action='color']").addEventListener("click", () => {
        _hideCtxMenu();
        _ctxMenuId = id;
        const cardEl = document.querySelector(`.board-card[data-id="${id}"]`);
        const rect   = cardEl?.getBoundingClientRect();
        const picker = document.getElementById("board-color-picker");
        if (rect) {
            picker.style.top  = (rect.bottom + 6) + "px";
            picker.style.left = rect.left + "px";
        }
        picker.classList.remove("hidden");
    });
    menu.querySelector("[data-action='shape']")?.addEventListener("click", () => {
        _hideCtxMenu();
        _showShapePicker(id, screenX, screenY);
    });
    menu.querySelector("[data-action='del']").addEventListener("click", () => {
        _hideCtxMenu();
        _deleteCard(id);
    });
    _positionCtxMenu(menu, screenX, screenY);
}

function _positionCtxMenu(menu, x, y) {
    menu.classList.remove("hidden");
    requestAnimationFrame(() => {
        const mw = menu.offsetWidth  || 170;
        const mh = menu.offsetHeight || 200;
        menu.style.left = Math.max(4, Math.min(x, window.innerWidth  - mw - 8)) + "px";
        menu.style.top  = Math.max(4, Math.min(y, window.innerHeight - mh - 8)) + "px";
    });
}

function _hideCtxMenu() {
    document.getElementById("board-ctx-menu")?.classList.add("hidden");
    document.getElementById("board-color-picker")?.classList.add("hidden");
    document.getElementById("board-shape-picker")?.classList.add("hidden");
}

/* ────────────────────────────────────────────── drag ── */

function _makeDraggable(el, id) {
    el.addEventListener("mousedown", (e) => {
        if (e.target.closest(".board-card-del") ||
            e.target.closest(".board-card-edit") ||
            e.target.closest(".board-card-resize") ||
            e.target.closest(".board-card-textarea") ||
            e.target.closest(".board-card-text") ||
            e.target.closest(".board-column-title") ||
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

        const isColumn = el.classList.contains("board-card--column");

        const onMove = (ev) => {
            moved = true;
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            starts.forEach(g => {
                g.el.style.left = (g.left + dx) + "px";
                g.el.style.top  = (g.top  + dy) + "px";
            });
            _renderAllArrows();
            // Highlight column drop target (not for columns themselves)
            if (!isColumn) {
                const allUnder  = document.elementsFromPoint(ev.clientX, ev.clientY);
                const hoverBody = allUnder.find(e => e.classList.contains("board-column-body"));
                document.querySelectorAll(".board-column-body.col-drop-active")
                    .forEach(b => b.classList.remove("col-drop-active"));
                if (hoverBody) hoverBody.classList.add("col-drop-active");
            }
        };
        const onUp = (ev) => {
            group.forEach(c => c.classList.remove("dragging"));
            document.querySelectorAll(".board-column-body.col-drop-active")
                .forEach(b => b.classList.remove("col-drop-active"));
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup",   onUp);
            if (!moved) return;
            _justDragged = true; // suppress the click that fires right after mouseup

            // Snap single card into a column if released over its body
            if (!isColumn && starts.length === 1) {
                const allUnder  = document.elementsFromPoint(ev.clientX, ev.clientY);
                const hoverBody = allUnder.find(e => e.classList.contains("board-column-body"));
                const hoverCol  = hoverBody?.closest(".board-card");
                if (hoverCol && hoverCol.dataset.id !== id) {
                    updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
                        { columnId: hoverCol.dataset.id }).catch(console.error);
                    return;
                }
            }

            starts.forEach(g => {
                updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", g.id),
                    { x: parseInt(g.el.style.left), y: parseInt(g.el.style.top) })
                    .catch(console.error);
            });
            _renderAllArrows();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
    });
}

/* ─────────────────────────────── eject card from column ── */

async function _ejectFromColumn(id, colId) {
    const colEl = document.querySelector(`.board-card[data-id="${colId}"]`);
    const cx = parseInt(colEl?.style.left || "60") + (colEl?.offsetWidth || 260) + 20;
    const cy = parseInt(colEl?.style.top  || "60");
    await updateDoc(doc(db, "users", _uid, "projects", _pid, "board_items", id),
        { columnId: deleteField(), x: cx, y: cy }).catch(console.error);
}

/* ─────────────────────────────── image picker (direct) ── */

function _openImagePicker(dropX, dropY) {
    _pickerSource = "project";
    _openMediaPicker((item) => {
        if (!_pid || !_uid) return;
        const url   = item.imageUrl || item.thumbUrl || item.url || "";
        const label = item.name || "";
        addDoc(refs.boardItems(db, _uid, _pid), {
            type: "image", url, label,
            x: Math.round(dropX ?? 60),
            y: Math.round(dropY ?? 60),
            w: 240, h: 180,
            createdAt: serverTimestamp()
        }).catch(console.error);
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
    if (isMiddle || (e.button === 0 && _spaceDown)) {
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
        if (_selectedArrowId) {
            _selectedArrowId = null;
            _renderAllArrows();
        }
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
let _spaceDown = false;
document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.target.matches("input,textarea,[contenteditable]")) {
        e.preventDefault();
        _spaceDown = true;
        document.getElementById("board-canvas")?.classList.add("canvas-pan-mode");
    }
});
document.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
        _spaceDown = false;
        document.getElementById("board-canvas")?.classList.remove("canvas-pan-mode");
    }
});

/* ────────────────────────────────────────────── media picker ── */

let _pickerSource = "links";
let _pickerItems  = { project: [], links: [], gallery: [] };

async function _openMediaPicker(cb) {
    _mediaCb = cb;
    _pickerItems = { project: [], links: [], gallery: [] };

    const listEl   = document.getElementById("board-media-picker-list");
    const searchEl = document.getElementById("board-media-search");
    listEl.innerHTML = `<div class="bmp-loading">Loading…</div>`;
    searchEl.value = "";
    openModal("modal-board-media");

    // Sync active tab UI
    document.querySelectorAll("#board-media-tabs .bmp-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.source === _pickerSource));

    try {
        // Project media lives in users/{uid}/links filtered by categoryId
        const catId = currentProject?.sourceCategoryId || _pid;
        const [projectSnap, linksSnap, gallerySnap] = await Promise.all([
            (catId && _uid)
                ? getDocs(query(refs.links(db, _uid), where("categoryId", "==", catId))).catch(() => ({ docs: [] }))
                : Promise.resolve({ docs: [] }),
            getDocs(query(refs.links(db, _uid), orderBy("createdAt"))).catch(() => ({ docs: [] })),
            getDocs(query(refs.galleryLinks(db, _uid), orderBy("createdAt"))).catch(() => ({ docs: [] })),
        ]);
        _pickerItems.project = projectSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        _pickerItems.links   = linksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        _pickerItems.gallery = gallerySnap.docs.map(d => ({ id: d.id, ...d.data() }));
        _filterMediaPicker();
    } catch (err) {
        console.error(err);
        listEl.innerHTML = `<div class="bmp-loading">Failed to load.</div>`;
    }
}

function _renderMediaPicker(items) {
    const listEl = document.getElementById("board-media-picker-list");
    if (!items.length) {
        listEl.innerHTML = `<div class="bmp-loading">Nothing found here.</div>`;
        return;
    }
    listEl.innerHTML = "";
    items.forEach(item => {
        const btn     = document.createElement("button");
        btn.type      = "button";
        btn.className = "bmp-item";
        const thumb   = item.imageUrl?.trim() || item.thumbUrl?.trim() || item.avatarUrl?.trim() || "";
        const favicon = _getFavicon(item.url || "");
        const screenshot = item.url ? _getScreenshot(item.url) : "";
        const pretty  = item.url ? _prettyUrl(item.url) : "";
        // Use explicit thumb first, then screenshot as fallback, then favicon
        const thumbSrc = thumb || screenshot;
        btn.innerHTML = `
            <div class="bmp-thumb">
                ${thumbSrc
                    ? `<img src="${escHtml(thumbSrc)}" alt="" loading="lazy"
                           onerror="this.src='${escHtml(favicon)}';this.className='bmp-favicon'">`
                    : `<img src="${escHtml(favicon)}" alt="" class="bmp-favicon">`}
            </div>
            <div class="bmp-info">
                <div class="bmp-name">${escHtml(item.name || pretty || "")}</div>
                ${pretty ? `<div class="bmp-url">${escHtml(pretty)}</div>` : ""}
            </div>`;
        btn.addEventListener("click", () => {
            if (_mediaCb) _mediaCb(item);
            closeModal("modal-board-media");
        });
        listEl.appendChild(btn);
    });
}

function _filterMediaPicker() {
    const q      = (document.getElementById("board-media-search")?.value || "").toLowerCase();
    const items  = _pickerItems[_pickerSource] || [];
    const filtered = q
        ? items.filter(i => (i.name || "").toLowerCase().includes(q) || (i.url || "").toLowerCase().includes(q))
        : items;
    _renderMediaPicker(filtered);
}

/* ────────────────────────────────────────────── helpers ── */

function _getLuminance(hex) {
    if (!hex || hex.length < 7) return 0;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function _applyCardColor(el, color) {
    if (color) {
        el.style.setProperty("--card-bg", color);
        if (_getLuminance(color) > 0.35) {
            el.style.setProperty("--card-text", "#1a1a1a");
        } else {
            el.style.removeProperty("--card-text");
        }
    } else {
        el.style.removeProperty("--card-bg");
        el.style.removeProperty("--card-text");
    }
}

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

function _getExt(url) {
    try {
        const path = new URL(url).pathname;
        const ext  = path.split(".").pop()?.toUpperCase();
        return ext && ext.length <= 5 ? ext : "FILE";
    } catch { return "FILE"; }
}

/* ─────────────────────────────── arrows / connections ── */

function _getArrowCollection() {
    return collection(db, "users", _uid, "projects", _pid, "board_arrows");
}

function _subscribeArrows() {
    if (_arrowUnsub) _arrowUnsub();
    if (!_pid || !_uid) return;

    _arrowUnsub = onSnapshot(query(_getArrowCollection(), orderBy("createdAt")), (snap) => {
        _arrowData.clear();
        snap.forEach(d => _arrowData.set(d.id, d.data()));
        _renderAllArrows();
    });
}

/** Get the center of an anchor edge on a card in canvas coords */
function _anchorPoint(cardId, anchor) {
    const el = document.querySelector(`.board-card[data-id="${cardId}"]`);
    if (!el) return null;
    const x = parseInt(el.style.left) || 0;
    const y = parseInt(el.style.top)  || 0;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    switch (anchor) {
        case "top":    return { x: x + w / 2, y };
        case "bottom": return { x: x + w / 2, y: y + h };
        case "left":   return { x, y: y + h / 2 };
        case "right":  return { x: x + w, y: y + h / 2 };
        default:       return { x: x + w / 2, y: y + h / 2 };
    }
}

function _arrowPath(from, to) {
    if (!from || !to) return "";
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const cx1 = from.x + dx * 0.5;
    const cy1 = from.y;
    const cx2 = from.x + dx * 0.5;
    const cy2 = to.y;
    return `M ${from.x} ${from.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${to.x} ${to.y}`;
}

function _renderAllArrows() {
    const svg = document.getElementById("board-arrows-svg");
    if (!svg) return;

    // Remove existing rendered arrows (keep marker defs)
    svg.querySelectorAll(".board-arrow-path, .board-arrow-hit").forEach(e => e.remove());

    _arrowData.forEach((data, id) => {
        const from = _anchorPoint(data.fromId, data.fromAnchor);
        const to   = _anchorPoint(data.toId,   data.toAnchor);
        if (!from || !to) return;

        const d = _arrowPath(from, to);
        const isSelected = _selectedArrowId === id;

        // Visible path
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("class", "board-arrow-path" + (isSelected ? " selected" : ""));
        path.setAttribute("d", d);
        path.setAttribute("marker-end", "url(#board-arrow-head)");
        path.dataset.arrowId = id;
        svg.appendChild(path);

        // Wider invisible hit area
        const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
        hit.setAttribute("class", "board-arrow-hit");
        hit.setAttribute("d", d);
        hit.dataset.arrowId = id;
        hit.addEventListener("click", (e) => {
            e.stopPropagation();
            _selectArrow(id);
        });
        svg.appendChild(hit);
    });

    // Render temp drawing arrow
    if (_drawingArrow) {
        const from = _anchorPoint(_drawingArrow.fromId, _drawingArrow.fromAnchor);
        if (from) {
            const d = _arrowPath(from, { x: _drawingArrow.tempEndX, y: _drawingArrow.tempEndY });
            const temp = document.createElementNS("http://www.w3.org/2000/svg", "path");
            temp.setAttribute("class", "board-arrow-path board-arrow-temp");
            temp.setAttribute("d", d);
            temp.setAttribute("marker-end", "url(#board-arrow-head)");
            svg.appendChild(temp);
        }
    }
}

function _selectArrow(id) {
    _selectedArrowId = id;
    _renderAllArrows();
}

function _deselectArrow() {
    _selectedArrowId = null;
    _renderAllArrows();
}

/** Add 4 connection dots to a card element */
function _addConnDots(el, id) {
    ["top", "right", "bottom", "left"].forEach(anchor => {
        const dot = document.createElement("div");
        dot.className = `board-conn-dot board-conn-dot--${anchor}`;
        dot.title = "Draw connection";
        dot.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            _startArrowDraw(id, anchor, e);
        });
        el.appendChild(dot);
    });
}

function _startArrowDraw(fromId, fromAnchor, startEvent) {
    const canvas = document.getElementById("board-canvas");
    const rect   = canvas.getBoundingClientRect();

    const toCanvasCoords = (e) => ({
        x: (e.clientX - rect.left - _panX),
        y: (e.clientY - rect.top  - _panY),
    });

    const start = toCanvasCoords(startEvent);
    _drawingArrow = {
        fromId,
        fromAnchor,
        tempEndX: start.x,
        tempEndY: start.y,
    };

    const onMove = (e) => {
        if (!_drawingArrow) return;
        const pt = toCanvasCoords(e);
        _drawingArrow.tempEndX = pt.x;
        _drawingArrow.tempEndY = pt.y;
        _renderAllArrows();
    };

    const onUp = async (e) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        const drawing = _drawingArrow;
        _drawingArrow = null;

        // Hit-test: which card did we drop on?
        const targetCard = document.elementFromPoint(e.clientX, e.clientY)?.closest(".board-card");
        if (targetCard && targetCard.dataset.id && targetCard.dataset.id !== drawing.fromId) {
            const toId     = targetCard.dataset.id;
            const toAnchor = _closestAnchor(toId, e.clientX, e.clientY, rect);
            try {
                await addDoc(_getArrowCollection(), {
                    fromId: drawing.fromId,
                    fromAnchor: drawing.fromAnchor,
                    toId,
                    toAnchor,
                    createdAt: serverTimestamp(),
                });
            } catch (err) { console.error(err); }
        } else {
            _renderAllArrows();
        }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
}

function _closestAnchor(cardId, clientX, clientY, canvasRect) {
    const el = document.querySelector(`.board-card[data-id="${cardId}"]`);
    if (!el) return "top";
    const cx = parseInt(el.style.left) + el.offsetWidth  / 2 + _panX + canvasRect.left;
    const cy = parseInt(el.style.top)  + el.offsetHeight / 2 + _panY + canvasRect.top;
    const dx = clientX - cx;
    const dy = clientY - cy;
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
    return dy > 0 ? "bottom" : "top";
}

/* ────────────────────────────────────── paste from Milanote ── */

/* Dedicated import modal — intercepts clipboard before browser interprets it */
function _openImportModal() {
    const ta      = document.getElementById("board-import-capture");
    const preview = document.getElementById("board-import-preview");
    const btn     = document.getElementById("btn-board-import-confirm");
    ta.value      = "";
    preview.style.display = "none";
    btn.disabled  = true;
    btn.onclick   = null;
    openModal("modal-board-import");
    setTimeout(() => ta.focus(), 80);
}

async function _onImportCapturePaste(e) {
    e.preventDefault(); // stop text landing in textarea

    const cd    = e.clipboardData;
    const ta      = document.getElementById("board-import-capture");
    const preview = document.getElementById("board-import-preview");
    const btn     = document.getElementById("btn-board-import-confirm");

    // Log all available MIME types to console for debugging
    const types = Array.from(cd.types);
    console.group("Milanote clipboard MIME types");
    types.forEach(t => {
        try { console.log(t + ":\n", cd.getData(t)); } catch { console.log(t, "(binary)"); }
    });
    console.groupEnd();

    let cards = [];

    // 1. Milanote JSON
    const milanoteRaw = cd.getData("application/x-milanote-clipboard");
    if (milanoteRaw) {
        try {
            const parsed = JSON.parse(milanoteRaw);
            const items  = Array.isArray(parsed) ? parsed : (parsed.items || parsed.elements || parsed.nodes || []);
            cards = items.map(it => _milanoteItemToCard(it, 0, 0)).filter(Boolean);
            ta.value = "Milanote JSON detected ✓\n\n" + JSON.stringify(JSON.parse(milanoteRaw), null, 2);
        } catch (err) {
            ta.value = "JSON parse error: " + err.message;
        }
    }

    // 2. HTML clipboard
    if (!cards.length) {
        const html = cd.getData("text/html");
        if (html) {
            cards = _parseHtmlPaste(html);
            ta.value = "HTML clipboard detected ✓\n\n" + html;
        }
    }

    // 3. Plain text fallback
    if (!cards.length) {
        const text = cd.getData("text/plain").trim();
        if (text) {
            cards = _inferCardsFromText(text);
            ta.value = "Plain text detected:\n\n" + text;
        }
    }

    if (!cards.length) {
        preview.style.display = "block";
        preview.textContent   = "Nothing recognised in clipboard.";
        btn.disabled = true;
        return;
    }

    const summary = _summariseCards(cards);
    preview.style.display = "block";
    preview.innerHTML = `<strong>${cards.length} item${cards.length !== 1 ? "s" : ""} ready to import:</strong> ${escHtml(summary)}`;
    btn.disabled = false;
    btn.onclick  = async () => {
        closeModal("modal-board-import");
        const canvas = document.getElementById("board-canvas");
        const rect   = canvas.getBoundingClientRect();
        const cx     = rect.width  / 2 - _panX;
        const cy     = rect.height / 3 - _panY;
        const n = await _placeCards(cards, cx, cy);
        toast(n > 1 ? `${n} items imported from Milanote` : "Imported from Milanote", "info");
    };
}

function _summariseCards(cards) {
    const counts = {};
    cards.forEach(c => { counts[c.type] = (counts[c.type] || 0) + 1; });
    return Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(", ");
}

async function _onBoardPaste(e) {
    if (!document.getElementById("section-board")?.classList.contains("active")) return;
    if (e.target.matches("input, textarea, [contenteditable]")) return;
    if (!_canEdit) { toast("View-only access", "info"); return; }

    const cd = e.clipboardData;
    if (!cd) return;

    // 1. Milanote proprietary JSON format
    const milanoteRaw = cd.getData("application/x-milanote-clipboard");
    if (milanoteRaw) {
        e.preventDefault();
        try {
            const parsed = JSON.parse(milanoteRaw);
            const items  = Array.isArray(parsed)
                ? parsed
                : (parsed.items || parsed.elements || parsed.nodes || []);
            if (items.length) { await _pasteMilanoteItems(items); return; }
        } catch { /* fall through */ }
    }

    // 2. Image blob (screenshot pasted directly)
    for (const item of Array.from(cd.items)) {
        if (item.type.startsWith("image/")) {
            e.preventDefault();
            const file = item.getAsFile();
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
                const canvas = document.getElementById("board-canvas");
                const rect   = canvas.getBoundingClientRect();
                const cx     = rect.width  / 2 - _panX;
                const cy     = rect.height / 3 - _panY;
                await addDoc(refs.boardItems(db, _uid, _pid), {
                    type: "image", url: reader.result, label: file.name || "",
                    x: Math.round(cx - 120), y: Math.round(cy - 90),
                    w: 240, h: 180, createdAt: serverTimestamp()
                }).catch(console.error);
                toast("Image pasted", "info");
            };
            reader.readAsDataURL(file);
            return;
        }
    }

    const canvas = document.getElementById("board-canvas");
    const rect   = canvas.getBoundingClientRect();
    const cx     = rect.width  / 2 - _panX;
    const cy     = rect.height / 3 - _panY;

    // 3. HTML clipboard — preserves lists, links, headings from rich sources
    const html = cd.getData("text/html");
    if (html) {
        const htmlCards = _parseHtmlPaste(html);
        if (htmlCards.length) {
            e.preventDefault();
            const n = await _placeCards(htmlCards, cx, cy);
            toast(n > 1 ? `${n} items pasted` : "Pasted", "info");
            return;
        }
    }

    // 4. Plain text — infer card types from content patterns
    const text = cd.getData("text/plain").trim();
    if (!text) return;
    e.preventDefault();

    const cards = _inferCardsFromText(text);
    if (!cards.length) return;
    const n = await _placeCards(cards, cx, cy);
    toast(n > 1 ? `${n} items pasted` : "Pasted", "info");
}

async function _pasteMilanoteItems(items) {
    if (!items.length || !_pid || !_uid) return;
    const canvas = document.getElementById("board-canvas");
    const rect   = canvas.getBoundingClientRect();
    const cx     = rect.width  / 2;
    const cy     = rect.height / 3;

    // Centre the pasted group on the visible canvas area
    const xs = items.map(it => it.x ?? it.position?.x ?? 0).filter(n => Number.isFinite(n));
    const ys = items.map(it => it.y ?? it.position?.y ?? 0).filter(n => Number.isFinite(n));
    const minX    = xs.length ? Math.min(...xs) : 0;
    const minY    = ys.length ? Math.min(...ys) : 0;
    const offsetX = cx - _panX - minX;
    const offsetY = cy - _panY - minY;

    let count = 0;
    await Promise.all(items.map(item => {
        const mapped = _milanoteItemToCard(item, offsetX, offsetY);
        if (!mapped) return null;
        count++;
        return addDoc(refs.boardItems(db, _uid, _pid), {
            ...mapped, createdAt: serverTimestamp()
        }).catch(console.error);
    }));

    toast(count > 1 ? `${count} items pasted from Milanote` : "Pasted from Milanote", "info");
}

function _milanoteItemToCard(item, offsetX, offsetY) {
    const rawType = (item._type || item.type || item.kind || "note").toString().toLowerCase();
    const x       = Math.round((item.x ?? item.position?.x ?? 0) + offsetX);
    const y       = Math.round((item.y ?? item.position?.y ?? 0) + offsetY);
    const w       = item.width  || item.w || undefined;
    const h       = item.height || item.h || undefined;
    const content = item.content || item.text || item.title || item.body || "";
    const url     = item.url || item.link || item.src || item.href || "";
    const color   = item.backgroundColor || item.noteColor || item.color || undefined;

    const base = { x, y };
    if (w) base.w = w;
    if (h) base.h = h;
    if (color && /^#[0-9A-Fa-f]{3,8}$/.test(color)) base.color = color;

    if (rawType === "note" || rawType === "card" || rawType === "text" || rawType === "sticky") {
        return { ...base, type: "note", content };
    }
    if (rawType === "image" || rawType === "photo") {
        return { ...base, type: "image", url, label: content };
    }
    if (rawType === "link" || rawType === "bookmark" || rawType === "url" || rawType === "weblink") {
        return { ...base, type: "link", url, label: content };
    }
    if (rawType === "label" || rawType === "heading" || rawType === "title") {
        return { ...base, type: "heading", content };
    }
    if (rawType === "checklist" || rawType === "todo" || rawType === "task" || rawType === "list") {
        const rawItems = item.items || item.todos || item.tasks || [];
        const todos = Array.isArray(rawItems)
            ? rawItems.map(t => typeof t === "string"
                ? { text: t, done: false }
                : { text: t.text || t.content || t.label || "", done: !!(t.checked || t.done) })
            : [];
        return { ...base, type: "todo", content: content || "Checklist", todos };
    }
    if (rawType === "file" || rawType === "attachment") {
        return { ...base, type: "file", url, label: content };
    }
    if (rawType === "embed" || rawType === "video" || rawType === "youtube" || rawType === "iframe") {
        return { ...base, type: "embed", url, label: content, w: w || 320, h: h || 200 };
    }
    if (rawType === "column" || rawType === "group" || rawType === "container") {
        return { ...base, type: "column", content: content || "Group", w: w || 240, h: h || 240 };
    }
    // Unknown type — fall back to note if there's any text/url
    if (content || url) {
        return { ...base, type: "note", content: content || url };
    }
    return null;
}

/* ── Infer card types from plain text ── */

function _inferCardsFromText(text) {
    const URL_RE      = /^https?:\/\/\S+$/i;
    // Common checkbox / bullet prefixes used by many tools
    const CHECKBOX_RE = /^(?:\[[ xX✓✗]\]|☐|☑|☒|[-*•→▸]\s)\s*/;

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];

    const cards = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // URL line → link card
        if (URL_RE.test(line)) {
            cards.push({ type: "link", url: line, label: "" });
            i++;
            continue;
        }

        // Checkbox / bullet item → collect consecutive run into one todo card
        if (CHECKBOX_RE.test(line)) {
            // If the card just before this was a short plain note, use it as the checklist title
            let title = "Checklist";
            if (cards.length) {
                const last = cards[cards.length - 1];
                if (last.type === "note" && last.content.length <= 60) {
                    title = cards.pop().content;
                }
            }
            const todos = [];
            while (i < lines.length && CHECKBOX_RE.test(lines[i])) {
                const m    = lines[i].match(CHECKBOX_RE);
                const raw  = lines[i].slice(m[0].length).trim();
                const done = /\[[xX✓]\]|☑|☒/.test(m[0]);
                if (raw) todos.push({ text: raw, done });
                i++;
            }
            if (todos.length) cards.push({ type: "todo", content: title, todos });
            continue;
        }

        // Everything else → note
        cards.push({ type: "note", content: line });
        i++;
    }

    return cards;
}

/* ── Parse HTML clipboard into card objects ── */

function _parseHtmlPaste(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, "text/html"); }
    catch { return []; }

    const URL_RE = /^https?:\/\/\S+$/i;
    const cards  = [];
    const textOf = el => el.textContent?.trim() || "";

    const walk = (root) => {
        for (const el of Array.from(root.children)) {
            const tag = el.tagName.toUpperCase();

            // Lists → todo card (with checkboxes) or individual notes
            if (tag === "UL" || tag === "OL") {
                const items = [...el.querySelectorAll(":scope > li")];
                if (!items.length) { walk(el); continue; }
                const hasCb = items.some(li => li.querySelector("input[type=checkbox]"));
                // Preceding heading sibling becomes the todo title
                let title = "Checklist";
                const prev = el.previousElementSibling;
                if (prev && /^H[1-6]$/.test(prev.tagName)) title = textOf(prev) || "Checklist";
                if (hasCb) {
                    const todos = items.map(li => {
                        const cb   = li.querySelector("input[type=checkbox]");
                        const text = textOf(li).replace(/^\s*/, "").trim();
                        return { text, done: cb?.checked || false };
                    }).filter(t => t.text);
                    if (todos.length) cards.push({ type: "todo", content: title, todos });
                } else {
                    items.forEach(li => {
                        const t = textOf(li);
                        if (!t) return;
                        if (URL_RE.test(t)) cards.push({ type: "link", url: t, label: "" });
                        else cards.push({ type: "note", content: t });
                    });
                }
                continue;
            }

            // Headings → heading card
            if (/^H[1-6]$/.test(tag)) {
                const t = textOf(el);
                if (t) cards.push({ type: "heading", content: t });
                continue;
            }

            // Anchor → link card
            if (tag === "A") {
                const href  = el.getAttribute("href") || "";
                const label = textOf(el);
                if (href && /^https?:\/\//i.test(href)) cards.push({ type: "link", url: href, label });
                continue;
            }

            // Image → image card
            if (tag === "IMG") {
                const src = el.getAttribute("src") || "";
                if (/^https?:\/\//i.test(src))
                    cards.push({ type: "image", url: src, label: el.getAttribute("alt") || "" });
                continue;
            }

            // Block elements — recurse if they have rich children, else extract text
            if (tag === "P" || tag === "DIV" || tag === "SECTION" || tag === "ARTICLE") {
                const richChildren = el.querySelectorAll("a[href], img, ul, ol, h1, h2, h3, h4, h5, h6");
                if (richChildren.length) { walk(el); continue; }
                const t = textOf(el);
                if (!t) continue;
                if (URL_RE.test(t)) cards.push({ type: "link", url: t, label: "" });
                else cards.push({ type: "note", content: t });
                continue;
            }

            // Recurse into any other container
            if (el.children.length) walk(el);
        }
    };

    walk(doc.body);
    return cards;
}

/* ── Layout card objects on the canvas in a grid ── */

async function _placeCards(cards, cx, cy) {
    if (!cards.length || !_pid || !_uid) return 0;
    const CARD_W = 220;
    const CARD_H = 90;
    const GAP    = 16;
    const COLS   = Math.min(cards.length, Math.max(1, Math.ceil(Math.sqrt(cards.length * 1.5))));
    const totalW = COLS * (CARD_W + GAP) - GAP;
    const startX = cx - totalW / 2;
    const startY = cy - 60;

    await Promise.all(cards.map((card, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x   = Math.round(startX + col * (CARD_W + GAP));
        const y   = Math.round(startY + row * (CARD_H + GAP));
        return addDoc(refs.boardItems(db, _uid, _pid), {
            ...card, x, y, createdAt: serverTimestamp()
        }).catch(console.error);
    }));
    return cards.length;
}
