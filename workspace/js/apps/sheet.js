/**
 * sheet.js — standalone Sheet Viewer hub app
 * Supports: .xlsx, .xls (via SheetJS), .csv, .tsv
 * Features: Norwegian/Latin-1 encoding, URL loading, cell colors, Firestore persistence, in-cell editing
 */

import {
    addDoc, deleteDoc, setDoc, getDocs,
    collection, doc, query, orderBy
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { escHtml } from "../ui.js";

const XLSX_CDN = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

/* ══════════ State ══════════ */

let _db  = null;
let _uid = null;

// Each file: { id, name, url?, docId?, sheets:[{name, rows:[[cell]]}], activeSub, editedCells:{} }
// Each cell: string (CSV) OR { v:string, bg:string|null, fg:string|null, bold:bool } (Excel)
let _files        = [];
let _fileIdx      = 0;
let _uid_counter  = 0;
let _saveTimer    = null;

/* ══════════ Public init ══════════ */

export function initSheet() {
    const fileInput = document.getElementById("sv-file-input");
    const drop      = document.getElementById("sv-drop");
    const fileTabs  = document.getElementById("sv-file-tabs");
    const subTabs   = document.getElementById("sv-sub-tabs");
    const urlBtn    = document.getElementById("sv-url-btn");
    const urlBar    = document.getElementById("sv-url-bar");
    const urlInput  = document.getElementById("sv-url-input");
    const urlLoad   = document.getElementById("sv-url-load");
    const urlClose  = document.getElementById("sv-url-close");
    const table     = document.getElementById("sv-table");

    if (!fileInput) return;

    fileInput.addEventListener("change", e => {
        _handleFiles(e.target.files);
        e.target.value = "";
    });

    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("sv-drag-over"); });
    drop.addEventListener("dragleave", e => {
        if (!drop.contains(e.relatedTarget)) drop.classList.remove("sv-drag-over");
    });
    drop.addEventListener("drop", e => {
        e.preventDefault();
        drop.classList.remove("sv-drag-over");
        _handleFiles(e.dataTransfer.files);
    });
    drop.addEventListener("click", e => {
        if (e.target.closest(".sv-browse-btn")) fileInput.click();
    });

    // URL bar
    urlBtn?.addEventListener("click", () => {
        urlBar?.classList.toggle("sv-url-bar--open");
        if (urlBar?.classList.contains("sv-url-bar--open")) urlInput?.focus();
    });
    urlClose?.addEventListener("click", () => urlBar?.classList.remove("sv-url-bar--open"));
    urlLoad?.addEventListener("click",  () => _loadUrl(urlInput?.value?.trim()));
    urlInput?.addEventListener("keydown", e => {
        if (e.key === "Enter")  _loadUrl(urlInput.value.trim());
        if (e.key === "Escape") urlBar?.classList.remove("sv-url-bar--open");
    });

    // File-tabs delegation
    fileTabs.addEventListener("click", e => {
        const closeBtn = e.target.closest(".sv-file-tab-close");
        const tab      = e.target.closest(".sv-file-tab");
        if (closeBtn) {
            e.stopPropagation();
            _removeFile(parseInt(closeBtn.dataset.id, 10));
        } else if (tab) {
            _fileIdx = parseInt(tab.dataset.idx, 10);
            _render();
        }
    });

    // Sub-tabs delegation
    subTabs.addEventListener("click", e => {
        const tab = e.target.closest(".sv-sub-tab");
        if (!tab) return;
        if (_files[_fileIdx]) {
            _files[_fileIdx].activeSub = parseInt(tab.dataset.sub, 10);
            _render();
        }
    });

    // In-cell editing — listen at the table level
    table?.addEventListener("input", e => {
        const td = e.target.closest("td[contenteditable]");
        if (!td) return;
        _onCellInput(td);
    });

    // Prevent newlines in cells (Enter = confirm, move to next row later)
    table?.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            const td = e.target.closest("td[contenteditable]");
            td?.blur();
        }
    });
}

