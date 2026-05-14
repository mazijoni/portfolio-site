/**
 * eurovision.js — Eurovision 2026 Point Tracker
 * Two tabs: All Countries (35) + Grand Final (qualified finalists, synced via room)
 * Separate ballots per tab. Finalist list managed per-room in Firestore.
 */

import {
    doc, setDoc, getDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

export const COUNTRIES = [
    { id: "al", name: "Albania",        flag: "🇦🇱" },
    { id: "am", name: "Armenia",        flag: "🇦🇲" },
    { id: "au", name: "Australia",      flag: "🇦🇺" },
    { id: "at", name: "Austria",        flag: "🇦🇹", auto: true },
    { id: "az", name: "Azerbaijan",     flag: "🇦🇿" },
    { id: "be", name: "Belgium",        flag: "🇧🇪" },
    { id: "bg", name: "Bulgaria",       flag: "🇧🇬" },
    { id: "hr", name: "Croatia",        flag: "🇭🇷" },
    { id: "cy", name: "Cyprus",         flag: "🇨🇾" },
    { id: "cz", name: "Czechia",        flag: "🇨🇿" },
    { id: "dk", name: "Denmark",        flag: "🇩🇰" },
    { id: "ee", name: "Estonia",        flag: "🇪🇪" },
    { id: "fi", name: "Finland",        flag: "🇫🇮" },
    { id: "fr", name: "France",         flag: "🇫🇷", auto: true },
    { id: "ge", name: "Georgia",        flag: "🇬🇪" },
    { id: "de", name: "Germany",        flag: "🇩🇪", auto: true },
    { id: "gr", name: "Greece",         flag: "🇬🇷" },
    { id: "il", name: "Israel",         flag: "🇮🇱" },
    { id: "it", name: "Italy",          flag: "🇮🇹", auto: true },
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
    { id: "gb", name: "United Kingdom", flag: "🇬🇧", auto: true },
];

const POINT_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12];
const AUTO_IDS     = COUNTRIES.filter(c => c.auto).map(c => c.id);

/* ══════ State ══════ */
let _db        = null;
let _uid       = null;
let _roomId    = null;
let _scores    = { all: {}, finals: {} };
let _finalists = new Set(AUTO_IDS);
let _activeTab = "all";
let _lbSource  = "all"; // which scoring tab the leaderboard mirrors
let _members   = {};
let _myPhotoURL = "";
let _unsub     = null;
let _savTimer  = null;
let _userSavTimer = null;

/* ══════ SVG constants ══════ */
const ESC_SVG = `<svg class="esc-logo-svg" viewBox="0 0 226.683 233.658" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="escGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#009FE3"/><stop offset="100%" stop-color="#E4007C"/></linearGradient></defs><path fill="url(#escGrad)" d="M 99.722 231.541 C 101.585 233.574 104.305 233.076 105.56 230.435 C 135.35 167.569 225.843 139.135 225.843 59.033 C 225.843 29.922 206.246 0.69 168.566 0.013 C 132.699 -0.635 100.509 22.469 97.152 59.87 C 96.145 36.188 80.613 25.269 62.7 25.269 C 27.461 25.269 -1.402 57.081 0.053 104.952 C 2.474 180.242 74.855 203.964 99.722 231.541 Z M 93.326 77.913 C 94.282 81.669 98.865 81.54 99.901 77.823 C 115.414 21.593 186.748 15.446 186.748 72.384 C 186.748 117.336 107.075 165.298 101.007 207.969 C 86.591 179.973 33.638 164.6 33.638 103.747 C 33.638 51.96 83.991 41.08 93.326 77.913 Z"/></svg>`;
const FIN_SVG = `<svg viewBox="0 0 226.683 233.658" xmlns="http://www.w3.org/2000/svg"><path d="M 99.722 231.541 C 101.585 233.574 104.305 233.076 105.56 230.435 C 135.35 167.569 225.843 139.135 225.843 59.033 C 225.843 29.922 206.246 0.69 168.566 0.013 C 132.699 -0.635 100.509 22.469 97.152 59.87 C 96.145 36.188 80.613 25.269 62.7 25.269 C 27.461 25.269 -1.402 57.081 0.053 104.952 C 2.474 180.242 74.855 203.964 99.722 231.541 Z M 93.326 77.913 C 94.282 81.669 98.865 81.54 99.901 77.823 C 115.414 21.593 186.748 15.446 186.748 72.384 C 186.748 117.336 107.075 165.298 101.007 207.969 C 86.591 179.973 33.638 164.6 33.638 103.747 C 33.638 51.96 83.991 41.08 93.326 77.913 Z"/></svg>`;

