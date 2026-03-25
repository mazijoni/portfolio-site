/**
 * sections/nodes.js — Node flow diagram.
 * Nodes are draggable boxes on an SVG canvas.
 * Clicking an output port then an input port creates an edge.
 * Data is persisted to Firestore.
 */

import {
    onSnapshot, addDoc, deleteDoc, updateDoc,
    doc, query, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { auth, db }             from "../app.js";
import { currentProjectId }     from "../projects.js";
import { refs }                 from "../db.js";
import { openModal, closeModal,
         toast, confirm, escHtml } from "../ui.js";

let _pid        = null;
let _uid        = null;
let _unsubNodes = null;
let _unsubEdges = null;
let _nodes      = {};  // { id: { data, el } }
let _edges      = [];  // [{ id, data }]
let _pendingPort = null; // { nodeId, portEl } — first port clicked for edge creation

export function init() {
    window.addEventListener("projectSelected", ({ detail }) => {
        _pid = detail.id;
        _uid = auth.currentUser?.uid;
        _subscribe();
    });

    window.addEventListener("sectionActivated", (e) => {
        if (e.detail.section === "nodes" && currentProjectId !== _pid) {
            _pid = currentProjectId;
            _uid = auth.currentUser?.uid;
            _subscribe();
        }
    });

    document.getElementById("btn-add-node")
        .addEventListener("click", _openNodeForm);
    document.getElementById("btn-clear-nodes")
        .addEventListener("click", _clearAllNodes);
    document.getElementById("form-node")
        .addEventListener("submit", _onNodeFormSubmit);

    if (currentProjectId) {
        _pid = currentProjectId;
        _uid = auth.currentUser?.uid;
        _subscribe();
    }
}

/* ── Subscriptions ── */

function _subscribe() {
    if (_unsubNodes) _unsubNodes();
    if (_unsubEdges) _unsubEdges();
    if (!_pid || !_uid) return;

    _unsubNodes = onSnapshot(
        query(refs.nodes(db, _uid, _pid), orderBy("createdAt")),
        (snap) => {
            // Clear container
            const container = document.getElementById("nodes-container");
            container.innerHTML = "";
            _nodes = {};

            snap.forEach(d => {
                const data = d.data();
                const el   = _createNodeEl(d.id, data);
                _nodes[d.id] = { data, el };
                container.appendChild(el);
            });

            document.getElementById("nodes-empty").style.display =
                snap.empty ? "" : "none";

            _redrawEdges();
        }
    );

    _unsubEdges = onSnapshot(
        query(refs.nodeEdges(db, _uid, _pid), orderBy("createdAt")),
        (snap) => {
            _edges = snap.docs.map(d => ({ id: d.id, data: d.data() }));
            _redrawEdges();
        }
    );
}

/* ── Render a node box ── */

function _createNodeEl(id, data) {
    const el = document.createElement("div");
    el.className    = "node-box";
    el.dataset.id   = id;
    el.dataset.type = data.type || "process";
    el.style.left   = (data.x ?? 60) + "px";
    el.style.top    = (data.y ?? 60) + "px";

    el.innerHTML = `
        <div class="node-port in"  data-role="in"  data-node="${id}"></div>
        <div class="node-box-label">${escHtml(data.label || "")}</div>
        <div class="node-box-type">${escHtml(data.type || "process")}</div>
        <button class="node-box-del" title="Delete node">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="node-port out" data-role="out" data-node="${id}"></div>`;

    el.querySelector(".node-box-del").addEventListener("click", (e) => {
        e.stopPropagation();
        _deleteNode(id);
    });

    // Port click → edge creation
    el.querySelectorAll(".node-port").forEach(port => {
        port.addEventListener("click", (e) => {
            e.stopPropagation();
            _handlePortClick(id, port);
        });
    });

    _makeDraggable(el, id);
    return el;
}

function _handlePortClick(nodeId, portEl) {
    if (!_pendingPort) {
        // First click — select output port
        if (portEl.dataset.role !== "out") { toast("Click the bottom port (out) first"); return; }
        _pendingPort = { nodeId, portEl };
        portEl.classList.add("active");
    } else {
        // Second click — must be an input port on a different node
        if (portEl.dataset.role !== "in")  { toast("Click the top port (in) of another node"); return; }
        if (_pendingPort.nodeId === nodeId) { toast("Cannot connect a node to itself"); _resetPendingPort(); return; }

        const from = _pendingPort.nodeId;
        const to   = nodeId;

        _pendingPort.portEl.classList.remove("active");
        _pendingPort = null;

        _createEdge(from, to);
    }
}

function _resetPendingPort() {
    if (_pendingPort) {
        _pendingPort.portEl.classList.remove("active");
        _pendingPort = null;
    }
}

// Cancel pending port on canvas click
document.addEventListener("click", (e) => {
    if (!e.target.closest(".node-port") && !e.target.closest(".node-box")) {
        _resetPendingPort();
    }
});

/* ── Edge drawing (SVG) ── */

function _redrawEdges() {
    const svg = document.getElementById("nodes-svg");
    svg.innerHTML = "";

    _edges.forEach(({ data }) => {
        const fromEl = document.querySelector(`.node-box[data-id="${data.from}"]`);
        const toEl   = document.querySelector(`.node-box[data-id="${data.to}"]`);
        if (!fromEl || !toEl) return;

        const fromPort = fromEl.querySelector(".node-port.out");
        const toPort   = toEl.querySelector(".node-port.in");
        if (!fromPort || !toPort) return;

        const fr = _portCenter(fromPort);
        const to = _portCenter(toPort);

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const cx   = (fr.x + to.x) / 2;
        path.setAttribute("d", `M${fr.x},${fr.y} C${cx},${fr.y} ${cx},${to.y} ${to.x},${to.y}`);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "rgba(199,114,254,0.45)");
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("stroke-dasharray", "6 3");
        svg.appendChild(path);
    });
}