/** Called by onUserReady in app.js after authentication. */
export async function initSheetUser(db, uid) {
    _db  = db;
    _uid = uid;
    // Load saved URL-based sheets from Firestore
    try {
        const q    = query(collection(db, "users", uid, "sheet-sources"), orderBy("order"));
        const snap = await getDocs(q);
        for (const d of snap.docs) {
            await _loadUrlSaved(d.id, d.data());
        }
    } catch (err) {
        console.warn("[sheet] failed to load saved sources:", err);
    }
}

/* ══════════ File handling ══════════ */

async function _handleFiles(fileList) {
    for (const f of fileList) await _addFile(f);
}

async function _addFile(file) {
    const name = file.name;
    const ext  = name.split(".").pop().toLowerCase();
    let sheets;

    if (ext === "csv" || ext === "tsv") {
        const text  = await _readText(file);
        const delim = ext === "tsv" ? "\t" : _detectDelimiter(text);
        sheets = [{ name: "Sheet1", rows: _parseCsv(text, delim) }];
    } else if (ext === "xlsx" || ext === "xls") {
        sheets = await _parseExcel(await file.arrayBuffer());
        if (!sheets) return;
    } else {
        return;
    }

    _files.push({ id: ++_uid_counter, name, sheets, activeSub: 0, editedCells: {} });
    _fileIdx = _files.length - 1;
    _render();
}

async function _removeFile(id) {
    const idx = _files.findIndex(f => f.id === id);
    if (idx === -1) return;
    const file = _files[idx];
    // Delete from Firestore if it was a URL-based saved sheet
    if (file.docId) {
        _deleteSource(file.docId).catch(() => {});
    }
    _files.splice(idx, 1);
    _fileIdx = Math.max(0, Math.min(_fileIdx, _files.length - 1));
    _render();
}

/* ══════════ URL loading ══════════ */

function _transformUrl(url) {
    // Google Sheets edit/view → xlsx export
    const gMatch = url.match(/docs\.google\.com\/spreadsheets\/d\/([^/]+)/);
    if (gMatch) {
        return `https://docs.google.com/spreadsheets/d/${gMatch[1]}/export?format=xlsx`;
    }
    // SharePoint doc2.aspx → raw file download
    if (url.includes("sharepoint.com") && url.includes("doc2.aspx")) {
        try {
            const u = new URL(url);
            u.searchParams.set("download", "1");
            u.searchParams.delete("action");
            u.searchParams.delete("mobileredirect");
            return u.toString();
        } catch { /* fall through */ }
    }
    return url;
}

function _extFromUrl(url) {
    try {
        const fileParam = new URL(url).searchParams.get("file") || "";
        const extP = fileParam.split(".").pop().toLowerCase();
        if (["xlsx", "xls", "csv", "tsv"].includes(extP)) return extP;
        const extN = new URL(url).pathname.toLowerCase().split(".").pop();
        if (["xlsx", "xls", "csv", "tsv"].includes(extN)) return extN;
    } catch { /* ignore */ }
    return "xlsx";
}

function _nameFromUrl(url) {
    try {
        const fileParam = new URL(url).searchParams.get("file");
        if (fileParam) return decodeURIComponent(fileParam);
        const last = new URL(url).pathname.split("/").filter(Boolean).pop();
        if (last) return decodeURIComponent(last);
    } catch { /* ignore */ }
    return url.length > 60 ? url.slice(0, 57) + "\u2026" : url;
}