/* ══════ Helpers ══════ */
const _s  = ()  => _scores[_activeTab];
const _cs = (id, v) => { _scores[_activeTab][id] = v; };
const _ds = id  => { delete _scores[_activeTab][id]; };

/* ══════ Init ══════ */
export function initEurovision() {
    _renderShell();
    _bindEvents();
    _checkUrlRoom();
}

export async function initEurovisionUser(db, uid, displayName, photoURL) {
    _db          = db;
    _uid         = uid;
    _myPhotoURL  = photoURL || "";
    const firstName = (displayName || '').split(' ')[0] || displayName || 'Guest';
    // Load local first as fast fallback, then overwrite with Firestore personal ballot
    _loadLocal();
    await _loadUserBallot();
    const saved = localStorage.getItem("esc_room");
    if (saved) {
        await _joinRoom(saved, firstName);
    } else {
        _renderGrid();
        _renderLeaderboard();
    }
    const ni = document.getElementById("esc-display-name");
    if (ni) ni.value = firstName;
}

/* ══════ URL ══════ */
function _checkUrlRoom() {
    const p = new URLSearchParams(window.location.search);
    const r = p.get("esc_room");
    if (!r) return;
    localStorage.setItem("esc_room", r);
    const u = new URL(window.location.href);
    u.searchParams.delete("esc_room");
    history.replaceState({}, "", u.toString());
}

/* ══════ User ballot (Firestore) ══════ */
async function _loadUserBallot() {
    if (!_db || !_uid) return;
    try {
        const snap = await getDoc(doc(_db, "esc_users", _uid));
        if (!snap.exists()) return;
        const d = snap.data();
        if (d.scores)    _scores    = { all: d.scores.all || {}, finals: d.scores.finals || {} };
        if (d.finalists) _finalists = new Set(d.finalists);
        _saveLocal(); // keep localStorage in sync
    } catch {}
}

function _scheduleUserSave() {
    if (!_db || !_uid) return;
    clearTimeout(_userSavTimer);
    _userSavTimer = setTimeout(async () => {
        try {
            await setDoc(doc(_db, "esc_users", _uid), {
                scores:    _scores,
                finalists: Array.from(_finalists),
                updatedAt: serverTimestamp()
            }, { merge: true });
        } catch {}
    }, 800);
}

/* ══════ Room history ══════ */
const HISTORY_KEY = "esc_room_history";
const HISTORY_MAX = 8;

function _saveRoomHistory(code, memberNames) {
    try {
        let hist = _loadRoomHistory();
        hist = hist.filter(r => r.code !== code);
        hist.unshift({ code, names: memberNames || [], ts: Date.now() });
        if (hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    } catch {}
}

function _loadRoomHistory() {
    try {
        return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch { return []; }
}

function _removeFromHistory(code) {
    try {
        const hist = _loadRoomHistory().filter(r => r.code !== code);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    } catch {}
}

/* ══════ Local persistence ══════ */
const LOCAL_KEY = "esc_ballot_v1";

function _saveLocal() {
    try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify({
            scores:    _scores,
            finalists: Array.from(_finalists)
        }));
    } catch {}
}

function _loadLocal() {
    try {
        const raw = localStorage.getItem(LOCAL_KEY);
        if (!raw) return;
        const d = JSON.parse(raw);
        if (d.scores)    _scores    = { all: d.scores.all || {}, finals: d.scores.finals || {} };
        if (d.finalists) _finalists = new Set(d.finalists);
    } catch {}
}


