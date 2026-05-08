/**
 * eurovision.js — Eurovision 2026 Point Tracker
 *
 * Features:
 *  - 35 competing countries (2026 Austria lineup)
 *  - Classic Eurovision scoring: 1,2,3,4,5,6,7,8,10,12 points
 *  - Firestore persistence per user
 *  - Share via room code — multiple users' scores averaged in real time
 *  - Leaderboard sorted by score
 *  - Copy-to-clipboard share link
 */

import {
    doc, setDoc, getDoc, onSnapshot,
    collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

/* ══════════════════════════════════════
   Eurovision 2026 Countries (35 total)
   ══════════════════════════════════════ */
export const COUNTRIES = [
    { id: "al", name: "Albania",        flag: "🇦🇱" },
    { id: "am", name: "Armenia",        flag: "🇦🇲" },
    { id: "au", name: "Australia",      flag: "🇦🇺" },
    { id: "at", name: "Austria",        flag: "🇦🇹", host: true },
    { id: "az", name: "Azerbaijan",     flag: "🇦🇿" },
    { id: "be", name: "Belgium",        flag: "🇧🇪" },
    { id: "bg", name: "Bulgaria",       flag: "🇧🇬" },
    { id: "hr", name: "Croatia",        flag: "🇭🇷" },
    { id: "cy", name: "Cyprus",         flag: "🇨🇾" },
    { id: "cz", name: "Czechia",        flag: "🇨🇿" },
    { id: "dk", name: "Denmark",        flag: "🇩🇰" },
    { id: "ee", name: "Estonia",        flag: "🇪🇪" },
    { id: "fi", name: "Finland",        flag: "🇫🇮" },
    { id: "fr", name: "France",         flag: "🇫🇷" },
    { id: "ge", name: "Georgia",        flag: "🇬🇪" },
    { id: "de", name: "Germany",        flag: "🇩🇪" },
    { id: "gr", name: "Greece",         flag: "🇬🇷" },
    { id: "il", name: "Israel",         flag: "🇮🇱" },
    { id: "it", name: "Italy",          flag: "🇮🇹" },
    { id: "lv", name: "Latvia",         flag: "🇱🇻" },
    { id: "lt", name: "Lithuania",      flag: "🇱🇹" },
    { id: "lu", name: "Luxembourg",     flag: "🇱🇺" },
    { id: "mt", name: "Malta",          flag: "🇲🇹" },
    { id: "md", name: "Moldova",        flag: "🇲🇩" },
    { id: "me", name: "Montenegro",     flag: "🇲🇪" },
    { id: "no", name: "Norway",         flag: "🇳🇴" },
    { id: "pl", name: "Poland",         flag: "🇵🇱" },
    { id: "pt", name: "Portugal",       flag: "🇵🇹" },
    { id: "ro", name: "Romania",        flag: "🇷🇴" },
    { id: "sm", name: "San Marino",     flag: "🇸🇲" },
    { id: "rs", name: "Serbia",         flag: "🇷🇸" },
    { id: "se", name: "Sweden",         flag: "🇸🇪" },
    { id: "ch", name: "Switzerland",    flag: "🇨🇭" },
    { id: "ua", name: "Ukraine",        flag: "🇺🇦" },
    { id: "gb", name: "United Kingdom", flag: "🇬🇧" },
];

const POINT_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12];

/* ══════ State ══════ */
let _db       = null;
let _uid      = null;
let _roomId   = null;           // Firestore room doc ID
let _myScores = {};             // { countryId: pointValue|null }
let _members  = {};             // { uid: { name, scores } } — live from Firestore
let _unsub    = null;           // Firestore onSnapshot unsubscriber
let _savTimer = null;

/* ══════ Init ══════ */

export function initEurovision() {
    _renderUI();
    _bindUIEvents();
    _checkUrlRoom();
}

export async function initEurovisionUser(db, uid, displayName) {
    _db  = db;
    _uid = uid;

    // Restore room from localStorage
    const saved = localStorage.getItem("esc_room");
    if (saved) {
        await _joinRoom(saved, displayName);
    } else {
        _renderScoreGrid();
    }
}