async function _loadUrl(url) {
    if (!url) return;
    const urlBar  = document.getElementById("sv-url-bar");
    const urlInp  = document.getElementById("sv-url-input");
    const loadBtn = document.getElementById("sv-url-load");

    if (loadBtn) { loadBtn.textContent = "Loading\u2026"; loadBtn.disabled = true; }

    try {
        const fetchUrl = _transformUrl(url);
        const res = await fetch(fetchUrl, { credentials: "include" });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);

        const buf    = await res.arrayBuffer();
        const ext    = _extFromUrl(url);
        const name   = _nameFromUrl(url);
        let   sheets;

        if (ext === "csv" || ext === "tsv") {
            const text  = _decodeBuffer(buf);
            const delim = ext === "tsv" ? "\t" : _detectDelimiter(text);
            sheets = [{ name: "Sheet1", rows: _parseCsv(text, delim) }];
        } else {
            sheets = await _parseExcel(buf);
            if (!sheets) throw new Error("Could not parse the file");
        }

        const file = { id: ++_uid_counter, name, url, sheets, activeSub: 0, editedCells: {} };
        _files.push(file);
        _fileIdx = _files.length - 1;

        // Persist to Firestore
        _saveSource(file).catch(() => {});

        _render();
        urlBar?.classList.remove("sv-url-bar--open");
        if (urlInp) urlInp.value = "";

    } catch (err) {
        const isCors = err instanceof TypeError;
        alert(isCors
            ? "Could not fetch the file \u2014 the server blocked cross-origin requests (CORS).\n\nTry downloading the file and opening it with \u201cAdd file\u201d instead."
            : `Error: ${err.message}`);
    } finally {
        if (loadBtn) { loadBtn.textContent = "Load"; loadBtn.disabled = false; }
    }
}

/** Re-fetches a URL that was saved in Firestore on a previous session. */
async function _loadUrlSaved(docId, data) {
    const { url, name, editedCells = {} } = data;
    if (!url) return;
    try {
        const fetchUrl = _transformUrl(url);
        const res = await fetch(fetchUrl, { credentials: "include" });
        if (!res.ok) return;
        const buf  = await res.arrayBuffer();
        const ext  = _extFromUrl(url);
        let   sheets;
        if (ext === "csv" || ext === "tsv") {
            const text  = _decodeBuffer(buf);
            const delim = ext === "tsv" ? "\t" : _detectDelimiter(text);
            sheets = [{ name: "Sheet1", rows: _parseCsv(text, delim) }];
        } else {
            sheets = await _parseExcel(buf);
            if (!sheets) return;
        }
        _files.push({ id: ++_uid_counter, name: name || _nameFromUrl(url), url, docId, sheets, activeSub: 0, editedCells });
        if (_files.length === 1) _fileIdx = 0;
        _render();
    } catch { /* silently skip if offline/CORS at startup */ }
}

/* ══════════ Firestore persistence ══════════ */

async function _saveSource(file) {
    if (!_db || !_uid || !file.url) return;
    const col = collection(_db, "users", _uid, "sheet-sources");
    const ref = await addDoc(col, { name: file.name, url: file.url, order: Date.now(), editedCells: {} });
    file.docId = ref.id;
}

async function _deleteSource(docId) {
    if (!_db || !_uid || !docId) return;
    await deleteDoc(doc(_db, "users", _uid, "sheet-sources", docId));
}

function _scheduleSave(file) {
    if (!_db || !_uid || !file.docId) return;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => _saveEdits(file), 1500);
}

async function _saveEdits(file) {
    if (!_db || !_uid || !file.docId) return;
    await setDoc(
        doc(_db, "users", _uid, "sheet-sources", file.docId),
        { editedCells: file.editedCells },
        { merge: true }
    );
}

/* ══════════ In-cell editing ══════════ */

function _onCellInput(td) {
    const file = _files[_fileIdx];
    if (!file) return;
    const sub     = file.activeSub || 0;
    const ri      = parseInt(td.dataset.ri, 10);
    const ci      = parseInt(td.dataset.ci, 10);
    const newVal  = td.textContent;
    const editKey = `${sub}:${ri}:${ci}`;

    if (!file.editedCells) file.editedCells = {};
    file.editedCells[editKey] = newVal;

    // Update in-memory so re-renders (tab switch etc.) show the edit
    const row = file.sheets[sub]?.rows[ri];
    if (row) {
        const cell = row[ci];
        if (cell !== undefined) {
            if (typeof cell === "object" && cell !== null) {
                cell.v = newVal;
            } else {
                row[ci] = newVal;
            }
        }
    }

    _scheduleSave(file);
}

/* ══════════ Encoding (fixes ø æ å) ══════════ */