function _genCode() {
    // 6-char code, no ambiguous chars (0/O, 1/I)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/* Flag image helper — uses flagcdn.com with emoji fallback */
const _flagImg = (id, name, size = '20x15') =>
    `<img class="esc-flag-img" src="https://flagcdn.com/${size}/${id}.png" alt="${name}" loading="lazy">`;

/* ══════ Room ══════ */
async function _createRoom(name) {
    if (!_db || !_uid) return;
    const code = _genCode();
    const ref  = doc(_db, "esc_rooms", code);
    _roomId = code;
    localStorage.setItem("esc_room", _roomId);
    await setDoc(ref, {
        created: serverTimestamp(),
        finalists: Array.from(_finalists),
        members: { [_uid]: { name, photoURL: _myPhotoURL, scores: _scores, joinedAt: Date.now() } }
    });
    _subscribeRoom();
    _updateRoomUI();
    _saveRoomHistory(code, [_getName()]);
}

async function _joinRoom(roomId, name) {
    if (!_db || !_uid) return;
    _roomId = roomId;
    const ref  = doc(_db, "esc_rooms", roomId);
    const snap = await getDoc(ref).catch(() => null);
    if (!snap?.exists()) {
        localStorage.removeItem("esc_room");
        _roomId = null;
        _showToast("Room not found — starting fresh.", "warn");
        _renderGrid(); _renderLeaderboard();
        return;
    }
    const data = snap.data();
    if (data.finalists) {
        _finalists = new Set(data.finalists);
        _saveLocal(); // keep finalists in sync locally
    }
    // Push OUR local scores into the room — never pull room scores over ours
    await setDoc(ref, {
        members: { [_uid]: { name, photoURL: _myPhotoURL, scores: _scores, joinedAt: Date.now() } }
    }, { merge: true });
    _subscribeRoom();
    _updateRoomUI();
    _renderGrid();
    _renderLeaderboard();
    const names = Object.values(data.members || {}).map(m => m.name).filter(Boolean);
    _saveRoomHistory(roomId, names);
}

function _subscribeRoom() {
    if (_unsub) _unsub();
    if (!_roomId) return;
    const ref = doc(_db, "esc_rooms", _roomId);
    _unsub = onSnapshot(ref, snap => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.finalists) {
            _finalists = new Set(data.finalists);
            _renderTabBar();
            _renderGrid();
        }
        _members = data.members || {};
        _renderLeaderboard();
        _renderMembersBar();
    });
}

async function _leaveRoom() {
    if (_unsub) { _unsub(); _unsub = null; }
    _roomId  = null;
    _members = {};
    localStorage.removeItem("esc_room");
    // Scores and finalists are KEPT — user's ballot is personal
    _renderTabBar(); _renderGrid(); _updateRoomUI(); _renderLeaderboard(); _renderMembersBar();
}

async function _pushScores(name) {
    if (!_db || !_uid) return;
    // Always keep the personal user doc up to date
    _scheduleUserSave();
    // Also sync into the room if in one
    if (!_roomId) return;
    await setDoc(doc(_db, "esc_rooms", _roomId), {
        members: { [_uid]: { name, scores: _scores, photoURL: _myPhotoURL, updatedAt: Date.now() } }
    }, { merge: true });
}

async function _pushFinalists() {
    if (!_db || !_uid || !_roomId) return;
    await setDoc(doc(_db, "esc_rooms", _roomId), {
        finalists: Array.from(_finalists)
    }, { merge: true });
}

function _scheduleSave() {
    clearTimeout(_savTimer);
    _savTimer = setTimeout(() => {
        _pushScores(_getName()).catch(() => {});
    }, 600);
}

function _getName() {
    return document.getElementById("esc-display-name")?.value?.trim() || "Me";
}

/* ══════ Score logic ══════ */
function _assign(countryId, pts) {
    if (_s()[countryId] === pts) {
        _ds(countryId);
    } else {
        _cs(countryId, pts);
    }
    _saveLocal();
    _scheduleUserSave(); // persist to account across rooms/devices
    _renderGrid();
    _renderLeaderboard();
    _scheduleSave();    // also sync to room if in one
}

function _toggleFinalist(id) {
    if (_finalists.has(id)) {
        const c = COUNTRIES.find(x => x.id === id);
        if (c?.auto) { _showToast("Auto-qualifiers can't be removed.", "warn"); return; }
        _finalists.delete(id);
        delete _scores.finals[id];
    } else {
        _finalists.add(id);
    }
    _saveLocal();
    _scheduleUserSave(); // persist to account
    _renderTabBar();
    _renderGrid();
    _renderLeaderboard();
    if (_roomId) _pushFinalists().catch(() => {});
}

