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

import { refs }                        from "./db.js";
import { toast, escHtml }              from "./ui.js";
import { setLinksAdminOwner,
         setServiceDomains,
         getKnownServices }            from "./apps/links.js";
import { GALLERY_FEATURES,
         galleryDefaults }            from "./features.js";

/* ── Feature flag metadata (Material Symbols icon names, no emojis) ── */
const FEATURE_META = {
    links:     { label: "Link Gallery",  icon: "link" },
    gmail:     { label: "Gmail",         icon: "mail" },
    analytics: { label: "Analytics",     icon: "bar_chart" },
    bluemap:   { label: "ServerMap",      icon: "map" },
    sheet:     { label: "Sheet Viewer",  icon: "table_chart" },
};

const FEATURE_DEFAULTS = { links: true, gmail: true, analytics: true, bluemap: true, sheet: true };
const GALLERY_DEFAULTS = galleryDefaults();

/* Gallery sub-features grouped for the expandable per-user detail panel. */
const GALLERY_GROUPS = (() => {
    const groups = {};
    for (const [key, m] of Object.entries(GALLERY_FEATURES)) {
        (groups[m.group] ||= []).push({ key, ...m });
    }
    return groups;
})();

/* ── Module state ── */
let _db       = null;
let _users    = [];
let _features = {};   // uid → { links, gmail, … }
let _stats    = {};   // uid → { projects, links }

/* Admin links-bar state */
let _linksOwnerId = null;   // uid of user being browsed (null = own links)
let _selectedUid  = null;   // user currently open in the master-detail pane

/* ── Init ── */
export function initAdminPanel(db) {
    _db = db;
    const root = document.getElementById("app-admin-users");
    if (!root) return;

    _buildUsersShell(root);
    _loadUsers();
    _loadServiceConfig();
}

/* ══════════════════════════════════════════════════════════
   SERVICE CONFIG — admin-managed domain settings
   ══════════════════════════════════════════════════════════ */

async function _loadServiceConfig() {
    try {
        const snap = await getDoc(refs.serviceConfig(_db));
        const cfg  = snap.exists() ? snap.data() : {};
        _renderServiceConfig(cfg);
    } catch (err) {
        console.error("Admin: failed to load service config", err);
        _renderServiceConfig({});
    }
}

function _renderServiceConfig(cfg) {
    const el = document.getElementById("adm-service-config");
    if (!el) return;
    const overrides  = cfg.serviceDomains || {};
    const services   = getKnownServices();

    const rows = services.map(svc => {
        const defHost = (() => { try { return new URL(svc.url).hostname; } catch { return svc.url; } })();
        const cur = overrides[svc.name] || "";
        return `<tr>
          <td class="adm-svc-name-cell">${escHtml(svc.name)}</td>
          <td class="adm-svc-def-cell">${escHtml(defHost)}</td>
          <td class="adm-svc-inp-cell">
            <input class="adm-svc-input adm-svc-override" data-svc="${escHtml(svc.name)}"
                   type="text" value="${escHtml(cur)}" placeholder="${escHtml(defHost)}"
                   autocomplete="off" spellcheck="false">
          </td>
        </tr>`;
    }).join("");

    el.innerHTML = `
      <div class="adm-svc-table-wrap">
        <table class="adm-svc-table">
          <thead><tr>
            <th>Service</th>
            <th>Default domain</th>
            <th>Override domain (leave blank to use default)</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="adm-svc-footer">
        <button id="adm-svc-save-btn" class="ws-btn ws-btn-primary ws-btn-sm">Save all</button>
      </div>`;

    document.getElementById("adm-svc-save-btn").addEventListener("click", async () => {
        const serviceDomains = {};
        el.querySelectorAll(".adm-svc-override").forEach(inp => {
            const val = inp.value.trim();
            if (val) serviceDomains[inp.dataset.svc] = val;
        });
        try {
            await setDoc(refs.serviceConfig(_db), { serviceDomains }, { merge: false });
            setServiceDomains(serviceDomains);
            toast("Service domains saved", "success");
        } catch (err) {
            console.error(err);
            toast("Error saving service config", "error");
        }
    });
}

