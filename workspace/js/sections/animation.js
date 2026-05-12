/**
 * sections/animation.js — Animation Studio.
 *
 * Scene Library:  Multiple named scenes (animation clips), shown as draggable
 *                 cards on a canvas. Drag cards to position, click Connect to
 *                 link scenes and define playback order.
 *
 * Frame Editor:   Drawing canvas + frame timeline for the selected scene.
 *
 * Firestore:
 *   users/{uid}/projects/{pid}/anim_clips/{clipId}
 *     - name:        string
 *     - x, y:        number  (graph card position)
 *     - connections: string[]  (IDs of clips that follow this one)
 *     - thumbnail:   string | null  (frame-0 preview data URL)
 *     - order:       number
 *     - createdAt:   serverTimestamp
 *
 *   users/{uid}/projects/{pid}/anim_clips/{clipId}/frames/{frameId}
 *     - order:      number
 *     - strokes:    Array  (stroke records — lossless drawing data)
 *     - canvasData: removed (thumbnails generated client-side from strokes)
 *     - cutouts:    Array<{id, url, x, y, w, h, rotation}>
 *     - duration:   number  (ms per frame)
 *     - updatedAt:  serverTimestamp
 */

import {
    onSnapshot, addDoc, updateDoc, deleteDoc,
    doc, query, orderBy, serverTimestamp, getDocs, collection, where, writeBatch
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }            from "../app.js";
import { currentProjectId,
         currentProject, getDataUid, canCurrentUserEdit } from "../projects.js";
import { escHtml, toast, confirm,
         openModal, closeModal }  from "../ui.js";

/* Canvas resolution */
const CANVAS_W = 960;
const CANVAS_H = 540;

/* Scene card dimensions (graph layout) */
const CARD_W = 160;
const CARD_H = 100;

/* ================================================================ STATE == */

let _pid     = null;
let _uid     = null;
let _canEdit = true;

/* Scene library */
let _clips     = [];
let _clipUnsub = null;

/* Frame editor */
let _curClipId   = null;
let _frames      = [];
let _curFrameIdx = 0;
let _frameUnsub  = null;

/* Drawing */
let _tool      = "draw";
let _color     = "#ffffff";
let _brushSize = 4;
let _fps       = 12;
let _playing   = false;
let _playTimer = null;
let _dirty     = false;
let _saveTimer = null;
let _isDrawing = false;
let _mediaLinks = [];

/* Interaction */
let _connectingFrom = null;
let _dragCutout     = null;
let _resizeCutout   = null;

/* Stroke recording (lossless drawing — no PNG round-trip degradation) */
let _strokes   = [];   // all strokes for the currently loaded frame
let _curStroke = null; // stroke being drawn right now

/* Client-side thumbnail cache: frameId → 160×90 PNG data URL */
const _thumbCache = new Map();

/* Sequence playback */
let _seqPlaying  = false;
let _seqQueue    = [];   // [{id, name, frames[]}]
let _seqClipIdx  = 0;
let _seqFrameIdx = 0;
let _seqTimer    = null;
let _seqOverlay  = null;
let _seqCanvas   = null;
let _seqCtx      = null;

/* DOM refs */
let _libraryEl  = null;
let _editorEl   = null;
let _svgEl      = null;
let _cardsEl    = null;
let _connDelsEl = null;
let _drawCanvas = null;
let _drawCtx    = null;
let _onionCanvas = null;
let _onionCtx   = null;
let _stage      = null;
let _cutoutLayer = null;

let _init = false;

/* ================================================================= INIT == */

export function init() {
    if (_init) return;
    _init = true;

    _libraryEl   = document.getElementById("anim-library");
    _editorEl    = document.getElementById("anim-editor");
    _svgEl       = document.getElementById("anim-connections");
    _cardsEl     = document.getElementById("anim-scene-cards");
    _connDelsEl  = document.getElementById("anim-conn-dels");
    _drawCanvas  = document.getElementById("anim-draw-canvas");
    _drawCtx     = _drawCanvas.getContext("2d");
    _onionCanvas = document.getElementById("anim-onion-canvas");
    _onionCtx    = _onionCanvas.getContext("2d");
    _stage       = document.getElementById("anim-stage");
    _cutoutLayer = document.getElementById("anim-cutout-layer");

    _drawCanvas.width  = CANVAS_W;
    _drawCanvas.height = CANVAS_H;
    _onionCanvas.width = CANVAS_W;
    _onionCanvas.height = CANVAS_H;

    _updateCtxStyle();
    _setupDrawing();
    _setupToolbar();
    _setupPlayback();
    _setupTimeline();
    _setupCutoutModal();
    _setupKeyboard();

    /* Seed from the already-selected project (init is lazy — project was
       likely selected before this section was ever opened). */
    if (currentProjectId) {
        _pid     = currentProjectId;
        _uid     = getDataUid();
        _canEdit = canCurrentUserEdit();
        _subscribeClips();
    }

    window.addEventListener("projectSelected", ({ detail }) => {
        _pid     = detail.id;
        _uid     = getDataUid();
        _canEdit = detail.canEdit ?? true;
        _stopSequence();
        _stopPlayback();
        _backToLibrary(true);
        _subscribeClips();
    });

    window.addEventListener("sectionActivated", ({ detail }) => {
        if (detail.section === "animation" && currentProjectId !== _pid) {
            _pid     = currentProjectId;
            _uid     = getDataUid();
            _canEdit = canCurrentUserEdit();
            _stopSequence();
            _stopPlayback();
            _backToLibrary(true);
            _subscribeClips();
        }
    });
}

/* ======================================================= FIRESTORE PATHS == */

function _clipsRef() {
    return collection(db, "users", _uid, "projects", _pid, "anim_clips");
}
function _clipDoc(clipId) {
    return doc(db, "users", _uid, "projects", _pid, "anim_clips", clipId);
}
function _framesRef(clipId) {
    return collection(db, "users", _uid, "projects", _pid, "anim_clips", clipId, "frames");
}
function _frameDoc(clipId, frameId) {
    return doc(db, "users", _uid, "projects", _pid, "anim_clips", clipId, "frames", frameId);
}