/* ══════ Average ══════ */
function _averages() {
    const uids = Object.keys(_members);
    if (!uids.length) return {};
    const sums = {}, cnt = {};
    const lbTab = _resolveLbTab();
    for (const uid of uids) {
        const sc = _members[uid]?.scores?.[lbTab] || {};
        for (const [cid, pts] of Object.entries(sc)) {
            sums[cid] = (sums[cid] || 0) + pts;
            cnt[cid]  = (cnt[cid]  || 0) + 1;
        }
    }
    const out = {};
    for (const cid of Object.keys(sums)) out[cid] = sums[cid] / cnt[cid];
    return out;
}

/* Resolve which scoring tab to use for the leaderboard.
   Prefers _lbSource but falls back to whichever ballot has votes. */
function _resolveLbTab() {
    const preferred = _activeTab === "leaderboard" ? _lbSource : _activeTab;
    if (preferred === "leaderboard") return "all";
    const hasVotes = (tab) => {
        if (Object.keys(_scores[tab] || {}).length > 0) return true;
        return Object.values(_members).some(m => Object.keys(m.scores?.[tab] || {}).length > 0);
    };
    if (hasVotes(preferred)) return preferred;
    const other = preferred === "all" ? "finals" : "all";
    return hasVotes(other) ? other : preferred;
}

function _renderShell() {
    const el = document.getElementById("esc-app");
    if (!el) return;
    el.innerHTML = `
    <div class="esc-header">
        <div class="esc-header-left">
            <div class="esc-logo">
                ${ESC_SVG}
                <div>
                    <div class="esc-logo-title">Eurovision 2026</div>
                    <div class="esc-logo-sub">Point Tracker · Vienna, Austria</div>
                </div>
            </div>
        </div>
        <div class="esc-header-right">
            <input type="text" id="esc-display-name" class="esc-input esc-name-input" placeholder="Your name" maxlength="30" value="Me">
            <span class="esc-room-badge" id="esc-room-badge" style="display:none"></span>
            <button class="esc-btn esc-btn-share" id="esc-btn-share">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                Share Room
            </button>
            <button class="esc-btn esc-btn-leave" id="esc-btn-leave" style="display:none">Leave Room</button>
        </div>
    </div>

    <div class="esc-members-bar" id="esc-members-bar" style="display:none"></div>

    <div class="esc-tab-bar" id="esc-tab-bar"></div>

    <div class="esc-progress-wrap">
        <div class="esc-progress-label">
            <span id="esc-progress-count">0 countries scored</span>
        </div>
        <div class="esc-progress-bar"><div class="esc-progress-fill" id="esc-progress-fill"></div></div>
    </div>

    <div class="esc-layout" id="esc-layout">
        <div class="esc-grid-wrap">
            <div class="esc-section-label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                <span id="esc-grid-label">Your Ballot</span>
            </div>
            <div class="esc-grid" id="esc-score-grid"></div>
        </div>
        <div class="esc-leaderboard-wrap">
            <div class="esc-section-label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                Leaderboard
                <span class="esc-lb-mode-toggle" id="esc-lb-mode">My Votes</span>
            </div>
            <div class="esc-leaderboard" id="esc-leaderboard"></div>
        </div>
    </div>

    <div class="esc-modal-backdrop" id="esc-modal-backdrop">
        <div class="esc-modal">
            <div class="esc-modal-header">
                <span>Share Your Room</span>
                <button class="esc-modal-close" id="esc-modal-close">✕</button>
            </div>
            <p class="esc-modal-desc">Invite friends to join. Their votes will be averaged with yours in real time.</p>
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
                <input type="text" class="esc-input esc-copy-input" id="esc-join-code-input" placeholder="Paste room code…">
                <button class="esc-btn esc-btn-share" id="esc-btn-join-room">Join</button>
            </div>
            <div id="esc-room-history-wrap"></div>
        </div>
    </div>`;

    _renderTabBar();
    _renderGrid();
    _renderLeaderboard();
}