async function _readText(file) {
    return _decodeBuffer(await file.arrayBuffer());
}

function _decodeBuffer(buf) {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
        return new TextDecoder("windows-1252").decode(buf);
    }
}

/* ══════════ CSV Parser ══════════ */

function _detectDelimiter(text) {
    const sample = text.slice(0, 4000);
    const counts = { ",": 0, ";": 0, "\t": 0 };
    for (const ch of sample) if (ch in counts) counts[ch]++;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function _parseCsv(text, delim = ",") {
    const rows = [];
    let row = [], cell = "", inQuote = false;
    const flush    = () => { rows.push(row); row = []; };
    const pushCell = () => { row.push(cell); cell = ""; };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuote) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; }
                else inQuote = false;
            } else { cell += ch; }
        } else {
            if      (ch === '"')   { inQuote = true; }
            else if (ch === delim) { pushCell(); }
            else if (ch === "\r")  { pushCell(); flush(); if (text[i + 1] === "\n") i++; }
            else if (ch === "\n")  { pushCell(); flush(); }
            else                   { cell += ch; }
        }
    }
    pushCell();
    if (row.length) flush();
    while (rows.length && rows[rows.length - 1].every(c => c === "")) rows.pop();
    return rows;
}

/* ══════════ Excel Parser ══════════ */

async function _ensureXLSX() {
    if (window.XLSX) return;
    await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = XLSX_CDN;
        s.onload = res;
        s.onerror = rej;
        document.head.appendChild(s);
    }).catch(() => {});
}

/**
 * Convert SheetJS ARGB ("AARRGGBB" 8-char or "RRGGBB" 6-char) to "#RRGGBB".
 * Returns null if the value is missing or represents "no fill" (pure white for bg).
 */
function _argbToHex(argb, skipWhite = false) {
    if (!argb || typeof argb !== "string") return null;
    let hex = argb;
    if (hex.length === 8) hex = hex.slice(2);          // strip alpha
    if (hex.length !== 6) return null;                 // unexpected format
    if (skipWhite && /^(FF){0,1}(FFFFFF)$/i.test(argb.length === 8 ? argb.slice(2) : argb)) return null;
    return "#" + hex.toUpperCase();
}

/** Returns [{ name, rows:[[{v, bg, fg, bold}]] }] */
async function _parseExcel(buf) {
    await _ensureXLSX();
    if (!window.XLSX) return null;

    let wb;
    try {
        wb = window.XLSX.read(buf, { type: "array", cellStyles: true });
    } catch (e) {
        console.error("[sheet] xlsx parse error:", e);
        return null;
    }

    return wb.SheetNames.map(shName => {
        const ws = wb.Sheets[shName];
        if (!ws["!ref"]) return { name: shName, rows: [] };

        const range = window.XLSX.utils.decode_range(ws["!ref"]);
        const rows  = [];

        for (let r = range.s.r; r <= range.e.r; r++) {
            const row = [];
            for (let c = range.s.c; c <= range.e.c; c++) {
                const addr = window.XLSX.utils.encode_cell({ r, c });
                const cell = ws[addr];

                if (!cell) { row.push({ v: "", bg: null, fg: null, bold: false }); continue; }

                // cell.w = formatted display string (dates, number formats)
                const v    = cell.w !== undefined ? String(cell.w) : (cell.v !== undefined ? String(cell.v) : "");
                const s    = cell.s  || {};
                const fill = s.fill  || {};
                const font = s.font  || {};

                // Only extract bg for solid fills; fgColor is the fill colour (Excel quirk)
                const hasFill = fill.patternType && fill.patternType !== "none";
                const bgArgb  = hasFill ? (fill.fgColor?.rgb || fill.bgColor?.rgb) : null;
                const bg      = _argbToHex(bgArgb, true);   // skip white (= effectively no fill)
                const fg      = _argbToHex(font.color?.rgb, false);
                const bold    = !!font.bold;

                row.push({ v, bg, fg, bold });
            }
            rows.push(row);
        }

        return { name: shName, rows };
    });
}