/* ======================================================= SCENE LIBRARY == */

function _subscribeClips() {
    if (_clipUnsub) _clipUnsub();
    if (!_pid || !_uid) return;
    const q = query(_clipsRef(), orderBy("order", "asc"));
    _clipUnsub = onSnapshot(q, (snap) => {
        _clips = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _renderLibrary();
    }, (err) => console.error("[animation] clips:", err));
}

function _showLibrary() {
    _libraryEl.style.display = "";
    _editorEl.style.display  = "none";
}

function _showEditor() {
    _libraryEl.style.display = "none";
    _editorEl.style.display  = "";
}

function _backToLibrary(silent) {
    if (_frameUnsub) { _frameUnsub(); _frameUnsub = null; }
    _stopPlayback();
    clearTimeout(_saveTimer);
    if (!silent) _saveCurrentFrame(true);
    _curClipId   = null;
    _frames      = [];
    _strokes     = []; _curStroke = null;
    _dirty       = false;
    _isDrawing   = false;
    _thumbCache.clear();
    _connectingFrom = null;
    _clearCanvas(); _clearOnion(); _clearCutouts();
    _showLibrary();
}

function _renderLibrary() {
    if (!_cardsEl) return;

    const emptyEl = document.getElementById("anim-lib-empty");
    if (emptyEl) emptyEl.style.display = _clips.length === 0 ? "" : "none";

    _cardsEl.innerHTML = "";

    /* Which clips are part of any connection (show dimmed if isolated) */
    const hasOutgoing = new Set(_clips.filter(c => (c.connections || []).length > 0).map(c => c.id));
    const hasIncoming = new Set(_clips.flatMap(c => c.connections || []));

    _clips.forEach(clip => {
        const card = document.createElement("div");
        card.className = "anim-scene-card";
        if (_connectingFrom === clip.id) card.classList.add("anim-card-connecting");
        if (_connectingFrom && _connectingFrom !== clip.id) card.classList.add("anim-card-connectable");
        if (!hasOutgoing.has(clip.id) && !hasIncoming.has(clip.id)) card.classList.add("anim-card-isolated");
        card.dataset.id = clip.id;
        card.style.left = (clip.x ?? 40) + "px";
        card.style.top  = (clip.y ?? 40) + "px";

        const thumb = clip.thumbnail
            ? `<img src="${escHtml(clip.thumbnail)}" class="anim-card-thumb" alt="">`
            : `<div class="anim-card-thumb anim-card-thumb-empty"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></div>`;

        card.innerHTML = `
            ${thumb}
            <div class="anim-card-footer">
                <span class="anim-card-name">${escHtml(clip.name || "Untitled")}</span>
                <div class="anim-card-actions">
                    <button class="anim-card-connect" title="Connect to another scene" tabindex="-1">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="18" cy="12" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M15 12H9"/></svg>
                    </button>
                    <button class="anim-card-del" title="Delete scene" tabindex="-1">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            </div>`;

        let _clickTimer = null;

        card.addEventListener("click", (e) => {
            if (e.target.closest(".anim-card-actions")) return;
            if (_connectingFrom) {
                if (_connectingFrom !== clip.id) _addConnection(_connectingFrom, clip.id);
                _cancelConnect();
                return;
            }
            /* Delay single-click open so dblclick can cancel it */
            clearTimeout(_clickTimer);
            _clickTimer = setTimeout(() => _openClip(clip.id), 220);
        });

        card.addEventListener("dblclick", (e) => {
            if (e.target.closest(".anim-card-actions")) return;
            clearTimeout(_clickTimer);
            _renameClip(clip.id, clip.name);
        });

        card.querySelector(".anim-card-connect").addEventListener("click", (e) => {
            e.stopPropagation();
            _connectingFrom === clip.id ? _cancelConnect() : _startConnect(clip.id);
        });

        card.querySelector(".anim-card-del").addEventListener("click", (e) => {
            e.stopPropagation();
            _deleteClip(clip.id);
        });

        _setupCardDrag(card, clip);
        _cardsEl.appendChild(card);
    });

    _renderConnections();
}

function _renderConnections() {
    if (!_svgEl || !_connDelsEl) return;
    _svgEl.innerHTML = "";
    _connDelsEl.innerHTML = "";

    /* Build play order so we can number arrows */
    let connSeq = 0;

    _clips.forEach(clip => {
        (clip.connections || []).forEach(targetId => {
            const target = _clips.find(c => c.id === targetId);
            if (!target) return;
            connSeq++;

            const x1 = (clip.x ?? 40) + CARD_W;
            const y1 = (clip.y ?? 40) + CARD_H / 2;
            const x2 = (target.x ?? 40);
            const y2 = (target.y ?? 40) + CARD_H / 2;
            const dx = Math.max(Math.abs(x2 - x1) * 0.5, 60);
            const cx1 = x1 + dx;
            const cx2 = x2 - dx;
            const d = `M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}`;

            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", d);
            path.setAttribute("class", "anim-conn-path");
            _svgEl.appendChild(path);

            /* Arrowhead */
            const angle = Math.atan2(y2 - (target.y ?? 40 + CARD_H / 2), x2 - cx2);
            const al = 10, aw = 5;
            const ax1 = x2 - al * Math.cos(angle) + aw * Math.sin(angle);
            const ay1 = y2 - al * Math.sin(angle) - aw * Math.cos(angle);
            const ax2 = x2 - al * Math.cos(angle) - aw * Math.sin(angle);
            const ay2 = y2 - al * Math.sin(angle) + aw * Math.cos(angle);
            const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
            arrow.setAttribute("points", `${x2},${y2} ${ax1},${ay1} ${ax2},${ay2}`);
            arrow.setAttribute("class", "anim-conn-arrow");
            _svgEl.appendChild(arrow);

            /* Order number label at midpoint */
            const midX = (x1 + cx1 + cx2 + x2) / 4;
            const midY = (y1 + y1   + y2  + y2) / 4;

            const badge = document.createElementNS("http://www.w3.org/2000/svg", "g");
            const bgCirc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            bgCirc.setAttribute("cx", midX); bgCirc.setAttribute("cy", midY); bgCirc.setAttribute("r", "9");
            bgCirc.setAttribute("class", "anim-conn-badge-bg");
            const numText = document.createElementNS("http://www.w3.org/2000/svg", "text");
            numText.setAttribute("x", midX); numText.setAttribute("y", midY + 1);
            numText.setAttribute("class", "anim-conn-badge-num");
            numText.textContent = connSeq;
            badge.appendChild(bgCirc); badge.appendChild(numText);
            _svgEl.appendChild(badge);

            /* Delete button */
            const delBtn = document.createElement("button");
            delBtn.className = "anim-conn-del-btn";
            delBtn.title = "Remove connection";
            delBtn.style.left = midX + "px";
            delBtn.style.top  = midY + "px";
            delBtn.textContent = "×";
            delBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                _removeConnection(clip.id, targetId);
            });
            _connDelsEl.appendChild(delBtn);
        });
    });
}