function _renderTabBar() {
    const bar = document.getElementById("esc-tab-bar");
    if (!bar) return;
    const fc = _finalists.size;
    bar.innerHTML = `
        <button class="esc-tab${_activeTab === "all" ? " esc-tab--active" : ""}" data-tab="all">
            All Countries <span class="esc-tab-count">35</span>
        </button>
        <button class="esc-tab${_activeTab === "finals" ? " esc-tab--active" : ""}" data-tab="finals">
            Grand Final <span class="esc-tab-count">${fc}</span>
        </button>
        <button class="esc-tab${_activeTab === "leaderboard" ? " esc-tab--active" : ""}" data-tab="leaderboard">
            Leaderboard
        </button>`;
    document.getElementById("esc-layout")?.classList.toggle("esc-layout--lb-tab", _activeTab === "leaderboard");
    const progressWrap = document.querySelector(".esc-progress-wrap");
    if (progressWrap) progressWrap.style.display = _activeTab === "leaderboard" ? "none" : "";
}

function _renderGrid() {
    const grid  = document.getElementById("esc-score-grid");
    const label = document.getElementById("esc-grid-label");
    if (!grid) return;

    if (_activeTab === "leaderboard") {
        grid.innerHTML = "";
        return;
    }

    const list = _activeTab === "finals"
        ? COUNTRIES.filter(c => _finalists.has(c.id))
        : COUNTRIES;

    if (label) label.textContent = _activeTab === "finals" ? "Grand Final Ballot" : "Your Ballot — All Countries";

    if (_activeTab === "finals" && list.length === 0) {
        grid.innerHTML = `<div class="esc-lb-empty">No finalists yet<br><span>Switch to All Countries and click ★ to add</span></div>`;
        _updateProgress();
        return;
    }

    const sc = _s();
    grid.innerHTML = list.map(c => {
        const myPts    = sc[c.id] ?? null;
        const hasScore = myPts !== null;
        const inFinals = _finalists.has(c.id);

        const ptBtns = POINT_VALUES.map(pv => {
            const isAssigned = myPts === pv;
            return `<button class="esc-pt-btn${isAssigned ? " esc-pt-btn--active" : ""}"
                data-country="${c.id}" data-pts="${pv}">${pv}</button>`;
        }).join("");

        const starCls = inFinals ? "esc-finalist-btn esc-finalist-btn--on" : "esc-finalist-btn";
        const starTip = inFinals ? "In Grand Final — click to remove" : "Add to Grand Final";
        const autoTag = c.auto ? ` <span class="esc-host-badge">AUTO</span>` : "";

        return `
        <div class="esc-country-card${hasScore ? " esc-country-card--scored" : ""}${inFinals && _activeTab === "all" ? " esc-country-card--finalist" : ""}">
            <div class="esc-country-info">
                ${_flagImg(c.id, c.name)}
                <span class="esc-country-name">${c.name}${autoTag}</span>
                ${hasScore ? `<span class="esc-country-pts-badge">${myPts} pts</span>` : ""}
                <button class="${starCls}" data-finalist="${c.id}" title="${starTip}">${FIN_SVG}</button>
            </div>
            <div class="esc-pt-row">${ptBtns}</div>
        </div>`;
    }).join("");

    _updateProgress();
}

function _updateProgress() {
    const count  = Object.keys(_s()).length;
    const total  = (_activeTab === 'finals' ? _finalists.size : 35);
    const pct    = total > 0 ? Math.min((count / total) * 100, 100) : 0;
    const fillEl = document.getElementById("esc-progress-fill");
    const lblEl  = document.getElementById("esc-progress-count");
    if (fillEl) fillEl.style.width = pct + "%";
    if (lblEl)  lblEl.textContent  = `${count} ${count === 1 ? 'country' : 'countries'} scored`;
}