/* ══════ URL room join ══════ */

function _checkUrlRoom() {
    const params = new URLSearchParams(window.location.search);
    const room   = params.get("esc_room");
    if (!room) return;
    // Will be handled once user is ready via initEurovisionUser
    localStorage.setItem("esc_room", room);
    // Clean URL
    const url = new URL(window.location.href);
    url.searchParams.delete("esc_room");
    history.replaceState({}, "", url.toString());
}

/* ══════ Room management ══════ */

async function _createRoom(displayName) {
    if (!_db || !_uid) return;
    const roomRef = doc(collection(_db, "esc_rooms"));
    _roomId = roomRef.id;
    localStorage.setItem("esc_room", _roomId);

    await setDoc(roomRef, {
        created: serverTimestamp(),
        members: {
            [_uid]: { name: displayName || "You", scores: _myScores, joinedAt: Date.now() }
        }
    });

    _subscribeRoom();
    _updateRoomUI();
}

async function _joinRoom(roomId, displayName) {
    if (!_db || !_uid) return;
    _roomId = roomId;

    const ref     = doc(_db, "esc_rooms", roomId);
    const snap    = await getDoc(ref).catch(() => null);
    if (!snap || !snap.exists()) {
        // Room gone — create new
        localStorage.removeItem("esc_room");
        _roomId = null;
        _renderScoreGrid();
        _showToast("Room not found — starting fresh.", "warn");
        return;
    }

    // Push our scores into the room
    const existing = snap.data().members?.[_uid]?.scores || {};
    _myScores = existing;

    await setDoc(ref, {
        members: { [_uid]: { name: displayName || "You", scores: _myScores, joinedAt: Date.now() } }
    }, { merge: true });

    _subscribeRoom();
    _updateRoomUI();
    _renderScoreGrid();
}

function _subscribeRoom() {
    if (_unsub) _unsub();
    if (!_roomId) return;
    const ref = doc(_db, "esc_rooms", _roomId);
    _unsub = onSnapshot(ref, snap => {
        if (!snap.exists()) return;
        _members = snap.data().members || {};
        _renderLeaderboard();
        _renderMembersBar();
    });
}

async function _leaveRoom() {
    if (_unsub) { _unsub(); _unsub = null; }
    _roomId  = null;
    _members = {};
    localStorage.removeItem("esc_room");
    _myScores = {};
    _renderScoreGrid();
    _updateRoomUI();
    _renderLeaderboard();
    _renderMembersBar();
}

async function _pushScores(displayName) {
    if (!_db || !_uid || !_roomId) return;
    const ref = doc(_db, "esc_rooms", _roomId);
    await setDoc(ref, {
        members: { [_uid]: { name: displayName || "Me", scores: _myScores, updatedAt: Date.now() } }
    }, { merge: true });
}

/* ══════ Score logic ══════ */

function _assignPoint(countryId, points) {
    // Toggle off if same value clicked
    if (_myScores[countryId] === points) {
        delete _myScores[countryId];
    } else {
        // Remove from country that previously had these points
        for (const [cid, pts] of Object.entries(_myScores)) {
            if (pts === points && cid !== countryId) delete _myScores[cid];
        }
        _myScores[countryId] = points;
    }
    _renderScoreGrid();
    _renderLeaderboard();
    _scheduleSave();
}

function _usedPoints() {
    return new Set(Object.values(_myScores));
}


function _computeAverages() {
    const allUids = Object.keys(_members);
    if (!allUids.length) return {};

    const sums   = {};
    const counts = {};
    for (const uid of allUids) {
        const scores = _members[uid]?.scores || {};
        for (const [cid, pts] of Object.entries(scores)) {
            sums[cid]   = (sums[cid]   || 0) + pts;
            counts[cid] = (counts[cid] || 0) + 1;
        }
    }

    const avgs = {};
    for (const cid of Object.keys(sums)) {
        avgs[cid] = sums[cid] / allUids.length;
    }
    return avgs;
}

