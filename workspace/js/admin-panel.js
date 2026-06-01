/**
 * admin-panel.js — Admin dashboard: user management, feature flags, links browser.
 *
 * Renders users table into #app-admin-users.
 * Injects a user-picker bar at the top of #app-links so admin can browse any
 * user's Link Gallery without modifying links.js.
 * Loaded only when the signed-in user is the admin.
 */

import {
    getDocs, getDoc, setDoc,
    collection, doc,
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { toast, escHtml }         from "./ui.js";
import { setLinksAdminOwner }     from "./apps/links.js";

/* ── Feature flag metadata (Material Symbols icon names, no emojis) ── */
const FEATURE_META = {
    links:     { label: "Link Gallery",  icon: "link" },
    gmail:     { label: "Gmail",         icon: "mail" },
    analytics: { label: "Analytics",     icon: "bar_chart" },
    bluemap:   { label: "ServerMap",      icon: "map" },
    sheet:     { label: "Sheet Viewer",  icon: "table_chart" },
};

const FEATURE_DEFAULTS = { links: true, gmail: true, analytics: true, bluemap: true, sheet: true };

/* ── Module state ── */
let _db       = null;
let _users    = [];
let _features = {};   // uid → { links, gmail, … }
let _stats    = {};   // uid → { projects, links }

/* Admin links-bar state */
let _linksOwnerId = null;   // uid of user being browsed (null = own links)

/* ── Init ── */
export function initAdminPanel(db) {
    _db = db;
    const root = document.getElementById("app-admin-users");
    if (!root) return;

    _buildUsersShell(root);
    _loadUsers();
}

/* ── Users panel shell ── */
function _buildUsersShell(root) {
    root.innerHTML = `
    <div class="adm-panel-wrap">
      <div class="adm-toolbar">
        <span class="adm-toolbar-title">All Users</span>
        <input type="text" id="adm-user-search" class="adm-search-input" placeholder="Search by name or email…" autocomplete="off">
        <button id="adm-refresh-btn" class="ws-btn ws-btn-ghost ws-btn-sm">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Refresh
        </button>
      </div>
      <div id="adm-users-list" class="adm-users-list">
        <div class="ws-placeholder">Loading users…</div>
      </div>
    </div>`;

    document.getElementById("adm-refresh-btn")?.addEventListener("click", _loadUsers);
    document.getElementById("adm-user-search")?.addEventListener("input", (e) => _renderUserTable(e.target.value));
}

/* ── Load users ── */
async function _loadUsers() {
    const list = document.getElementById("adm-users-list");
    if (list) list.innerHTML = `<div class="ws-placeholder">Loading…</div>`;

    try {
        const snap = await getDocs(collection(_db, "user_profiles"));
        _users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));

        await Promise.all(_users.map(async (u) => {
            try {
                const fSnap = await getDoc(doc(_db, "users", u.uid, "settings", "features"));
                _features[u.uid] = fSnap.exists() ? { ...FEATURE_DEFAULTS, ...fSnap.data() } : { ...FEATURE_DEFAULTS };
            } catch { _features[u.uid] = { ...FEATURE_DEFAULTS }; }

            try {
                const [pSnap, lSnap] = await Promise.all([
                    getDocs(collection(_db, "users", u.uid, "projects")),
                    getDocs(collection(_db, "users", u.uid, "gallery-links")),
                ]);
                _stats[u.uid] = { projects: pSnap.size, links: lSnap.size };
            } catch { _stats[u.uid] = { projects: 0, links: 0 }; }
        }));

        _renderUserTable("");
        _injectLinksBar();
    } catch (err) {
        console.error("Admin: failed to load users", err);
        if (list) list.innerHTML = `<div class="ws-placeholder">Error loading users.</div>`;
    }
}