function _renderLeaderboard() {
    const lb = document.getElementById("esc-leaderboard");
    if (!lb) return;

    const lbTab  = _resolveLbTab();
    const isGroup = Object.keys(_members).length > 1;
    const modeBtn = document.getElementById("esc-lb-mode");
    if (modeBtn) {
        modeBtn.textContent = isGroup ? "Group Avg" : "My Votes";
        modeBtn.classList.toggle("esc-lb-mode--group", isGroup);
    }

    const scores = isGroup ? _averages() : { ...(_scores[lbTab] || {}) };
    const list   = lbTab === "finals"
        ? COUNTRIES.filter(c => _finalists.has(c.id))
        : COUNTRIES;

    const sorted = list
        .map(c => ({ ...c, pts: scores[c.id] ?? 0 }))
        .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));

    if (!sorted.some(c => c.pts > 0)) {
        const hint = _activeTab === "leaderboard" ? "Switch to Grand Final to start voting" : "Start voting on the left";
        lb.innerHTML = `<div class="esc-lb-empty">No points assigned yet<br><span>${hint}</span></div>`;
        return;
    }

    let rank = 0, lastPts = -1;
    lb.innerHTML = sorted.filter(c => c.pts > 0).map((c, i) => {
        if (c.pts !== lastPts) { rank = i + 1; lastPts = c.pts; }
        const rankCls = rank === 1 ? 'esc-rank-gold' : rank === 2 ? 'esc-rank-silver' : rank === 3 ? 'esc-rank-bronze' : '';
        const rankHtml = rank <= 3
            ? `<span class="material-symbols-outlined esc-lb-rank ${rankCls}">workspace_premium</span>`
            : `<span class="esc-lb-rank esc-rank-num">${rank}</span>`;
        const barPct = (c.pts / 12) * 100;
        const myPts  = (_scores[lbTab] ?? {})[c.id] ?? 0;
        return `
        <div class="esc-lb-row${rank <= 3 ? " esc-lb-row--top" : ""}">
            ${rankHtml}
            <span class="esc-lb-flag">${_flagImg(c.id, c.name)}</span>
            <span class="esc-lb-name">${c.name}</span>
            ${isGroup && myPts ? `<span class="esc-lb-my-pts">You: ${myPts}</span>` : ""}
            <div class="esc-lb-bar-wrap"><div class="esc-lb-bar" style="width:${barPct}%"></div></div>
            <span class="esc-lb-pts">${Number.isInteger(c.pts) ? c.pts : c.pts.toFixed(1)}</span>
        </div>`;
    }).join("");
}

function _renderMembersBar() {
    const bar  = document.getElementById("esc-members-bar");
    if (!bar) return;
    const uids = Object.keys(_members);
    if (uids.length <= 1) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    bar.innerHTML = uids.map(uid => {
        const m    = _members[uid];
        const mbTab = _resolveLbTab();
        const done = Object.keys(m.scores?.[mbTab] || {}).length;
        const isMe = uid === _uid;
        const photo = m.photoURL || (isMe ? _myPhotoURL : "");
        const avatarHtml = photo
            ? `<img class="esc-member-avatar esc-member-avatar-img" src="${photo}" alt="${m.name}">`
            : `<div class="esc-member-avatar">${(m.name || "?")[0].toUpperCase()}</div>`;
        return `<div class="esc-member${isMe ? " esc-member--me" : ""}">
            ${avatarHtml}
            <div class="esc-member-info">
                <div class="esc-member-name">${m.name || "Anonymous"}${isMe ? " (you)" : ""}</div>
                <div class="esc-member-done">${done} voted</div>
            </div>
        </div>`;
    }).join("");
}