function _scheduleSave() {
    clearTimeout(_savTimer);
    _savTimer = setTimeout(() => {
        _pushScores(_getDisplayName()).catch(() => {});
        _renderLeaderboard();
    }, 600);
}

function _getDisplayName() {
    return document.getElementById("esc-display-name")?.value?.trim() || "Me";
}

/* ══════ Render ══════ */

function _renderUI() {
    const container = document.getElementById("esc-app");
    if (!container) return;
    container.innerHTML = `
    <!-- HEADER -->
    <div class="esc-header">
        <div class="esc-header-left">
            <div class="esc-logo">
                <span class="esc-logo-star">★</span>
                <div>
                    <div class="esc-logo-title">Eurovision 2026</div>
                    <div class="esc-logo-sub">Point Tracker · Basel, Austria</div>
                </div>
            </div>
        </div>
        <div class="esc-header-right">
            <div class="esc-name-wrap">
                <input type="text" id="esc-display-name" class="esc-input esc-name-input" placeholder="Your name" maxlength="30" value="Me">
            </div>
            <div class="esc-room-info" id="esc-room-info">
                <span class="esc-room-badge" id="esc-room-badge" style="display:none"></span>
                <button class="esc-btn esc-btn-share" id="esc-btn-share">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                    Share Room
                </button>
                <button class="esc-btn esc-btn-leave" id="esc-btn-leave" style="display:none">Leave Room</button>
            </div>
        </div>
    </div>

    <!-- MEMBERS BAR -->
    <div class="esc-members-bar" id="esc-members-bar" style="display:none"></div>

    <!-- PROGRESS -->
    <div class="esc-progress-wrap" id="esc-progress-wrap">
        <div class="esc-progress-label">
            <span id="esc-progress-count">0 / 10 points assigned</span>
            <span class="esc-progress-hint">Assign all 10 ranks to complete your ballot</span>
        </div>
        <div class="esc-progress-bar"><div class="esc-progress-fill" id="esc-progress-fill"></div></div>
    </div>

    <!-- MAIN LAYOUT -->
    <div class="esc-layout">
        <!-- SCORE GRID -->
        <div class="esc-grid-wrap">
            <div class="esc-section-label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                Your Ballot
            </div>
            <div class="esc-grid" id="esc-score-grid"></div>
        </div>

        <!-- LEADERBOARD -->
        <div class="esc-leaderboard-wrap">
            <div class="esc-section-label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                Leaderboard
                <span class="esc-lb-mode-toggle" id="esc-lb-mode">My Votes</span>
            </div>
            <div class="esc-leaderboard" id="esc-leaderboard"></div>
        </div>
    </div>

    <!-- SHARE MODAL -->
    <div class="esc-modal-backdrop" id="esc-modal-backdrop">
        <div class="esc-modal">
            <div class="esc-modal-header">
                <span>Share Your Room</span>
                <button class="esc-modal-close" id="esc-modal-close">✕</button>
            </div>
            <p class="esc-modal-desc">Invite friends to join your scoring session. Their votes will be averaged with yours in real time.</p>
            <div class="esc-modal-row">
                <div class="esc-modal-label">Room Code</div>
                <div class="esc-copy-row">
                    <input type="text" class="esc-input esc-copy-input" id="esc-room-code-input" readonly>
                    <button class="esc-btn esc-btn-copy" id="esc-btn-copy-code">Copy Code</button>
                </div>
            </div>
            <div class="esc-modal-row">
                <div class="esc-modal-label">Share Link</div>
                <div class="esc-copy-row">
                    <input type="text" class="esc-input esc-copy-input" id="esc-share-link-input" readonly>
                    <button class="esc-btn esc-btn-copy" id="esc-btn-copy-link">Copy Link</button>
                </div>
            </div>
            <div class="esc-modal-divider">— or join an existing room —</div>
            <div class="esc-copy-row">
                <input type="text" class="esc-input esc-copy-input" id="esc-join-code-input" placeholder="Paste room code here…">
                <button class="esc-btn esc-btn-share" id="esc-btn-join-room">Join</button>
            </div>
        </div>
    </div>
    `;
}