function _setupCardDrag(cardEl, clip) {
    let dragging = false;
    let startX, startY, origX, origY;

    cardEl.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".anim-card-actions") || e.target.closest(".anim-card-name")) return;
        if (_connectingFrom) return;
        startX = e.clientX; startY = e.clientY;
        origX = clip.x ?? 40; origY = clip.y ?? 40;
        dragging = false;
        cardEl.setPointerCapture(e.pointerId);
    });

    cardEl.addEventListener("pointermove", (e) => {
        if (!cardEl.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) dragging = true;
        if (!dragging) return;
        clip.x = Math.max(0, origX + dx);
        clip.y = Math.max(0, origY + dy);
        cardEl.style.left = clip.x + "px";
        cardEl.style.top  = clip.y + "px";
        _renderConnections();
        e.preventDefault();
    });

    cardEl.addEventListener("pointerup", async () => {
        if (!dragging) return;
        dragging = false;
        try {
            await updateDoc(_clipDoc(clip.id), { x: clip.x, y: clip.y });
        } catch (err) {
            console.error("[animation] card drag save:", err);
        }
    });
}

/* -- Connection wiring -- */

function _startConnect(clipId) {
    _connectingFrom = clipId;
    _renderLibrary();
    toast("Click another scene to connect  •  Escape to cancel", "info");
}

function _cancelConnect() {
    _connectingFrom = null;
    _renderLibrary();
}

async function _addConnection(fromId, toId) {
    const from = _clips.find(c => c.id === fromId);
    if (!from) return;
    const connections = [...new Set([...(from.connections || []), toId])];
    try {
        await updateDoc(_clipDoc(fromId), { connections });
    } catch (err) {
        toast("Failed to connect scenes", "error");
    }
}

async function _removeConnection(fromId, toId) {
    const from = _clips.find(c => c.id === fromId);
    if (!from) return;
    const connections = (from.connections || []).filter(id => id !== toId);
    try {
        await updateDoc(_clipDoc(fromId), { connections });
    } catch (err) {
        toast("Failed to remove connection", "error");
    }
}

/* -- Clip CRUD -- */

async function _addClip() {
    if (!_canEdit) { toast("View-only access", "info"); return; }
    if (!_pid) return;
    const count = _clips.length;
    const x = 40 + (count % 4) * (CARD_W + 40);
    const y = 40 + Math.floor(count / 4) * (CARD_H + 50);
    try {
        await addDoc(_clipsRef(), {
            name: `Scene ${count + 1}`,
            x, y,
            connections: [],
            thumbnail: null,
            order: count,
            createdAt: serverTimestamp(),
        });
    } catch (err) {
        toast("Failed to create scene", "error");
    }
}

async function _deleteClip(clipId) {
    if (!_canEdit) return;
    const clip = _clips.find(c => c.id === clipId);
    const ok = await confirm(`Delete "${clip?.name || "this scene"}"?`, "All frames will be permanently deleted.");
    if (!ok) return;
    try {
        const framesSnap = await getDocs(_framesRef(clipId));
        const batch = writeBatch(db);
        framesSnap.docs.forEach(d => batch.delete(d.ref));
        batch.delete(_clipDoc(clipId));
        await batch.commit();
        /* Remove dangling connections */
        const b2 = writeBatch(db);
        let hasDangling = false;
        _clips.forEach(c => {
            if ((c.connections || []).includes(clipId)) {
                hasDangling = true;
                b2.update(_clipDoc(c.id), { connections: (c.connections || []).filter(id => id !== clipId) });
            }
        });
        if (hasDangling) await b2.commit();
    } catch (err) {
        toast("Failed to delete scene", "error");
    }
}

async function _renameClip(clipId, currentName) {
    const name = prompt("Scene name:", currentName || "");
    if (name === null || !name.trim()) return;
    try {
        await updateDoc(_clipDoc(clipId), { name: name.trim() });
    } catch (err) {
        toast("Failed to rename", "error");
    }
}

function _openClip(clipId) {
    /* Cancel any pending auto-save from the previous clip */
    clearTimeout(_saveTimer);
    _dirty     = false;
    _isDrawing = false;
    _curStroke = null;

    _curClipId = clipId;
    const clip = _clips.find(c => c.id === clipId);
    const nameEl = document.getElementById("anim-clip-name");
    if (nameEl) nameEl.textContent = clip?.name || "Untitled";

    /* Clear canvas immediately so old scene doesn't bleed through */
    _strokes = []; _frames = []; _curFrameIdx = 0;
    _clearCanvas(); _clearOnion(); _clearCutouts();

    _showEditor();
    _subscribeFrames(clipId);
    _loadMediaLinks();
}

/* ======================================================= FRAME EDITOR == */