/* ── Users panel shell (master-detail layout) ── */
function _buildUsersShell(root) {
    root.innerHTML = `
    <div class="adm-panel-wrap">
      <div class="adm-svc-config">
        <span class="adm-toolbar-title">Service Settings</span>
        <div id="adm-service-config" class="adm-svc-body">
          <div class="ws-placeholder">Loading…</div>
        </div>
      </div>
      <div class="adm-md">
        <aside class="adm-md-list">
          <div class="adm-md-list-head">
            <div class="adm-md-search-wrap">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" id="adm-user-search" class="adm-md-search" placeholder="Search users…" autocomplete="off">
            </div>
            <button id="adm-refresh-btn" class="adm-md-refresh" title="Refresh">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
          </div>
          <div class="adm-md-list-sub">
            <span class="adm-toolbar-title">Users</span>
            <span id="adm-user-count" class="adm-user-count"></span>
          </div>
          <div id="adm-users-list" class="adm-md-users">
            <div class="ws-placeholder">Loading users…</div>
          </div>
        </aside>
        <section id="adm-md-detail" class="adm-md-detail">
          <div class="adm-md-empty">
            <span class="material-symbols-outlined">manage_accounts</span>
            <p>Select a user to manage their features</p>
          </div>
        </section>
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
                const data = fSnap.exists() ? fSnap.data() : {};
                _features[u.uid] = { ...FEATURE_DEFAULTS, ...data };
                _features[u.uid].gallery = { ...GALLERY_DEFAULTS, ...(data.gallery || {}) };
            } catch { _features[u.uid] = { ...FEATURE_DEFAULTS, gallery: { ...GALLERY_DEFAULTS } }; }

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

/* ── Render the left-hand user list (master pane) ── */
function _renderUserTable(search) {
    const list = document.getElementById("adm-users-list");
    if (!list) return;

    const term = (search || "").toLowerCase().trim();
    const filtered = term
        ? _users.filter(u => (u.email || "").toLowerCase().includes(term) || (u.displayName || "").toLowerCase().includes(term))
        : _users;

    const countEl = document.getElementById("adm-user-count");
    if (countEl) countEl.textContent = `${filtered.length}`;

    if (!filtered.length) {
        list.innerHTML = `<div class="ws-placeholder">No users found.</div>`;
        _renderUserDetail(null);
        return;
    }

    list.innerHTML = filtered.map(u => {
        const initials = ((u.displayName || u.email || "?")[0]).toUpperCase();
        const feats = _features[u.uid] || { ...FEATURE_DEFAULTS };
        const gal   = feats.gallery || { ...GALLERY_DEFAULTS };
        const appsOff = Object.keys(FEATURE_META).filter(k => feats[k] === false).length;
        const galOff  = Object.keys(GALLERY_FEATURES).filter(k => gal[k] === false).length;
        const off = appsOff + galOff;
        const active = u.uid === _selectedUid ? " active" : "";
        return `
          <button class="adm-md-user${active}" data-uid="${escHtml(u.uid)}">
            ${u.photoURL
                ? `<img src="${escHtml(u.photoURL)}" class="adm-avatar" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'adm-avatar adm-avatar--init',textContent:'${escHtml(initials)}'}))">`
                : `<span class="adm-avatar adm-avatar--init">${escHtml(initials)}</span>`}
            <span class="adm-md-user-meta">
              <span class="adm-user-name">${escHtml(u.displayName || u.email || u.uid)}</span>
              <span class="adm-user-email">${escHtml(u.email || u.uid)}</span>
            </span>
            ${off ? `<span class="adm-md-user-badge" title="${off} feature${off === 1 ? "" : "s"} disabled">${off}</span>` : ""}
          </button>`;
    }).join("");

    list.querySelectorAll(".adm-md-user").forEach(btn => {
        btn.addEventListener("click", () => {
            _selectedUid = btn.dataset.uid;
            list.querySelectorAll(".adm-md-user").forEach(b => b.classList.toggle("active", b === btn));
            _renderUserDetail(_selectedUid);
        });
    });

    // Keep the open user (or auto-open the first) so the detail pane is never stale
    if (_selectedUid && filtered.some(u => u.uid === _selectedUid)) _renderUserDetail(_selectedUid);
    else _renderUserDetail(null);
}

/* ── Render the detail pane for one user ── */
function _renderUserDetail(uid) {
    const pane = document.getElementById("adm-md-detail");
    if (!pane) return;

    if (!uid) {
        pane.innerHTML = `<div class="adm-md-empty"><span class="material-symbols-outlined">manage_accounts</span><p>Select a user to manage their features</p></div>`;
        return;
    }
    const u = _users.find(x => x.uid === uid);
    if (!u) { pane.innerHTML = `<div class="adm-md-empty"><p>User not found.</p></div>`; return; }

    const initials = ((u.displayName || u.email || "?")[0]).toUpperCase();
    const st    = _stats[uid] || { projects: 0, links: 0 };
    const feats = _features[uid] || { ...FEATURE_DEFAULTS };
    const gal   = feats.gallery || { ...GALLERY_DEFAULTS };

    const switchEl = (cls, dataAttrs, on) =>
        `<span class="lgs-switch"><input type="checkbox" class="${cls}" ${dataAttrs} ${on ? "checked" : ""}><span class="lgs-switch-track"></span></span>`;

    const appRows = Object.entries(FEATURE_META).map(([key, m]) => {
        const on = feats[key] !== false;
        return `<label class="adm-md-flag">
            <span class="material-symbols-outlined adm-md-flag-icon">${m.icon}</span>
            <span class="adm-md-flag-label">${escHtml(m.label)}</span>
            ${switchEl("adm-flag-cb", `data-uid="${escHtml(uid)}" data-feat="${key}"`, on)}
          </label>`;
    }).join("");

    const galGroups = Object.entries(GALLERY_GROUPS).map(([group, items]) => `
        <div class="adm-md-group">
          <div class="adm-md-group-title">${escHtml(group)}</div>
          ${items.map(it => {
              const on = gal[it.key] !== false;
              return `<label class="adm-md-flag">
                  <span class="adm-md-flag-label">${escHtml(it.label)}</span>
                  ${switchEl("adm-gflag-cb", `data-uid="${escHtml(uid)}" data-gkey="${escHtml(it.key)}"`, on)}
                </label>`;
          }).join("")}
        </div>`).join("");

    const galOn  = Object.keys(GALLERY_FEATURES).filter(k => gal[k] !== false).length;
    const galTot = Object.keys(GALLERY_FEATURES).length;

    pane.innerHTML = `
      <div class="adm-md-detail-scroll">
        <div class="adm-md-dhead">
          ${u.photoURL
              ? `<img src="${escHtml(u.photoURL)}" class="adm-avatar adm-avatar--xl" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'adm-avatar adm-avatar--xl adm-avatar--init',textContent:'${escHtml(initials)}'}))">`
              : `<span class="adm-avatar adm-avatar--xl adm-avatar--init">${escHtml(initials)}</span>`}
          <div class="adm-md-dident">
            <div class="adm-md-dname">${escHtml(u.displayName || u.email || uid)}</div>
            <div class="adm-md-demail">${escHtml(u.email || "")}</div>
            <div class="adm-md-duid">${escHtml(uid)}</div>
          </div>
          <div class="adm-md-dstats">
            <span class="adm-stat" title="Projects"><span class="material-symbols-outlined">grid_view</span>${st.projects}</span>
            <button class="adm-stat adm-links-count" data-uid="${escHtml(uid)}" title="Browse this user's Link Gallery"><span class="material-symbols-outlined">link</span>${st.links}</button>
          </div>
        </div>

        <div class="adm-md-section">
          <div class="adm-md-section-head"><span class="material-symbols-outlined">apps</span>Applications</div>
          <div class="adm-md-flags">${appRows}</div>
        </div>

        <div class="adm-md-section">
          <div class="adm-md-section-head"><span class="material-symbols-outlined">tune</span>Link Gallery
            <span class="adm-md-section-count" id="adm-md-gal-count">${galOn} / ${galTot}</span>
          </div>
          <div class="adm-md-groups">${galGroups}</div>
        </div>
      </div>`;

    /* App feature toggles */
    pane.querySelectorAll(".adm-flag-cb").forEach(cb =>
        cb.addEventListener("change", (e) => {
            _setFlag(e.target.dataset.uid, e.target.dataset.feat, e.target.checked);
            _syncListBadge(e.target.dataset.uid);
        }));

    /* Gallery sub-feature toggles + live count */
    pane.querySelectorAll(".adm-gflag-cb").forEach(cb =>
        cb.addEventListener("change", (e) => {
            _setGalleryFlag(e.target.dataset.uid, e.target.dataset.gkey, e.target.checked);
            const g = _features[e.target.dataset.uid]?.gallery || {};
            const on = Object.keys(GALLERY_FEATURES).filter(k => g[k] !== false).length;
            const cnt = document.getElementById("adm-md-gal-count");
            if (cnt) cnt.textContent = `${on} / ${galTot}`;
            _syncListBadge(e.target.dataset.uid);
        }));

    /* Browse this user's links */
    pane.querySelector(".adm-links-count")?.addEventListener("click", () => {
        document.querySelector(".hub-app-btn[data-app='links']")?.click();
        const sel = document.getElementById("adm-links-user-sel");
        if (sel) { sel.value = uid; sel.dispatchEvent(new Event("change")); }
    });
}

/* Refresh the "N disabled" badge for a user in the left list without a full re-render */
function _syncListBadge(uid) {
    const btn = document.querySelector(`.adm-md-user[data-uid="${CSS.escape(uid)}"]`);
    if (!btn) return;
    const feats = _features[uid] || {};
    const gal   = feats.gallery || {};
    const off = Object.keys(FEATURE_META).filter(k => feats[k] === false).length
              + Object.keys(GALLERY_FEATURES).filter(k => gal[k] === false).length;
    let badge = btn.querySelector(".adm-md-user-badge");
    if (off) {
        if (!badge) { badge = document.createElement("span"); badge.className = "adm-md-user-badge"; btn.appendChild(badge); }
        badge.textContent = String(off);
        badge.title = `${off} feature${off === 1 ? "" : "s"} disabled`;
    } else if (badge) {
        badge.remove();
    }
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

async function _setGalleryFlag(uid, key, enabled) {
    try {
        await setDoc(doc(_db, "users", uid, "settings", "features"), { gallery: { [key]: enabled } }, { merge: true });
        if (!_features[uid]) _features[uid] = { ...FEATURE_DEFAULTS, gallery: { ...GALLERY_DEFAULTS } };
        if (!_features[uid].gallery) _features[uid].gallery = { ...GALLERY_DEFAULTS };
        _features[uid].gallery[key] = enabled;
        toast(`${GALLERY_FEATURES[key]?.label || key}: ${enabled ? "enabled" : "disabled"}`, "success");
    } catch (err) {
        console.error(err);
        toast("Error saving gallery feature flag", "error");
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