function _renderScoreGrid() {
    const grid = document.getElementById("esc-score-grid");
    if (!grid) return;

    const used = _usedPoints();

    grid.innerHTML = COUNTRIES.map(c => {
        const myPts = _myScores[c.id] ?? null;
        const hasScore = myPts !== null;

        const ptBtns = POINT_VALUES.map(pv => {
            const isAssigned = myPts === pv;
            const isUsed     = used.has(pv) && !isAssigned;
            return `<button class="esc-pt-btn${isAssigned ? " esc-pt-btn--active" : ""}${isUsed ? " esc-pt-btn--used" : ""}"
                            data-country="${c.id}" data-pts="${pv}">${pv}</button>`;
        }).join("");

        return `
        <div class="esc-country-card${hasScore ? " esc-country-card--scored" : ""}${c.host ? " esc-country-card--host" : ""}" data-id="${c.id}">
            <div class="esc-country-info">
                <span class="esc-flag">${c.flag}</span>
                <span class="esc-country-name">${c.name}${c.host ? ' <span class="esc-host-badge">HOST</span>' : ""}</span>
                ${hasScore ? `<span class="esc-country-pts-badge">${myPts} pts</span>` : ""}
            </div>
            <div class="esc-pt-row">${ptBtns}</div>
        </div>`;
    }).join("");

    _updateProgress();
}

function _updateProgress() {
    const count = Object.keys(_myScores).length;
    const pct   = (count / 10) * 100;
    const fillEl = document.getElementById("esc-progress-fill");
    const lblEl  = document.getElementById("esc-progress-count");
    if (fillEl) fillEl.style.width = pct + "%";
    if (lblEl)  lblEl.textContent = `${count} / 10 points assigned`;
}

function _renderLeaderboard() {
    const lb   = document.getElementById("esc-leaderboard");
    if (!lb) return;

    const isGroupMode = Object.keys(_members).length > 1;
    const modeBtn     = document.getElementById("esc-lb-mode");
    if (modeBtn) {
        modeBtn.textContent = isGroupMode ? "Group Avg" : "My Votes";
        modeBtn.classList.toggle("esc-lb-mode--group", isGroupMode);
    }

    let scores;
    if (isGroupMode) {
        scores = _computeAverages();
    } else {
        scores = { ..._myScores };
    }

    const sorted = COUNTRIES
        .map(c => ({ ...c, pts: scores[c.id] ?? 0 }))
        .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));

    if (!sorted.some(c => c.pts > 0)) {
        lb.innerHTML = `<div class="esc-lb-empty">No points assigned yet<br><span>Start voting on the left</span></div>`;
        return;
    }

    let rank = 0, lastPts = -1;
    lb.innerHTML = sorted.filter(c => c.pts > 0).map((c, i) => {
        if (c.pts !== lastPts) { rank = i + 1; lastPts = c.pts; }
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}.`;
        const barPct = (c.pts / 12) * 100;
        const myPts  = _myScores[c.id] ?? 0;
        return `
        <div class="esc-lb-row${rank <= 3 ? " esc-lb-row--top" : ""}">
            <span class="esc-lb-rank">${medal}</span>
            <span class="esc-lb-flag">${c.flag}</span>
            <span class="esc-lb-name">${c.name}</span>
            ${isGroupMode && myPts ? `<span class="esc-lb-my-pts">You: ${myPts}</span>` : ""}
            <div class="esc-lb-bar-wrap">
                <div class="esc-lb-bar" style="width:${barPct}%"></div>
            </div>
            <span class="esc-lb-pts">${Number.isInteger(c.pts) ? c.pts : c.pts.toFixed(1)}</span>
        </div>`;
    }).join("");
}

function _renderMembersBar() {
    const bar = document.getElementById("esc-members-bar");
    if (!bar) return;

    const uids = Object.keys(_members);
    if (uids.length <= 1) { bar.style.display = "none"; return; }

    bar.style.display = "flex";
    bar.innerHTML = uids.map(uid => {
        const m       = _members[uid];
        const done    = Object.keys(m.scores || {}).length;
        const isMe    = uid === _uid;
        return `<div class="esc-member${isMe ? " esc-member--me" : ""}">
            <div class="esc-member-avatar">${(m.name || "?")[0].toUpperCase()}</div>
            <div class="esc-member-info">
                <div class="esc-member-name">${m.name || "Anonymous"}${isMe ? " (you)" : ""}</div>
                <div class="esc-member-done">${done}/10 votes</div>
            </div>
        </div>`;
    }).join("");
}

function _updateRoomUI() {
    const badge   = document.getElementById("esc-room-badge");
    const shareBtn = document.getElementById("esc-btn-share");
    const leaveBtn = document.getElementById("esc-btn-leave");

    if (_roomId) {
        if (badge) {
            badge.style.display = "";
            badge.textContent = `Room: ${_roomId.slice(0, 6).toUpperCase()}`;
        }
        if (shareBtn) shareBtn.textContent = "Invite";
        if (leaveBtn) leaveBtn.style.display = "";
    } else {
        if (badge) badge.style.display = "none";
        if (shareBtn) shareBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Share Room`;
        if (leaveBtn) leaveBtn.style.display = "none";
    }
}