function _updateRoomUI() {
    const badge    = document.getElementById("esc-room-badge");
    const shareBtn = document.getElementById("esc-btn-share");
    const leaveBtn = document.getElementById("esc-btn-leave");
    if (_roomId) {
        if (badge)    { badge.style.display = ""; badge.textContent = `Room: ${_roomId}`; }
        if (shareBtn) shareBtn.textContent = "Invite";
        if (leaveBtn) leaveBtn.style.display = "";
    } else {
        if (badge)    badge.style.display = "none";
        if (shareBtn) shareBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Share Room`;
        if (leaveBtn) leaveBtn.style.display = "none";
    }
}

/* ══════ Events ══════ */
function _bindEvents() {
    document.addEventListener("click", e => {
        // Tab switch
        const tab = e.target.closest(".esc-tab");
        if (tab?.dataset.tab) {
            if (tab.dataset.tab !== "leaderboard") _lbSource = tab.dataset.tab;
            _activeTab = tab.dataset.tab;
            _renderTabBar();
            _renderGrid();
            _renderLeaderboard();
            _renderMembersBar();
            return;
        }

        // Point button
        const ptBtn = e.target.closest(".esc-pt-btn");
        if (ptBtn) {
            _assign(ptBtn.dataset.country, parseInt(ptBtn.dataset.pts, 10));
            return;
        }

        // Finalist toggle
        const fBtn = e.target.closest(".esc-finalist-btn");
        if (fBtn) { _toggleFinalist(fBtn.dataset.finalist); return; }

        // Share modal
        if (e.target.closest("#esc-btn-share")) { _openShareModal(); return; }
        if (e.target.closest("#esc-modal-close") || e.target.id === "esc-modal-backdrop") {
            _closeShareModal(); return;
        }
        if (e.target.closest("#esc-btn-copy-code")) { _copyText(document.getElementById("esc-room-code-input")?.value); return; }
        if (e.target.closest("#esc-btn-copy-link")) { _copyText(document.getElementById("esc-share-link-input")?.value); return; }
        if (e.target.closest("#esc-btn-join-room")) {
            const code = document.getElementById("esc-join-code-input")?.value?.trim().toUpperCase();
            if (code) { _closeShareModal(); _joinRoom(code, _getName()); }
            return;
        }
        // Room history rejoin
        const rejoinBtn = e.target.closest(".esc-room-history-join");
        if (rejoinBtn) {
            const code = rejoinBtn.dataset.code;
            _closeShareModal();
            _joinRoom(code, _getName());
            return;
        }
        // Room history remove
        const removeBtn = e.target.closest(".esc-room-history-remove");
        if (removeBtn) {
            _removeFromHistory(removeBtn.dataset.remove);
            _renderRoomHistory();
            return;
        }
        if (e.target.closest("#esc-btn-leave")) {
            if (confirm("Leave room? Your local votes will be cleared.")) _leaveRoom();
        }
    });

    document.addEventListener("change", e => {
        if (e.target.id === "esc-display-name" && _roomId) {
            _pushScores(e.target.value.trim()).catch(() => {});
        }
    });
}

function _openShareModal() {
    const backdrop = document.getElementById("esc-modal-backdrop");
    if (!backdrop) return;
    if (!_roomId) {
        _createRoom(_getName()).then(() => _populateModal());
    } else {
        _populateModal();
    }
    backdrop.classList.add("esc-modal-backdrop--open");
}

function _populateModal() {
    const ci = document.getElementById("esc-room-code-input");
    const li = document.getElementById("esc-share-link-input");
    if (ci) ci.value = _roomId || "";
    if (li) {
        const u = new URL(window.location.href);
        u.searchParams.set("esc_room", _roomId || "");
        li.value = u.toString();
    }
    _updateRoomUI();
    _renderRoomHistory();
}

function _renderRoomHistory() {
    const wrap = document.getElementById("esc-room-history-wrap");
    if (!wrap) return;
    const hist = _loadRoomHistory();
    if (!hist.length) { wrap.innerHTML = ""; return; }
    const fmt = ts => {
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    };
    wrap.innerHTML = `
        <div class="esc-modal-label" style="margin-top:1rem">Recent Rooms</div>
        <ul class="esc-room-history-list">
            ${hist.map(r => {
                const active = r.code === _roomId;
                const names  = r.names.length ? r.names.slice(0, 3).join(", ") + (r.names.length > 3 ? " +" + (r.names.length - 3) : "") : "";
                return `<li class="esc-room-history-item${active ? " esc-room-history-item--active" : ""}">
                    <button class="esc-room-history-join" data-code="${r.code}" title="Rejoin ${r.code}">
                        <span class="esc-room-history-code">${r.code}</span>
                        ${names ? `<span class="esc-room-history-names">${names}</span>` : ""}
                        <span class="esc-room-history-date">${fmt(r.ts)}</span>
                    </button>
                    <button class="esc-room-history-remove" data-remove="${r.code}" title="Remove">✕</button>
                </li>`;
            }).join("")}
        </ul>`;
}

function _closeShareModal() {
    document.getElementById("esc-modal-backdrop")?.classList.remove("esc-modal-backdrop--open");
}

function _copyText(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => _showToast("Copied!", "ok")).catch(() => {});
}

function _showToast(msg, type = "ok") {
    const ex = document.getElementById("esc-toast");
    if (ex) ex.remove();
    const t = document.createElement("div");
    t.id = "esc-toast";
    t.className = `esc-toast esc-toast--${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("esc-toast--show"));
    setTimeout(() => { t.classList.remove("esc-toast--show"); setTimeout(() => t.remove(), 300); }, 2500);
}