function _subscribeFrames(clipId) {
    if (_frameUnsub) _frameUnsub();
    if (!clipId || !_uid) return;
    const q = query(_framesRef(clipId), orderBy("order", "asc"));
    _frameUnsub = onSnapshot(q, (snap) => {
        /* Guard: ignore snapshots that belong to a clip we already left */
        if (_curClipId !== clipId) return;

        const prevId = _frames[_curFrameIdx]?.id ?? null;
        _frames = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        if (_frames.length === 0) {
            _curFrameIdx = 0;
            _strokes = []; _curStroke = null;
            _clearCanvas(); _clearOnion(); _clearCutouts();
            _renderTimeline(); _renderFrameInfo();
            _dirty = false;
            return;
        }

        const idx = _frames.findIndex(f => f.id === prevId);
        _curFrameIdx = idx >= 0 ? idx : Math.min(_curFrameIdx, _frames.length - 1);

        /* Skip reloading canvas only when the user is actively drawing right now;
           otherwise always reload to reflect the saved state cleanly. */
        if (_isDrawing) {
            _renderTimeline();
            _renderFrameInfo();
        } else {
            _loadFrame(_curFrameIdx);
        }
    }, (err) => console.error("[animation] frames:", err));
}

/* ======================================================= CANVAS == */

function _updateCtxStyle(pressure) {
    if (!_drawCtx) return;
    const p    = Math.max(0.15, pressure ?? 1.0);
    const base = _tool === "erase" ? _brushSize * 3 : _brushSize;
    _drawCtx.strokeStyle = _tool === "erase" ? "#000000" : _color;
    _drawCtx.fillStyle   = _tool === "erase" ? "#000000" : _color;
    _drawCtx.lineWidth   = base * p;
    _drawCtx.lineCap     = "round";
    _drawCtx.lineJoin    = "round";
    _drawCtx.globalCompositeOperation = _tool === "erase" ? "destination-out" : "source-over";
}

function _setupDrawing() {
    /* touch-action:none is set in CSS -- prevents scroll hijack on tablets */

    _drawCanvas.addEventListener("pointerdown", (e) => {
        if (!_canEdit || !_curClipId) return;
        _isDrawing = true;
        _drawCanvas.setPointerCapture(e.pointerId);
        const { x, y } = _getPos(e);
        const p = Math.max(0.15, e.pressure || 1.0);
        _curStroke = {
            t: _tool === "erase" ? "e" : "d",
            c: _color,
            w: _brushSize,
            pts: [Math.round(x), Math.round(y), Math.round(p * 100)]
        };
        _updateCtxStyle(e.pressure);
        /* Dot for taps */
        _drawCtx.beginPath();
        _drawCtx.arc(x, y, Math.max(0.5, _drawCtx.lineWidth / 2), 0, Math.PI * 2);
        _drawCtx.fill();
        _drawCtx.beginPath();
        _drawCtx.moveTo(x, y);
        e.preventDefault();
    });

    _drawCanvas.addEventListener("pointermove", (e) => {
        if (!_isDrawing || !_curStroke) return;
        /* Coalesced events = full Wacom sample rate, no skipped positions */
        const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        pts.forEach(ev => {
            const { x, y } = _getPos(ev);
            const p = Math.max(0.15, ev.pressure || 1.0);
            _curStroke.pts.push(Math.round(x), Math.round(y), Math.round(p * 100));
            _updateCtxStyle(ev.pressure);
            _drawCtx.lineTo(x, y);
            _drawCtx.stroke();
            _drawCtx.beginPath();
            _drawCtx.moveTo(x, y);
        });
        e.preventDefault();
    });

    function _finaliseStroke() {
        if (!_isDrawing) return;
        _isDrawing = false;
        if (_curStroke && _curStroke.pts.length) { _strokes.push(_curStroke); }
        _curStroke = null;
        _dirty = true;
        _scheduleSave();
    }

    _drawCanvas.addEventListener("pointerup", _finaliseStroke);
    _drawCanvas.addEventListener("pointercancel", _finaliseStroke);
    /* Do NOT stop on pointerleave -- setPointerCapture keeps events flowing
       even when the Wacom pen temporarily hovers above the sensor threshold. */
}

function _getPos(e) {
    const rect = _drawCanvas.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left) * (CANVAS_W / rect.width),
        y: (e.clientY - rect.top)  * (CANVAS_H / rect.height),
    };
}

/* Replay all strokes to a context (defaults to _drawCtx).
   pts is a flat array [x0,y0,p0, x1,y1,p1, ...] to avoid Firestore nested arrays. */