/* ══════ Events ══════ */

function _bindUIEvents() {
    // Point button clicks (delegated)
    document.addEventListener("click", e => {
        const ptBtn = e.target.closest(".esc-pt-btn");
        if (ptBtn && ptBtn.closest("#app-sheet")) {
            _assignPoint(ptBtn.dataset.country, parseInt(ptBtn.dataset.pts, 10));
        }

        // Share / modal
        if (e.target.closest("#esc-btn-share")) _openShareModal();
        if (e.target.closest("#esc-modal-close") || e.target.matches("#esc-modal-backdrop")) {
            if (!e.target.closest(".esc-modal") || e.target.matches("#esc-modal-backdrop")) _closeShareModal();
        }
        if (e.target.closest("#esc-btn-copy-code")) _copyText(document.getElementById("esc-room-code-input")?.value);
        if (e.target.closest("#esc-btn-copy-link")) _copyText(document.getElementById("esc-share-link-input")?.value);

        if (e.target.closest("#esc-btn-join-room")) {
            const code = document.getElementById("esc-join-code-input")?.value?.trim();
            if (code) { _closeShareModal(); _joinRoom(code, _getDisplayName()); }
        }

        if (e.target.closest("#esc-btn-leave")) {
            if (confirm("Leave this room? Your local votes will be cleared.")) _leaveRoom();
        }
    });

    // Name change
    document.addEventListener("change", e => {
        if (e.target.id === "esc-display-name" && _roomId) {
            _pushScores(e.target.value.trim()).catch(() => {});
        }
    });
}

function _openShareModal() {
    const backdrop = document.getElementById("esc-modal-backdrop");
    if (!backdrop) return;

    // Ensure room exists
    if (!_roomId) {
        _createRoom(_getDisplayName()).then(() => _populateModal());
    } else {
        _populateModal();
    }
    backdrop.classList.add("esc-modal-backdrop--open");
}

function _populateModal() {
    const codeIn  = document.getElementById("esc-room-code-input");
    const linkIn  = document.getElementById("esc-share-link-input");
    if (codeIn) codeIn.value = _roomId || "";
    if (linkIn) {
        const url = new URL(window.location.href);
        url.searchParams.set("esc_room", _roomId || "");
        linkIn.value = url.toString();
    }
    _updateRoomUI();
}

function _closeShareModal() {
    document.getElementById("esc-modal-backdrop")?.classList.remove("esc-modal-backdrop--open");
}

function _copyText(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => _showToast("Copied!", "ok")).catch(() => {});
}

function _showToast(msg, type = "ok") {
    const existing = document.getElementById("esc-toast");
    if (existing) existing.remove();
    const t = document.createElement("div");
    t.id = "esc-toast";
    t.className = `esc-toast esc-toast--${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("esc-toast--show"));
    setTimeout(() => { t.classList.remove("esc-toast--show"); setTimeout(() => t.remove(), 300); }, 2500);
}