function _portCenter(portEl) {
    const canvas = document.getElementById("nodes-canvas");
    const pr = portEl.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    return {
        x: pr.left + pr.width  / 2 - cr.left,
        y: pr.top  + pr.height / 2 - cr.top,
    };
}

/* ── Drag node ── */

function _makeDraggable(el, id) {
    el.addEventListener("mousedown", (e) => {
        if (e.target.closest(".node-box-del") || e.target.closest(".node-port")) return;
        e.preventDefault();

        const startX    = e.clientX;
        const startY    = e.clientY;
        const startLeft = parseInt(el.style.left) || 0;
        const startTop  = parseInt(el.style.top)  || 0;

        const onMove = (ev) => {
            el.style.left = (startLeft + ev.clientX - startX) + "px";
            el.style.top  = (startTop  + ev.clientY - startY) + "px";
            _redrawEdges();
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup",   onUp);
            const x = parseInt(el.style.left);
            const y = parseInt(el.style.top);
            updateDoc(doc(db, "users", _uid, "projects", _pid, "nodes", id), { x, y })
                .catch(console.error);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
    });
}

/* ── CRUD ── */

async function _createEdge(from, to) {
    try {
        await addDoc(refs.nodeEdges(db, _uid, _pid), {
            from, to, createdAt: serverTimestamp()
        });
    } catch (err) {
        console.error(err);
        toast("Error creating edge", "error");
    }
}

async function _deleteNode(id) {
    try {
        // Delete node + its connected edges
        const batch = writeBatch(db);
        batch.delete(doc(db, "users", _uid, "projects", _pid, "nodes", id));
        _edges.forEach(e => {
            if (e.data.from === id || e.data.to === id) {
                batch.delete(doc(db, "users", _uid, "projects", _pid, "node_edges", e.id));
            }
        });
        await batch.commit();
    } catch (err) {
        console.error(err);
        toast("Error deleting node", "error");
    }
}

async function _clearAllNodes() {
    if (!_pid || !_uid) return;
    const ok = await confirm("Clear all nodes and edges for this project?");
    if (!ok) return;

    try {
        const batch = writeBatch(db);
        Object.keys(_nodes).forEach(id =>
            batch.delete(doc(db, "users", _uid, "projects", _pid, "nodes", id)));
        _edges.forEach(e =>
            batch.delete(doc(db, "users", _uid, "projects", _pid, "node_edges", e.id)));
        await batch.commit();
    } catch (err) {
        console.error(err);
        toast("Error clearing nodes", "error");
    }
}

/* ── Form ── */

function _openNodeForm() {
    document.getElementById("form-node").reset();
    document.getElementById("node-id-field").value = "";
    openModal("modal-node");
    setTimeout(() => document.getElementById("node-field-label").focus(), 60);
}

async function _onNodeFormSubmit(e) {
    e.preventDefault();
    if (!_pid || !_uid) return;

    const label = document.getElementById("node-field-label").value.trim();
    const type  = document.getElementById("node-field-type").value;
    const note  = document.getElementById("node-field-note").value.trim();

    if (!label) return;

    // Place node in a grid pattern
    const count = Object.keys(_nodes).length;
    const x = 60 + (count % 4) * 220;
    const y = 60 + Math.floor(count / 4) * 120;

    try {
        await addDoc(refs.nodes(db, _uid, _pid), {
            label, type, note, x, y, createdAt: serverTimestamp()
        });
        closeModal("modal-node");
    } catch (err) {
        console.error(err);
        toast("Error adding node", "error");
    }
}