function _replayStrokes(strokes, ctx) {
    ctx = ctx || _drawCtx;
    if (!ctx || !strokes) return;
    for (const s of strokes) {
        if (!s.pts || s.pts.length < 3) continue;
        const baseW = s.t === "e" ? (s.w || 4) * 3 : (s.w || 4);
        ctx.save();
        ctx.globalCompositeOperation = s.t === "e" ? "destination-out" : "source-over";
        ctx.strokeStyle = s.t === "e" ? "#000" : (s.c || "#fff");
        ctx.fillStyle   = s.t === "e" ? "#000" : (s.c || "#fff");
        ctx.lineCap     = "round";
        ctx.lineJoin    = "round";
        const nPts = Math.floor(s.pts.length / 3);
        if (nPts === 1) {
            const p = Math.max(0.15, (s.pts[2] || 100) / 100);
            ctx.lineWidth = baseW * p;
            ctx.beginPath();
            ctx.arc(s.pts[0], s.pts[1], Math.max(0.5, ctx.lineWidth / 2), 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.beginPath();
            ctx.moveTo(s.pts[0], s.pts[1]);
            for (let i = 1; i < nPts; i++) {
                const p = Math.max(0.15, (s.pts[i * 3 + 2] || 100) / 100);
                ctx.lineWidth = baseW * p;
                ctx.lineTo(s.pts[i * 3], s.pts[i * 3 + 1]);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(s.pts[i * 3], s.pts[i * 3 + 1]);
            }
        }
        ctx.restore();
    }
    if (ctx === _drawCtx) _updateCtxStyle();
}

function _clearCanvas() { _drawCtx.clearRect(0, 0, CANVAS_W, CANVAS_H); }
function _clearOnion()  { _onionCtx.clearRect(0, 0, CANVAS_W, CANVAS_H); }

function _loadFrame(idx) {
    if (_frames.length === 0) {
        _strokes = []; _curStroke = null;
        _clearCanvas(); _clearOnion(); _clearCutouts(); return;
    }
    idx = Math.max(0, Math.min(idx, _frames.length - 1));
    _curFrameIdx = idx;
    const frame  = _frames[idx];

    /* Load strokes for lossless reconstruction */
    _strokes = frame.strokes ? [...frame.strokes] : [];
    _clearCanvas();
    if (_strokes.length) {
        _replayStrokes(_strokes);
    } else if (frame.canvasData) {
        /* Legacy fallback: frame has PNG but no strokes yet */
        const img = new Image();
        img.onload = () => {
            _drawCtx.globalCompositeOperation = "source-over";
            _drawCtx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
            _updateCtxStyle();
        };
        img.src = frame.canvasData;
    } else {
        _updateCtxStyle();
    }

    _clearOnion();
    if (idx > 0) {
        const prev = _frames[idx - 1];
        if (prev?.strokes?.length) {
            _onionCtx.globalAlpha = 0.25;
            _replayStrokes(prev.strokes, _onionCtx);
            _onionCtx.globalAlpha = 1.0;
        } else if (prev?.canvasData) {
            const ghost = new Image();
            ghost.onload = () => {
                _onionCtx.globalAlpha = 0.25;
                _onionCtx.drawImage(ghost, 0, 0, CANVAS_W, CANVAS_H);
                _onionCtx.globalAlpha = 1.0;
            };
            ghost.src = prev.canvasData;
        }
    }

    _clearCutouts();
    (frame.cutouts || []).forEach(c => _renderCutout(c));
    _renderTimeline();
    _renderFrameInfo();
    _dirty = false;
}

/* ======================================================= FRAME CRUD == */

async function _addFrame() {
    if (!_canEdit) { toast("View-only access", "info"); return; }
    if (!_curClipId) return;
    await _saveCurrentFrame();
    const order = _frames.length > 0 ? (_frames[_frames.length - 1].order ?? _frames.length) + 1 : 0;
    try {
        const ref = await addDoc(_framesRef(_curClipId), {
            order,
            strokes: [],
            cutouts: [],
            duration: Math.round(1000 / _fps),
            updatedAt: serverTimestamp(),
        });
        /* The snapshot fires before this continuation resumes, so _frames is
           already updated. Find the new frame by its ID instead of assuming
           index = _frames.length (which would be out of bounds). */
        const newIdx = _frames.findIndex(f => f.id === ref.id);
        _curFrameIdx = newIdx >= 0 ? newIdx : Math.max(0, _frames.length - 1);
        _loadFrame(_curFrameIdx);
    } catch (err) {
        toast("Failed to add frame", "error");
    }
}

async function _deleteCurrentFrame() {
    if (!_canEdit) { toast("View-only access", "info"); return; }
    if (_frames.length === 0) return;
    const frame = _frames[_curFrameIdx];
    if (!frame) return;
    const ok = await confirm(`Delete Frame ${_curFrameIdx + 1}?`, "This cannot be undone.");
    if (!ok) return;
    try {
        await deleteDoc(_frameDoc(_curClipId, frame.id));
        _thumbCache.delete(frame.id);
        if (_curFrameIdx > 0) _curFrameIdx--;
    } catch (err) {
        toast("Failed to delete frame", "error");
    }
}

async function _saveCurrentFrame(force = false) {
    if (!force && !_dirty) return;
    if (!_canEdit || !_frames.length || !_curClipId) { _dirty = false; return; }
    const frame = _frames[_curFrameIdx];
    if (!frame) { _dirty = false; return; }

    const strokes = [..._strokes];

    /* Invalidate cached thumbnail for this frame */
    _thumbCache.delete(frame.id);

    try {
        await updateDoc(_frameDoc(_curClipId, frame.id), { strokes, updatedAt: serverTimestamp() });
        /* Scene card thumbnail: only needed on clip doc for frame 0 */
        if (_curFrameIdx === 0) {
            const off = document.createElement("canvas");
            off.width = 240; off.height = 135;
            off.getContext("2d").drawImage(_drawCanvas, 0, 0, 240, 135);
            const thumbnail = off.toDataURL("image/jpeg", 0.7);
            await updateDoc(_clipDoc(_curClipId), { thumbnail });
        }
        _dirty = false;
    } catch (err) {
        console.error("[animation] save frame:", err);
    }
}

function _scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_saveCurrentFrame, 1500);
}

/* ======================================================= CUTOUTS == */

function _clearCutouts() { _cutoutLayer.innerHTML = ""; }