/* ══════════ Render ══════════ */

function _render() {
    _renderFileTabs();
    _renderSubTabs();
    _renderTable();
}

function _renderFileTabs() {
    const fileTabs = document.getElementById("sv-file-tabs");
    if (!fileTabs) return;
    fileTabs.innerHTML = _files.map((f, i) => `
        <button class="sv-file-tab${i === _fileIdx ? " active" : ""}" data-idx="${i}">
            ${f.url ? `<span class="sv-tab-cloud" title="Saved \u2014 reloads automatically">&#9729;</span>` : ""}
            <span class="sv-tab-name">${escHtml(f.name)}</span>
            <button class="sv-file-tab-close" data-id="${f.id}" title="Close">&times;</button>
        </button>
    `).join("");
}

function _renderSubTabs() {
    const subTabs = document.getElementById("sv-sub-tabs");
    if (!subTabs) return;
    const file = _files[_fileIdx];
    if (!file || file.sheets.length <= 1) { subTabs.innerHTML = ""; return; }
    subTabs.innerHTML = file.sheets.map((sh, i) => `
        <button class="sv-sub-tab${i === (file.activeSub || 0) ? " active" : ""}" data-sub="${i}">
            ${escHtml(sh.name)}
        </button>
    `).join("");
}

// Cell accessors — work for both plain strings (CSV) and styled objects (Excel)
const _cv    = c => (c && typeof c === "object") ? c.v    : (c ?? "");
const _cbg   = c => (c && typeof c === "object") ? c.bg   : null;
const _cfg   = c => (c && typeof c === "object") ? c.fg   : null;
const _cbold = c => (c && typeof c === "object") ? c.bold : false;

function _cellStyle(cell) {
    const parts = [];
    const bg = _cbg(cell);
    const fg = _cfg(cell);
    if (bg) parts.push(`background:${bg}`);
    if (fg) parts.push(`color:${fg}`);
    if (_cbold(cell)) parts.push("font-weight:600");
    return parts.length ? ` style="${parts.join(";")}"` : "";
}

function _renderTable() {
    const drop    = document.getElementById("sv-drop");
    const content = document.getElementById("sv-content");
    const table   = document.getElementById("sv-table");
    if (!drop || !content || !table) return;

    if (!_files.length) {
        drop.style.display    = "";
        content.style.display = "none";
        return;
    }

    drop.style.display    = "none";
    content.style.display = "flex";

    const file = _files[_fileIdx];
    const sub  = file?.activeSub || 0;
    const rows = file?.sheets[sub]?.rows || [];

    if (!rows.length) {
        table.innerHTML = `<caption style="padding:2rem;color:var(--text-muted)">Empty sheet</caption>`;
        return;
    }

    const colCount  = Math.max(...rows.map(r => r.length));
    const [header, ...dataRows] = rows;

    // Header row — not editable; shows column letters
    const thRow = `<th class="sv-corner"></th>` + Array.from({ length: colCount }, (_, ci) => {
        const cell = ci < header.length ? header[ci] : null;
        return `<th${_cellStyle(cell)}>${escHtml(String(_cv(cell)))}</th>`;
    }).join("");

    // Data rows — editable
    const tbRows = dataRows.map((row, i) => {
        const ri = i + 1; // row index in full rows array (header = 0)
        const cells = Array.from({ length: colCount }, (_, ci) => {
            const cell     = ci < row.length ? row[ci] : null;
            // Apply any manual edits (overrides base data)
            const editKey  = `${sub}:${ri}:${ci}`;
            const editVal  = file.editedCells?.[editKey];
            const display  = editVal !== undefined ? editVal : String(_cv(cell));
            return `<td contenteditable="true" data-ri="${ri}" data-ci="${ci}"${_cellStyle(cell)}>${escHtml(display)}</td>`;
        }).join("");
        return `<tr><td class="sv-row-num">${ri}</td>${cells}</tr>`;
    }).join("");

    table.innerHTML = `<thead><tr>${thRow}</tr></thead><tbody>${tbRows}</tbody>`;
}