/* ── Render user table ── */
function _renderUserTable(search) {
    const list = document.getElementById("adm-users-list");
    if (!list) return;

    const term = (search || "").toLowerCase().trim();
    const filtered = term
        ? _users.filter(u => (u.email || "").toLowerCase().includes(term) || (u.displayName || "").toLowerCase().includes(term))
        : _users;

    if (!filtered.length) {
        list.innerHTML = `<div class="ws-placeholder">No users found.</div>`;
        return;
    }

    const featureHeaderCells = Object.entries(FEATURE_META).map(([, m]) =>
        `<th class="adm-feat-hdr" title="${m.label}"><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">${m.icon}</span></th>`
    ).join("");

    list.innerHTML = `
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th class="adm-th-user">User</th>
              <th class="adm-th-num" title="Projects"><span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px">grid_view</span></th>
              <th class="adm-th-num" title="Links"><span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px">link</span></th>
              <th class="adm-th-features" colspan="${Object.keys(FEATURE_META).length}">Feature Flags</th>
            </tr>
            <tr class="adm-feat-label-row">
              <th></th><th></th><th></th>
              ${featureHeaderCells}
            </tr>
          </thead>
          <tbody id="adm-table-body"></tbody>
        </table>
      </div>`;

    const tbody = document.getElementById("adm-table-body");
    filtered.forEach(u => {
        const row = document.createElement("tr");
        row.className = "adm-user-row";
        const initials = ((u.displayName || u.email || "?")[0]).toUpperCase();
        const st    = _stats[u.uid] || { projects: 0, links: 0 };
        const feats = _features[u.uid] || { ...FEATURE_DEFAULTS };

        const featCells = Object.entries(FEATURE_META).map(([key, m]) => {
            const on = feats[key] !== false;
            return `<td class="adm-feat-cell">
              <label class="adm-toggle" title="${m.label}: ${on ? "on" : "off"}">
                <input type="checkbox" class="adm-flag-cb" data-uid="${escHtml(u.uid)}" data-feat="${key}" ${on ? "checked" : ""}>
                <span class="adm-toggle-track"><span class="adm-toggle-thumb"></span></span>
              </label>
            </td>`;
        }).join("");

        row.innerHTML = `
          <td class="adm-user-cell">
            <div class="adm-user-id">
              ${u.photoURL
                  ? `<img src="${escHtml(u.photoURL)}" class="adm-avatar" alt="" onerror="this.style.display='none'">`
                  : `<span class="adm-avatar adm-avatar--init">${escHtml(initials)}</span>`}
              <div>
                <div class="adm-user-name">${escHtml(u.displayName || u.email || u.uid)}</div>
                <div class="adm-user-email">${escHtml(u.email || u.uid)}</div>
              </div>
            </div>
          </td>
          <td class="adm-num-cell">${st.projects}</td>
          <td class="adm-num-cell adm-links-count" data-uid="${escHtml(u.uid)}" title="Browse links in Link Gallery">${st.links}</td>
          ${featCells}`;
        tbody.appendChild(row);
    });

    /* Feature flag toggles */
    list.querySelectorAll(".adm-flag-cb").forEach(cb => {
        cb.addEventListener("change", (e) => _setFlag(e.target.dataset.uid, e.target.dataset.feat, e.target.checked));
    });

    /* Click link count → open Link Gallery browsing that user */
    list.querySelectorAll(".adm-links-count").forEach(cell => {
        cell.addEventListener("click", () => {
            const u = _users.find(x => x.uid === cell.dataset.uid);
            if (!u) return;
            /* Switch hub to Link Gallery and load user's links */
            document.querySelector(".hub-app-btn[data-app='links']")?.click();
            const sel = document.getElementById("adm-links-user-sel");
            if (sel) { sel.value = u.uid; sel.dispatchEvent(new Event("change")); }
        });
    });
}

/* ── Feature flag toggle ── */
async function _setFlag(uid, feature, enabled) {
    try {
        await setDoc(doc(_db, "users", uid, "settings", "features"), { [feature]: enabled }, { merge: true });
        if (!_features[uid]) _features[uid] = { ...FEATURE_DEFAULTS };
        _features[uid][feature] = enabled;
        toast(`${FEATURE_META[feature]?.label || feature}: ${enabled ? "enabled" : "disabled"}`, "success");
    } catch (err) {
        console.error(err);
        toast("Error saving feature flag", "error");
    }
}

/* ══════════════════════════════════════════════════════════
   ADMIN LINKS BAR — injected at the top of #app-links
   Shows a user-picker so admin can browse any user's full Link Gallery.
   ══════════════════════════════════════════════════════════ */

function _injectLinksBar() {
    const linksApp = document.getElementById("app-links");
    if (!linksApp || document.getElementById("adm-links-bar")) return;

    const bar = document.createElement("div");
    bar.id = "adm-links-bar";
    bar.className = "adm-links-bar";
    bar.innerHTML = `
      <span class="material-symbols-outlined adm-links-bar-icon">manage_accounts</span>
      <span class="adm-links-bar-label">Browse as:</span>
      <select id="adm-links-user-sel" class="adm-links-user-sel">
        <option value="">My links</option>
      </select>
      <span id="adm-links-bar-info" class="adm-links-bar-info"></span>`;

    linksApp.insertBefore(bar, linksApp.firstChild);

    const sel = document.getElementById("adm-links-user-sel");
    _users.forEach(u => {
        const opt = document.createElement("option");
        opt.value = u.uid;
        opt.textContent = u.displayName || u.email || u.uid;
        sel.appendChild(opt);
    });

    sel.addEventListener("change", () => {
        const uid = sel.value;
        const infoEl = document.getElementById("adm-links-bar-info");
        if (!uid) {
            _linksOwnerId = null;
            if (infoEl) infoEl.textContent = "";
            setLinksAdminOwner(null);
        } else {
            const u = _users.find(x => x.uid === uid);
            if (!u) return;
            _linksOwnerId = uid;
            if (infoEl) infoEl.textContent = u.displayName || u.email || uid;
            setLinksAdminOwner(uid);
        }
    });
}