function _renderCutout(cutout) {
    const el = document.createElement("div");
    el.className = "anim-cutout";
    el.dataset.id = cutout.id;
    el.style.left      = ((cutout.x ?? 0)   / CANVAS_W * 100) + "%";
    el.style.top       = ((cutout.y ?? 0)   / CANVAS_H * 100) + "%";
    el.style.width     = ((cutout.w ?? 200) / CANVAS_W * 100) + "%";
    el.style.height    = ((cutout.h ?? 150) / CANVAS_H * 100) + "%";
    el.style.transform = `rotate(${cutout.rotation ?? 0}deg)`;

    const img = document.createElement("img");
    img.src = cutout.url; img.draggable = false;
    el.appendChild(img);

    const del = document.createElement("button");
    del.className = "anim-cutout-del"; del.title = "Remove cutout";
    del.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    del.addEventListener("click", async (e) => { e.stopPropagation(); await _removeCutout(cutout.id); });
    el.appendChild(del);

    const rz = document.createElement("div");
    rz.className = "anim-cutout-resize"; rz.title = "Resize";
    el.appendChild(rz);

    el.addEventListener("pointerdown", (e) => {
        if (e.target === rz || e.target === del) return;
        e.preventDefault();
        _dragCutout = { el, id: cutout.id, startX: e.clientX, startY: e.clientY, origX: cutout.x ?? 0, origY: cutout.y ?? 0 };
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
        if (!_dragCutout || _dragCutout.el !== el) return;
        const sr = _stage.getBoundingClientRect();
        const nx = _dragCutout.origX + (e.clientX - _dragCutout.startX) * (CANVAS_W / sr.width);
        const ny = _dragCutout.origY + (e.clientY - _dragCutout.startY) * (CANVAS_H / sr.height);
        el.style.left = (nx / CANVAS_W * 100) + "%";
        el.style.top  = (ny / CANVAS_H * 100) + "%";
        cutout.x = nx; cutout.y = ny;
    });
    el.addEventListener("pointerup", async () => {
        if (!_dragCutout || _dragCutout.el !== el) return;
        el.classList.remove("dragging"); _dragCutout = null;
        await _saveCutouts();
    });

    rz.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        _resizeCutout = { el, id: cutout.id, startX: e.clientX, startY: e.clientY, origW: cutout.w ?? 200, origH: cutout.h ?? 150 };
        rz.setPointerCapture(e.pointerId);
    });
    rz.addEventListener("pointermove", (e) => {
        if (!_resizeCutout || _resizeCutout.el !== el) return;
        const sr = _stage.getBoundingClientRect();
        const nw = Math.max(20, _resizeCutout.origW + (e.clientX - _resizeCutout.startX) * (CANVAS_W / sr.width));
        const nh = Math.max(20, _resizeCutout.origH + (e.clientY - _resizeCutout.startY) * (CANVAS_H / sr.height));
        el.style.width  = (nw / CANVAS_W * 100) + "%";
        el.style.height = (nh / CANVAS_H * 100) + "%";
        cutout.w = nw; cutout.h = nh;
    });
    rz.addEventListener("pointerup", async () => {
        if (!_resizeCutout || _resizeCutout.el !== el) return;
        _resizeCutout = null; await _saveCutouts();
    });

    _cutoutLayer.appendChild(el);
}

async function _addCutout(url) {
    if (!_canEdit) return;
    if (!_frames.length) { toast("Add a frame first", "info"); return; }
    const frame = _frames[_curFrameIdx];
    const cutout = { id: Math.random().toString(36).slice(2), url, x: Math.round(CANVAS_W * 0.1), y: Math.round(CANVAS_H * 0.1), w: 200, h: 150, rotation: 0 };
    try {
        await updateDoc(_frameDoc(_curClipId, frame.id), { cutouts: [...(frame.cutouts || []), cutout], updatedAt: serverTimestamp() });
    } catch (err) {
        toast("Failed to add cutout", "error");
    }
}

async function _removeCutout(cutoutId) {
    if (!_canEdit) return;
    const frame = _frames[_curFrameIdx];
    if (!frame) return;
    try {
        await updateDoc(_frameDoc(_curClipId, frame.id), { cutouts: (frame.cutouts || []).filter(c => c.id !== cutoutId), updatedAt: serverTimestamp() });
    } catch (err) {
        toast("Failed to remove cutout", "error");
    }
}

async function _saveCutouts() {
    const frame = _frames[_curFrameIdx];
    if (!frame || !_curClipId) return;
    try {
        await updateDoc(_frameDoc(_curClipId, frame.id), { cutouts: [...(frame.cutouts || [])], updatedAt: serverTimestamp() });
    } catch (err) {
        console.error("[animation] saveCutouts:", err);
    }
}

/* ======================================================= TOOLBAR == */

function _setupToolbar() {
    document.getElementById("btn-anim-back").addEventListener("click", () => {
        _saveCurrentFrame(true).then(() => _backToLibrary());
    });

    document.getElementById("btn-anim-new-scene").addEventListener("click", _addClip);
    document.getElementById("btn-anim-play-seq").addEventListener("click", _startSequence);

    document.getElementById("btn-anim-tool-draw").addEventListener("click", () => _setTool("draw"));
    document.getElementById("btn-anim-tool-erase").addEventListener("click", () => _setTool("erase"));

    const colorPicker = document.getElementById("anim-color-picker");
    colorPicker.value = _color;
    colorPicker.addEventListener("input", (e) => { _color = e.target.value; _updateCtxStyle(); });

    const sizeSlider = document.getElementById("anim-brush-size");
    sizeSlider.value = _brushSize;
    sizeSlider.addEventListener("input", (e) => { _brushSize = parseInt(e.target.value, 10); _updateCtxStyle(); });

    const fpsInput = document.getElementById("anim-fps");
    fpsInput.value = _fps;
    fpsInput.addEventListener("change", (e) => {
        _fps = Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 12));
        fpsInput.value = _fps;
    });

    document.getElementById("btn-anim-clear").addEventListener("click", async () => {
        if (!_canEdit || !_frames.length) return;
        const ok = await confirm("Clear this frame's drawing?", "");
        if (!ok) return;
        _clearCanvas(); _strokes = []; _dirty = true; await _saveCurrentFrame();
    });

    document.getElementById("btn-anim-add-frame").addEventListener("click", _addFrame);
    document.getElementById("btn-anim-del-frame").addEventListener("click", _deleteCurrentFrame);
    document.getElementById("btn-anim-add-cutout").addEventListener("click", _openCutoutModal);

    document.getElementById("btn-anim-onion").addEventListener("click", (e) => {
        const visible = _onionCanvas.style.display !== "none";
        _onionCanvas.style.display = visible ? "none" : "";
        e.currentTarget.classList.toggle("active", !visible);
    });
}

function _setTool(tool) {
    _tool = tool;
    document.querySelectorAll(".anim-tool-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tool === tool);
    });
    _updateCtxStyle();
}

/* ======================================================= PLAYBACK == */

function _setupPlayback() {
    document.getElementById("btn-anim-play").addEventListener("click", _togglePlayback);
    document.getElementById("btn-anim-prev").addEventListener("click", () => {
        _stopPlayback(); _saveCurrentFrame(true).then(() => _loadFrame(_curFrameIdx - 1));
    });
    document.getElementById("btn-anim-next").addEventListener("click", () => {
        _stopPlayback(); _saveCurrentFrame(true).then(() => _loadFrame(_curFrameIdx + 1));
    });
}

/* ======================================================= SEQUENCE PLAYBACK == */

function _resolvePlayOrder(onlyConnected = true) {
    /* Find every clip that has at least one connection (either direction) */
    const hasOutgoing = new Set(_clips.filter(c => (c.connections || []).length > 0).map(c => c.id));
    const hasIncoming = new Set(_clips.flatMap(c => c.connections || []));
    const connected   = new Set([...hasOutgoing, ...hasIncoming]);

    const targets = new Set(_clips.flatMap(c => c.connections || []));
    /* Roots = connected clips with no incoming arrow */
    const roots   = _clips.filter(c => connected.has(c.id) && !targets.has(c.id));
    const visited = new Set();
    const order   = [];

    function bfs(startId) {
        const q = [startId];
        while (q.length) {
            const id = q.shift();
            if (visited.has(id)) continue;
            visited.add(id);
            order.push(id);
            const clip = _clips.find(c => c.id === id);
            if (clip) (clip.connections || []).forEach(cid => q.push(cid));
        }
    }

    roots.forEach(c => bfs(c.id));

    if (!onlyConnected) {
        /* For rendering: also append isolated clips so arrows still get sequence numbers */
        _clips.forEach(c => { if (!visited.has(c.id)) order.push(c.id); });
    }

    return order;
}

async function _startSequence() {
    if (_clips.length === 0) { toast("No scenes to play", "info"); return; }
    _stopSequence();

    const order = _resolvePlayOrder(true); // only connected scenes
    if (!order.length) { toast("Connect scenes together first to define playback order", "info"); return; }
    _seqQueue = [];

    for (const clipId of order) {
        const snap = await getDocs(query(_framesRef(clipId), orderBy("order")));
        const frames = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (frames.length) {
            const clip = _clips.find(c => c.id === clipId);
            _seqQueue.push({ id: clipId, name: clip?.name || "Scene", frames });
        }
    }

    if (!_seqQueue.length) { toast("No frames to play", "info"); return; }
    _seqClipIdx  = 0;
    _seqFrameIdx = 0;
    _seqPlaying  = true;
    _showSeqOverlay();
    _seqAdvanceFrame();
}

function _showSeqOverlay() {
    _seqOverlay = document.createElement("div");
    _seqOverlay.className = "anim-seq-overlay";
    _seqOverlay.innerHTML = `
        <div class="anim-seq-bar">
            <span class="anim-seq-label" id="anim-seq-label"></span>
            <span class="anim-seq-counter" id="anim-seq-counter"></span>
            <button class="ws-btn ws-btn-sm" id="btn-anim-seq-stop">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                Stop
            </button>
        </div>
        <div class="anim-seq-stage">
            <canvas id="anim-seq-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
        </div>`;
    _libraryEl.appendChild(_seqOverlay);
    document.getElementById("btn-anim-seq-stop").addEventListener("click", _stopSequence);
    _seqCanvas = document.getElementById("anim-seq-canvas");
    _seqCtx    = _seqCanvas.getContext("2d");
}

function _hideSeqOverlay() {
    if (_seqOverlay) { _seqOverlay.remove(); _seqOverlay = null; _seqCanvas = null; _seqCtx = null; }
}

function _seqAdvanceFrame() {
    if (!_seqPlaying) return;
    const clipData = _seqQueue[_seqClipIdx];
    if (!clipData) { _stopSequence(); return; }

    const frame = clipData.frames[_seqFrameIdx];
    const labelEl   = document.getElementById("anim-seq-label");
    const counterEl = document.getElementById("anim-seq-counter");
    if (labelEl)   labelEl.textContent   = clipData.name;
    if (counterEl) counterEl.textContent = `Scene ${_seqClipIdx + 1}/${_seqQueue.length} · Frame ${_seqFrameIdx + 1}/${clipData.frames.length}`;

    const dur = frame?.duration ?? Math.round(1000 / (_fps || 12));

    /* Advance indices for next call */
    _seqFrameIdx++;
    if (_seqFrameIdx >= clipData.frames.length) {
        _seqFrameIdx = 0;
        _seqClipIdx++;
        if (_seqClipIdx >= _seqQueue.length) {
            /* Last frame — draw it, then stop */
            _drawSeqFrame(frame, () => _stopSequence());
            return;
        }
    }

    _drawSeqFrame(frame, () => { _seqTimer = setTimeout(_seqAdvanceFrame, dur); });
}

function _drawSeqFrame(frame, done) {
    if (!_seqCtx) { done(); return; }
    _seqCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (frame?.strokes?.length) {
        _replayStrokes(frame.strokes, _seqCtx);
        done();
    } else if (frame?.canvasData) {
        /* Legacy fallback */
        const img = new Image();
        img.onload  = () => { if (_seqCtx) _seqCtx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H); done(); };
        img.onerror = () => done();
        img.src = frame.canvasData;
    } else {
        done();
    }
}

function _stopSequence() {
    _seqPlaying = false;
    clearTimeout(_seqTimer);
    _seqTimer = null;
    _hideSeqOverlay();
}

function _togglePlayback() { _playing ? _stopPlayback() : _startPlayback(); }

function _startPlayback() {
    if (_frames.length < 2) { toast("Add more frames to play", "info"); return; }
    _saveCurrentFrame(); _playing = true;
    const btn = document.getElementById("btn-anim-play");
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
    btn.title = "Pause";
    _advanceFrame();
}

function _advanceFrame() {
    if (!_playing) return;
    _loadFrame((_curFrameIdx + 1) % _frames.length);
    const dur = _frames[_curFrameIdx]?.duration ?? Math.round(1000 / _fps);
    _playTimer = setTimeout(_advanceFrame, dur);
}

function _stopPlayback() {
    _playing = false; clearTimeout(_playTimer); _playTimer = null;
    const btn = document.getElementById("btn-anim-play");
    if (btn) {
        btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
        btn.title = "Play";
    }
}

/* ======================================================= KEYBOARD == */

function _setupKeyboard() {
    document.addEventListener("keydown", (e) => {
        /* Library: Escape cancels connect mode */
        if (!_editorEl || _editorEl.style.display === "none") {
            if (e.key === "Escape" && _connectingFrom) { e.preventDefault(); _cancelConnect(); }
            return;
        }
        /* Editor: skip if typing */
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
        if (e.key === "ArrowLeft") {
            e.preventDefault(); _stopPlayback(); _saveCurrentFrame(true).then(() => _loadFrame(_curFrameIdx - 1));
        } else if (e.key === "ArrowRight") {
            e.preventDefault(); _stopPlayback(); _saveCurrentFrame(true).then(() => _loadFrame(_curFrameIdx + 1));
        } else if (e.key === "Escape") {
            _saveCurrentFrame(true).then(() => _backToLibrary());
        }
    });
}

/* ======================================================= TIMELINE == */

function _setupTimeline() {
    document.getElementById("anim-frames").addEventListener("click", (e) => {
        const frame = e.target.closest(".anim-frame");
        if (!frame) return;
        const idx = parseInt(frame.dataset.idx, 10);
        if (!isNaN(idx)) { _stopPlayback(); _saveCurrentFrame(true).then(() => _loadFrame(idx)); }
    });
}

function _renderTimeline() {
    const framesEl = document.getElementById("anim-frames");
    if (!framesEl) return;
    framesEl.innerHTML = _frames.map((frame, idx) => {
        const hasDrawing = frame.strokes?.length > 0 || frame.canvasData;
        const thumb = hasDrawing
            ? `<canvas class="anim-frame-img" data-frame-id="${escHtml(frame.id)}" width="160" height="90"></canvas>`
            : `<div class="anim-frame-empty"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></div>`;
        return `<div class="anim-frame${idx === _curFrameIdx ? " active" : ""}" data-idx="${idx}" title="Frame ${idx + 1}">${thumb}<div class="anim-frame-num">${idx + 1}</div></div>`;
    }).join("");
    const active = framesEl.querySelector(".anim-frame.active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    /* Render thumbnails asynchronously */
    framesEl.querySelectorAll("canvas[data-frame-id]").forEach(el => {
        const frameId = el.dataset.frameId;
        const frame   = _frames.find(f => f.id === frameId);
        if (!frame) return;
        if (_thumbCache.has(frameId)) {
            const img = new Image();
            img.onload = () => { el.getContext("2d").drawImage(img, 0, 0, 160, 90); };
            img.src = _thumbCache.get(frameId);
            return;
        }
        /* Generate thumbnail from strokes */
        requestAnimationFrame(() => {
            const off = document.createElement("canvas");
            off.width = CANVAS_W; off.height = CANVAS_H;
            const ctx = off.getContext("2d");
            if (frame.strokes?.length) {
                _replayStrokes(frame.strokes, ctx);
            } else if (frame.canvasData) {
                const img = new Image();
                img.onload = () => {
                    ctx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
                    const url = off.toDataURL("image/jpeg", 0.6);
                    _thumbCache.set(frameId, url);
                    el.getContext("2d").drawImage(off, 0, 0, 160, 90);
                };
                img.src = frame.canvasData;
                return;
            }
            const url = off.toDataURL("image/jpeg", 0.6);
            _thumbCache.set(frameId, url);
            el.getContext("2d").drawImage(off, 0, 0, 160, 90);
        });
    });
}

function _renderFrameInfo() {
    const numEl   = document.getElementById("anim-frame-num");
    const totalEl = document.getElementById("anim-frame-total");
    if (numEl)   numEl.textContent   = _frames.length > 0 ? _curFrameIdx + 1 : 0;
    if (totalEl) totalEl.textContent = _frames.length;
}

/* ======================================================= CUTOUT PICKER == */

function _setupCutoutModal() {
    document.getElementById("anim-cutout-picker").addEventListener("click", async (e) => {
        const item = e.target.closest(".anim-cpick-item");
        if (!item?.dataset.url) return;
        closeModal("modal-anim-cutout");
        await _addCutout(item.dataset.url);
    });
}

function _openCutoutModal() {
    if (!_canEdit) { toast("View-only access", "info"); return; }
    if (!_frames.length) { toast("Add a frame first", "info"); return; }
    _renderCutoutPicker(); openModal("modal-anim-cutout");
}

async function _loadMediaLinks() {
    if (!_uid || !_pid || !currentProject) return;
    try {
        const catId = currentProject.sourceCategoryId ?? _pid;
        const q = query(collection(db, "users", _uid, "links"), where("categoryId", "==", catId));
        const snap = await getDocs(q);
        _mediaLinks = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(l => l.image || l.type === "image" || _isImageUrl(l.url || ""));
    } catch {
        _mediaLinks = [];
    }
}

function _isImageUrl(url) {
    return /\.(jpe?g|png|gif|webp|svg|bmp)(\?.*)?$/i.test(url);
}

function _renderCutoutPicker() {
    const el = document.getElementById("anim-cutout-picker");
    if (!el) return;
    if (!_mediaLinks.length) {
        el.innerHTML = `<p class="anim-cpick-empty">No images found. Add images in the Media tab first.</p>`;
        return;
    }
    el.innerHTML = _mediaLinks.map(link => {
        const thumb = link.image || link.url || "";
        const label = escHtml(link.name || link.title || link.url || "Image");
        return `<div class="anim-cpick-item" data-url="${escHtml(thumb)}" title="${label}">
                    <div class="anim-cpick-thumb"><img src="${escHtml(thumb)}" alt="${label}" loading="lazy"></div>
                    <div class="anim-cpick-label">${label}</div>
                </div>`;
    }).join("");
}
