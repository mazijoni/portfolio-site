/**
 * apps/gmail.js — Gmail Viewer + Contact Watcher.
 *
 * Two tabs:
 *   Inbox    — Fetches real emails via Gmail REST API + Google Identity Services OAuth.
 *              Watched contacts are highlighted.
 *   Contacts — CRUD for watched email addresses stored in Firestore.
 *
 * Setup: add `export const googleClientId = "xxx.apps.googleusercontent.com";`
 * to firebase.local.js. Find the client ID in:
 * Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs
 * (Enable the Gmail API in the same console first.)
 */

import {
    onSnapshot, addDoc, updateDoc, deleteDoc,
    doc, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

import { refs }                from "../db.js";
import { openModal, closeModal,
         setModalTitle, toast,
         confirm, escHtml }    from "../ui.js";

/* ══════════ CONSTANTS ══════════ */

const GMAIL_API    = "https://gmail.googleapis.com/gmail/v1/users/me";
const AVATAR_COLORS = [
    "#5b6af0", "#0ea5e9", "#10b981", "#f59e0b",
    "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6",
];

/* ══════════ STATE ══════════ */

let _db, _user, _clientId;
let _contacts    = [];
let _unsub;
let _editId      = null;
let _activeView  = "inbox";   // "inbox"|"starred"|"snoozed"|"important"|"sent"|"drafts"|"contacts"|"label_{id}"

// Gmail API state
let _tokenClient  = null;
let _accessToken  = null;
let _gmailLoading = false;
let _emails       = [];
let _userLabels   = [];   // user-defined labels from API
let _inboxUnread  = 0;    // cached for sidebar badge
let _currentLabel = "INBOX";

const _TOKEN_KEY = () => `gmail_token_${_user?.uid}`;
const _EXPIRY_KEY = () => `gmail_expiry_${_user?.uid}`;

function _saveToken(token, expiresIn) {
    const expiry = Date.now() + (expiresIn - 60) * 1000; // 60s buffer
    sessionStorage.setItem(_TOKEN_KEY(), token);
    sessionStorage.setItem(_EXPIRY_KEY(), String(expiry));
}
function _loadToken() {
    const token  = sessionStorage.getItem(_TOKEN_KEY());
    const expiry = Number(sessionStorage.getItem(_EXPIRY_KEY()) || 0);
    if (token && expiry > Date.now()) return token;
    _clearToken();
    return null;
}
function _clearToken() {
    sessionStorage.removeItem(_TOKEN_KEY());
    sessionStorage.removeItem(_EXPIRY_KEY());
}

// Keyword rules (localStorage)
let _keywords = [];
const _KW_KEY  = () => `gmail_kw_${_user?.uid}`;
function _loadKeywords() {
    try { _keywords = JSON.parse(localStorage.getItem(_KW_KEY()) || "[]"); } catch { _keywords = []; }
}
function _saveKeywordsStorage() {
    localStorage.setItem(_KW_KEY(), JSON.stringify(_keywords));
}

/* ══════════ INIT ══════════ */

export function initGmail(db, user, clientId) {
    _db       = db;
    _user     = user;
    _clientId = clientId || "";
    _loadKeywords();

    // Event delegation on the body container
    document.getElementById("gmail-body")
        .addEventListener("click", _onBodyClick);

    // Firestore: watch contacts
    const q = query(refs.gmailContacts(_db, _user.uid), orderBy("createdAt", "desc"));
    let _firstSnap = true;
    _unsub = onSnapshot(q, snap => {
        _contacts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (_firstSnap) { _firstSnap = false; _tryRestoreToken(); }
        _render();
    });

    // Load GIS if clientId is configured
    if (_clientId && !_clientId.startsWith("%%")) {
        _loadGIS();
    }
}

/* helper called once contacts snapshot first fires so _user is set */
function _tryRestoreToken() {
    const cached = _loadToken();
    if (cached) {
        _accessToken = cached;
        _fetchEmails();
        _fetchLabels();
    }
}

/* ══════════ GIS OAUTH ══════════ */

function _loadGIS() {
    if (document.getElementById("gis-script")) return;
    const s = document.createElement("script");
    s.id  = "gis-script";
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => {
        _tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: _clientId,
            scope:     "https://www.googleapis.com/auth/gmail.readonly",
            callback:  async resp => {
                if (resp.error) {
                    toast("Gmail auth failed: " + resp.error, "error");
                    return;
                }
                _accessToken = resp.access_token;
                _saveToken(resp.access_token, resp.expires_in ?? 3600);
                await _fetchEmails();
                _fetchLabels();
            },
        });
    };
    s.onerror = () => toast("Failed to load Google auth library", "error");
    document.head.appendChild(s);
}

function _connectGmail() {
    if (!_tokenClient) {
        toast("Gmail not configured — see setup instructions.", "error");
        return;
    }
    _tokenClient.requestAccessToken();
}

function _disconnect() {
    if (_accessToken && typeof google !== "undefined") {
        google.accounts.oauth2.revoke(_accessToken, () => {});
    }
    _accessToken  = null;
    _gmailLoading = false;
    _emails       = [];
    _clearToken();
    _render();
}

/* ══════════ GMAIL API ══════════ */

async function _gmailFetch(path) {
    const resp = await fetch(GMAIL_API + path, {
        headers: { Authorization: "Bearer " + _accessToken },
    });
    if (resp.status === 401) {
        _accessToken = null;
        _clearToken();
        _render();
        throw new Error("gmail_unauth");
    }
    if (!resp.ok) throw new Error("Gmail API " + resp.status);
    return resp.json();
}

function _hasFile(parts) {
    if (!Array.isArray(parts)) return false;
    return parts.some(p => (p.filename && p.filename.length > 0) || _hasFile(p.parts));
}

function _applyKeywords(email) {
    if (!_keywords.length) return email;
    const haystack = `${email.subject} ${email.fromName} ${email.from}`.toLowerCase();
    const kwTags = [];
    let kwImportant = false;
    for (const kw of _keywords) {
        if (kw.keyword && haystack.includes(kw.keyword.toLowerCase())) {
            if (kw.action === "important") kwImportant = true;
            else kwTags.push({ label: kw.tag || kw.keyword, color: kw.color || "var(--accent)" });
        }
    }
    return { ...email, kwTags, kwImportant };
}

async function _fetchEmails(labelId = "INBOX") {
    _currentLabel = labelId;
    _gmailLoading = true;
    _render();
    try {
        const list = await _gmailFetch(`/messages?labelIds=${labelId}&maxResults=25`);
        const ids  = (list.messages || []).map(m => m.id);

        const metas = await Promise.all(
            ids.map(id => _gmailFetch(
                `/messages/${id}?format=metadata` +
                `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
            ))
        );

        const watchedEmails = new Set(_contacts.map(c => (c.email || "").toLowerCase()));
        _emails = metas.map(m => {
            const hmap = Object.fromEntries(
                (m.payload?.headers || []).map(h => [h.name, h.value])
            );
            const fromRaw    = hmap["From"] || "";
            const fromMatch  = fromRaw.match(/^(.*?)\s*<(.+?)>\s*$/) || [, fromRaw, fromRaw];
            const fromName   = (fromMatch[1] || fromMatch[2] || "").trim().replace(/^"(.*)"$/, "$1");
            const fromEmail  = (fromMatch[2] || "").toLowerCase().trim();
            return {
                id:            m.id,
                threadId:      m.threadId,
                from:          fromEmail,
                fromName,
                subject:       hmap["Subject"] || "(no subject)",
                snippet:       m.snippet || "",
                date:          hmap["Date"] || "",
                isWatched:     watchedEmails.has(fromEmail),
                isUnread:      (m.labelIds || []).includes("UNREAD"),
                isImportant:   (m.labelIds || []).includes("IMPORTANT"),
                hasAttachment: _hasFile(m.payload?.parts),
            };
        });
        if (labelId === "INBOX") _inboxUnread = _emails.filter(e => e.isUnread).length;
        _emails = _emails.map(_applyKeywords);
    } catch (err) {
        if (err.message !== "gmail_unauth") {
            console.error("[gmail]", err);
            if (_accessToken) toast("Error loading emails", "error");
        }
    }
    _gmailLoading = false;
    _render();
}

async function _fetchLabels() {
    try {
        const resp = await _gmailFetch("/labels");
        _userLabels = (resp.labels || [])
            .filter(l => l.type === "user" && l.labelListVisibility !== "labelHide")
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch { /* silent */ }
    _render();
}

/* ══════════ RENDER ══════════ */

function _navHtml() {
    const ic = {
        inbox:     `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
        starred:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
        snoozed:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
        important: `<svg width="16" height="16" viewBox="0 0 14 12" fill="currentColor" stroke="none"><polygon points="0,0 11,0 14,6 11,12 0,12"/></svg>`,
        sent:      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
        drafts:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
        contacts:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
        keywords:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
    };
    const systemItems = [
        { view: "inbox",     label: "INBOX",     icon: ic.inbox,     name: "Inbox",     count: _inboxUnread || 0 },
        { view: "starred",   label: "STARRED",   icon: ic.starred,   name: "Starred"   },
        { view: "snoozed",   label: "SNOOZED",   icon: ic.snoozed,   name: "Snoozed"   },
        { view: "important", label: "IMPORTANT", icon: ic.important, name: "Important" },
        { view: "sent",      label: "SENT",      icon: ic.sent,      name: "Sent"      },
        { view: "drafts",    label: "DRAFT",     icon: ic.drafts,    name: "Drafts"    },
    ];
    const sysHtml = systemItems.map(item => `
        <button class="gmail-nav-item${_activeView === item.view ? " active" : ""}" data-action="nav" data-view="${item.view}" data-label="${item.label}">
            ${item.icon}
            <span>${item.name}</span>
            ${item.count ? `<span class="gmail-nav-count">${item.count}</span>` : ""}
        </button>`).join("");
    const contactsHtml = `
        <button class="gmail-nav-item${_activeView === "contacts" ? " active" : ""}" data-action="nav" data-view="contacts">
            ${ic.contacts}
            <span>Contacts${_contacts.length ? ` (${_contacts.length})` : ""}</span>
        </button>`;
    const keywordsHtml = `
        <button class="gmail-nav-item${_activeView === "keywords" ? " active" : ""}" data-action="nav" data-view="keywords">
            ${ic.keywords}
            <span>Keywords${_keywords.length ? ` (${_keywords.length})` : ""}</span>
        </button>`;
    let labelsSectionHtml = "";
    if (_userLabels.length) {
        const labelItems = _userLabels.map(l => {
            const bg  = l.color?.textColor || l.color?.backgroundColor || "#8ab4f8";
            const isActive = _activeView === `label_${l.id}`;
            return `
                <button class="gmail-nav-item${isActive ? " active" : ""}" data-action="nav" data-view="label_${escHtml(l.id)}" data-label="${escHtml(l.id)}">
                    <span class="gmail-label-dot" style="background:${escHtml(bg)}"></span>
                    <span>${escHtml(l.name)}</span>
                </button>`;
        }).join("");
        labelsSectionHtml = `
            <div class="gmail-nav-divider"></div>
            <div class="gmail-nav-section-title">Labels</div>
            ${labelItems}`;
    }
    return `
        <button class="gmail-compose-btn" data-action="compose">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Compose
        </button>
        <div class="gmail-nav-scroll">${sysHtml}${contactsHtml}${keywordsHtml}${labelsSectionHtml}</div>`;
}

function _render() {
    const body = document.getElementById("gmail-body");
    if (!body) return;

    // Pre-auth states — full width, no sidebar
    if (!_clientId || _clientId.startsWith("%%")) {
        body.innerHTML = `<div class="gmail-no-sidebar">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="opacity:.35"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2,4 12,13 22,4"/></svg>
            <p><strong>Gmail not configured.</strong></p>
            <p class="gmail-setup-sub">Add your OAuth Client ID to <code>firebase.local.js</code>:</p>
            <pre class="gmail-setup-code">export const googleClientId = "YOUR_CLIENT_ID.apps.googleusercontent.com";</pre>
            <p class="gmail-setup-sub">Find it in <strong>Google Cloud Console &rarr; APIs &amp; Services &rarr; Credentials</strong> (enable the <em>Gmail API</em> too).</p>
        </div>`;
        return;
    }
    if (!_accessToken) {
        body.innerHTML = `<div class="gmail-no-sidebar">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="opacity:.35"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2,4 12,13 22,4"/></svg>
            <p>Connect your Google account to see your inbox.</p>
            <button class="ws-btn ws-btn-accent" data-action="connect" style="margin-top:.75rem">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2,4 12,13 22,4"/></svg>
                Connect Gmail
            </button>
        </div>`;
        return;
    }

    // Full layout: sidebar + main
    const mainHtml = _activeView === "contacts" ? _contactsHtml()
                   : _activeView === "keywords"  ? _keywordsHtml()
                   : _mainInboxHtml();
    body.innerHTML = `
        <div class="gmail-layout">
            <nav class="gmail-nav">${_navHtml()}</nav>
            <div class="gmail-main">${mainHtml}</div>
        </div>`;
}

/* ── Inbox / label view ── */
function _mainInboxHtml() {
    // Loading
    if (_gmailLoading) {
        return `<div class="gmail-loading"><div class="gmail-spin"></div><span>Loading emails…</span></div>`;
    }

    // Empty
    if (!_emails.length) {
        return `<div class="gmail-setup-msg">
            <p style="color:var(--text-muted)">No emails here.</p>
            <button class="ws-btn ws-btn-ghost ws-btn-sm" data-action="refresh" style="margin-top:.5rem">↻ Refresh</button>
        </div>`;
    }

    const rows = _emails.map(e => {
        const href       = `https://mail.google.com/mail/u/0/#inbox/${escHtml(e.threadId)}`;
        const dateStr    = _fmtDate(e.date);
        const initial    = (e.fromName || e.from || "?")[0].toUpperCase();
        const contact    = _contacts.find(c => (c.email || "").toLowerCase() === e.from);
        const bgColor    = contact?.color || (e.isWatched ? "#10b981" : "var(--bg-tertiary)");
        const fgColor    = (contact?.color || e.isWatched) ? "#fff" : "var(--text-muted)";
        const starFill   = e.isWatched ? "currentColor" : "none";
        const rowCls     = `gmail-email-row${e.isUnread ? " gmail-email-row--unread" : ""}`;
        return `
            <a class="${rowCls}" href="${href}" target="_blank" rel="noopener noreferrer">
                <span class="gmail-star-btn${e.isWatched ? " starred" : ""}" title="${e.isWatched ? "Watched contact" : ""}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </span>
                ${(e.isImportant || e.kwImportant)
                    ? `<span class="gmail-important-marker" title="Important"><svg width="12" height="12" viewBox="0 0 14 12" fill="currentColor" stroke="none"><polygon points="0,0 11,0 14,6 11,12 0,12"/></svg></span>`
                    : `<span class="gmail-important-placeholder"></span>`}
                <div class="gmail-email-avatar" style="background:${bgColor};color:${fgColor}">${escHtml(initial)}</div>
                <span class="gmail-email-from">${escHtml(e.fromName || e.from)}</span>
                <span class="gmail-email-body-line">
                    <span class="gmail-email-subject-text">${escHtml(e.subject)}</span>
                    <span class="gmail-email-sep">&ensp;&mdash;&ensp;</span>
                    <span class="gmail-email-snippet-inline">${escHtml(e.snippet)}</span>
                </span>
                ${e.kwTags?.length ? `<span class="gmail-rule-tags">${e.kwTags.map(t => `<span class="gmail-rule-tag" style="background:${escHtml(t.color)}20;color:${escHtml(t.color)};border-color:${escHtml(t.color)}60">${escHtml(t.label)}</span>`).join("")}</span>` : ""}
                ${e.hasAttachment ? `<span class="gmail-email-attach" title="Has attachment"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span>` : ""}
                <span class="gmail-email-date">${escHtml(dateStr)}</span>
            </a>`;
    }).join("");

    return `
        <div class="gmail-inbox-toolbar">
            <span class="gmail-inbox-count">${_emails.length} messages</span>
            <button class="ws-btn ws-btn-ghost ws-btn-sm" data-action="refresh">↻ Refresh</button>
            <button class="ws-btn ws-btn-ghost ws-btn-sm gmail-disconnect-btn" data-action="disconnect">Disconnect</button>
        </div>
        <div class="gmail-email-list">${rows}</div>`;
}

/* ── Contacts view ── */
function _contactsHtml() {
    const addBtn = `
        <button class="ws-btn ws-btn-accent ws-btn-sm gmail-add-contact-btn" data-action="add-contact">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Watch Contact
        </button>`;

    if (!_contacts.length) {
        return `<div class="gmail-contacts-toolbar">${addBtn}</div>
        <div class="gmail-setup-msg" style="padding-top:1.5rem">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="opacity:.3"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
            <p>No watched contacts yet.</p>
        </div>`;
    }

    const sorted = [..._contacts].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return  1;
        return (a.name || a.email || "").localeCompare(b.name || b.email || "");
    });

    const cards = sorted.map(c => {
        const srchUrl    = `https://mail.google.com/mail/u/0/#search/from%3A${encodeURIComponent(c.email)}`;
        const composeUrl = `https://mail.google.com/mail/u/0/?view=cm&fs=1&to=${encodeURIComponent(c.email)}`;
        const initial    = (c.name || c.email || "?")[0].toUpperCase();
        const color      = c.color || AVATAR_COLORS[0];
        return `
            <div class="gmail-card${c.pinned ? " gmail-card--pinned" : ""}" data-contact-id="${escHtml(c.id)}">
                <div class="gmail-card-avatar" style="background:${escHtml(color)}">${escHtml(initial)}</div>
                <div class="gmail-card-info">
                    <div class="gmail-card-name">${escHtml(c.name || c.email)}</div>
                    <div class="gmail-card-email">${escHtml(c.email)}</div>
                </div>
                <div class="gmail-card-actions">
                    <a href="${escHtml(srchUrl)}" target="_blank" rel="noopener noreferrer"
                       class="ws-btn ws-btn-ghost ws-btn-sm gmail-btn-inbox">Inbox ↗</a>
                    <a href="${escHtml(composeUrl)}" target="_blank" rel="noopener noreferrer"
                       class="ws-btn ws-btn-ghost ws-btn-sm">Compose ✉</a>
                </div>
                <div class="gmail-card-footer-actions">
                    <button class="link-card-action-btn${c.pinned ? " active" : ""}" data-action="pin-contact" title="${c.pinned ? "Unpin" : "Pin"}">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="${c.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    </button>
                    <button class="link-card-action-btn" data-action="edit-contact" title="Edit">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="link-card-action-btn link-card-action-btn--danger" data-action="delete-contact" title="Remove">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                </div>
            </div>`;
    }).join("");

    return `
        <div class="gmail-contacts-toolbar">${addBtn}</div>
        <div class="gmail-grid-wrap"><div class="gmail-grid">${cards}</div></div>`;
}

/* ══════════ KEYWORDS VIEW ══════════ */

function _keywordsHtml() {
    const addBtn = `
        <button class="ws-btn ws-btn-accent ws-btn-sm" data-action="add-keyword">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Keyword Rule
        </button>`;

    if (!_keywords.length) {
        return `<div class="gmail-contacts-toolbar">${addBtn}</div>
        <div class="gmail-setup-msg" style="padding-top:1.5rem">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="opacity:.3"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
            <p>No keyword rules yet.</p>
            <p style="color:var(--text-muted);font-size:0.82rem;max-width:24rem">Add rules to auto-tag or mark emails as important based on words in the subject, sender name, or email address.</p>
        </div>`;
    }

    const rows = _keywords.map(kw => {
        const resultHtml = kw.action === "important"
            ? `<span class="gmail-kw-result-important">
                <svg width="10" height="10" viewBox="0 0 14 12" fill="currentColor" stroke="none" style="margin-right:3px;vertical-align:middle"><polygon points="0,0 11,0 14,6 11,12 0,12"/></svg>Important</span>`
            : `<span class="gmail-rule-tag" style="background:${escHtml(kw.color)}20;color:${escHtml(kw.color)};border-color:${escHtml(kw.color)}60">${escHtml(kw.tag || kw.keyword)}</span>`;
        return `
            <div class="gmail-kw-row" data-kw-id="${escHtml(kw.id)}">
                <span class="gmail-kw-keyword">${escHtml(kw.keyword)}</span>
                <span class="gmail-kw-arrow">→</span>
                ${resultHtml}
                <div class="gmail-kw-actions">
                    <button class="link-card-action-btn" data-action="edit-kw" title="Edit">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="link-card-action-btn link-card-action-btn--danger" data-action="delete-kw" title="Remove">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                </div>
            </div>`;
    }).join("");

    return `
        <div class="gmail-contacts-toolbar">${addBtn}</div>
        <div class="gmail-kw-list">${rows}</div>`;
}

function _ensureKeywordModal() {
    if (document.getElementById("modal-gmail-kw")) return;
    const overlay = document.createElement("div");
    overlay.id        = "modal-gmail-kw";
    overlay.className = "ws-modal-overlay hidden";
    overlay.innerHTML = `
        <div class="ws-modal">
            <div class="ws-modal-header">
                <h2 id="modal-gmail-kw-title">Add Keyword Rule</h2>
                <button class="ws-modal-close" data-modal="modal-gmail-kw">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            <form id="form-gmail-kw" class="ws-modal-form" autocomplete="off">
                <input type="hidden" id="gmail-kw-id-field">
                <div class="form-group">
                    <label for="gmail-kw-keyword-field">Keyword *</label>
                    <input type="text" id="gmail-kw-keyword-field" placeholder="e.g. invoice, PlayStation" required maxlength="100">
                    <small style="color:var(--text-muted)">Matched against subject, sender name and email (case-insensitive)</small>
                </div>
                <div class="form-group">
                    <label>Action</label>
                    <div class="gmail-kw-action-radios">
                        <label class="gmail-kw-radio-label"><input type="radio" name="gmail-kw-action" value="tag" checked> Tag</label>
                        <label class="gmail-kw-radio-label"><input type="radio" name="gmail-kw-action" value="important"> Mark Important</label>
                    </div>
                </div>
                <div class="form-group" id="gmail-kw-tag-group">
                    <label for="gmail-kw-tag-field">Tag Label</label>
                    <input type="text" id="gmail-kw-tag-field" placeholder="e.g. Gaming, Work" maxlength="40">
                </div>
                <div class="form-group" id="gmail-kw-color-group">
                    <label>Tag Colour</label>
                    <div style="display:flex;align-items:center;gap:0.75rem">
                        <input type="color" id="gmail-kw-color-field" value="#5b6af0" style="width:38px;height:30px;border:none;background:none;cursor:pointer;padding:0;border-radius:4px">
                        <span id="gmail-kw-color-preview" class="gmail-rule-tag" style="background:#5b6af020;color:#5b6af0;border-color:#5b6af060">preview</span>
                    </div>
                </div>
                <div class="ws-modal-footer">
                    <button type="button" class="ws-btn ws-btn-ghost" data-modal="modal-gmail-kw">Cancel</button>
                    <button type="submit" class="ws-btn ws-btn-accent" id="btn-gmail-kw-submit">Add Rule</button>
                </div>
            </form>
        </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal("modal-gmail-kw"); });
    overlay.querySelector(".ws-modal-close").addEventListener("click", () => closeModal("modal-gmail-kw"));
    overlay.querySelectorAll("[data-modal='modal-gmail-kw']").forEach(b => b.addEventListener("click", () => closeModal("modal-gmail-kw")));

    overlay.querySelectorAll("input[name='gmail-kw-action']").forEach(r =>
        r.addEventListener("change", _updateKwModalFields));

    const colorField = () => document.getElementById("gmail-kw-color-field");
    const tagField   = () => document.getElementById("gmail-kw-tag-field");
    const preview    = () => document.getElementById("gmail-kw-color-preview");
    function _updatePreview() {
        const c = colorField()?.value || "#5b6af0";
        const t = tagField()?.value || "preview";
        const p = preview();
        if (!p) return;
        p.textContent      = t;
        p.style.background = c + "20";
        p.style.color      = c;
        p.style.borderColor = c + "60";
    }
    overlay.addEventListener("input", e => {
        if (e.target.id === "gmail-kw-color-field" || e.target.id === "gmail-kw-tag-field") _updatePreview();
    });

    document.getElementById("form-gmail-kw").addEventListener("submit", _onKeywordFormSubmit);
}

function _updateKwModalFields() {
    const action = document.querySelector("input[name='gmail-kw-action']:checked")?.value;
    const tagGroup   = document.getElementById("gmail-kw-tag-group");
    const colorGroup = document.getElementById("gmail-kw-color-group");
    if (tagGroup)   tagGroup.style.display   = action === "tag" ? "" : "none";
    if (colorGroup) colorGroup.style.display = action === "tag" ? "" : "none";
}

function _openKeywordForm(editId) {
    _ensureKeywordModal();
    document.getElementById("form-gmail-kw").reset();
    document.getElementById("gmail-kw-color-field").value = "#5b6af0";
    _updateKwModalFields();
    if (editId) {
        const kw = _keywords.find(x => x.id === editId);
        if (!kw) return;
        setModalTitle("modal-gmail-kw", "Edit Keyword Rule");
        document.getElementById("btn-gmail-kw-submit").textContent = "Save";
        document.getElementById("gmail-kw-id-field").value         = editId;
        document.getElementById("gmail-kw-keyword-field").value    = kw.keyword || "";
        const actionRadio = document.querySelector(`input[name='gmail-kw-action'][value='${kw.action || "tag"}']`);
        if (actionRadio) actionRadio.checked = true;
        _updateKwModalFields();
        if (kw.action !== "important") {
            document.getElementById("gmail-kw-tag-field").value   = kw.tag   || "";
            document.getElementById("gmail-kw-color-field").value = kw.color || "#5b6af0";
            const p = document.getElementById("gmail-kw-color-preview");
            if (p) { const c = kw.color || "#5b6af0"; p.textContent = kw.tag || "preview"; p.style.background = c+"20"; p.style.color = c; p.style.borderColor = c+"60"; }
        }
    } else {
        setModalTitle("modal-gmail-kw", "Add Keyword Rule");
        document.getElementById("btn-gmail-kw-submit").textContent = "Add Rule";
        document.getElementById("gmail-kw-id-field").value         = "";
    }
    openModal("modal-gmail-kw");
    setTimeout(() => document.getElementById("gmail-kw-keyword-field").focus(), 60);
}

function _onKeywordFormSubmit(e) {
    e.preventDefault();
    const keyword = document.getElementById("gmail-kw-keyword-field").value.trim();
    if (!keyword) { toast("Enter a keyword", "error"); return; }
    const action  = document.querySelector("input[name='gmail-kw-action']:checked")?.value || "tag";
    const tag     = action === "tag" ? (document.getElementById("gmail-kw-tag-field").value.trim() || keyword) : "";
    const color   = action === "tag" ? (document.getElementById("gmail-kw-color-field").value || "#5b6af0") : "";
    const editId  = document.getElementById("gmail-kw-id-field").value;
    if (editId) {
        _keywords = _keywords.map(kw => kw.id === editId ? { ...kw, keyword, action, tag, color } : kw);
        toast("Keyword updated", "success");
    } else {
        _keywords.push({ id: `kw-${Date.now()}`, keyword, action, tag, color });
        toast("Keyword rule added", "success");
    }
    _saveKeywordsStorage();
    _emails = _emails.map(_applyKeywords);
    closeModal("modal-gmail-kw");
    _render();
}

function _deleteKeyword(id) {
    const kw = _keywords.find(x => x.id === id);
    if (!kw) return;
    if (!confirm(`Remove keyword rule "${kw.keyword}"?`)) return;
    _keywords = _keywords.filter(x => x.id !== id);
    _saveKeywordsStorage();
    _emails = _emails.map(_applyKeywords);
    toast("Keyword rule removed");
    _render();
}

/* ══════════ CLICK DELEGATION ══════════ */

function _onBodyClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;

    switch (action) {
        case "nav": {
            const newView = btn.dataset.view;
            _activeView = newView;
            if (newView === "contacts" || newView === "keywords") {
                _render();
            } else {
                _fetchEmails(btn.dataset.label || "INBOX");
            }
            return;
        }
        case "compose":
            window.open("https://mail.google.com/mail/u/0/?view=cm&fs=1", "_blank", "noopener,noreferrer");
            return;
        case "tab":          /* legacy — no-op */ return;
        case "connect":      _connectGmail(); return;
        case "disconnect":   _disconnect(); return;
        case "refresh":      if (_accessToken) _fetchEmails(_currentLabel); return;
        case "add-contact":  _openContactForm(null); return;
        case "add-keyword":  _openKeywordForm(null); return;
    }

    const kwRow = btn.closest("[data-kw-id]");
    if (kwRow) {
        const kwId = kwRow.dataset.kwId;
        if (action === "edit-kw")   _openKeywordForm(kwId);
        else if (action === "delete-kw") _deleteKeyword(kwId);
        return;
    }

    const card = btn.closest("[data-contact-id]");
    if (!card) return;
    const id = card.dataset.contactId;
    if (action === "edit-contact")   _openContactForm(id);
    else if (action === "delete-contact") _deleteContact(id);
    else if (action === "pin-contact")    _togglePinContact(id);
}

/* ══════════ CRUD (contacts) ══════════ */

async function _deleteContact(id) {
    const c  = _contacts.find(x => x.id === id);
    const ok = await confirm(`Remove "${c?.name || c?.email}" from watched contacts?`);
    if (!ok) return;
    try {
        await deleteDoc(doc(_db, "users", _user.uid, "gmail-contacts", id));
        toast("Contact removed");
    } catch (err) { console.error(err); toast("Error removing contact", "error"); }
}

async function _togglePinContact(id) {
    const c = _contacts.find(x => x.id === id);
    if (!c) return;
    try {
        await updateDoc(doc(_db, "users", _user.uid, "gmail-contacts", id), {
            pinned: !c.pinned, updatedAt: serverTimestamp(),
        });
    } catch (err) { console.error(err); toast("Error", "error"); }
}

/* ══════════ CONTACT FORM ══════════ */

function _ensureContactModal() {
    if (document.getElementById("modal-gmail-contact")) return;
    const overlay = document.createElement("div");
    overlay.id        = "modal-gmail-contact";
    overlay.className = "ws-modal-overlay hidden";
    overlay.innerHTML = `
        <div class="ws-modal">
            <div class="ws-modal-header">
                <h2 id="modal-gmail-contact-title">Watch Contact</h2>
                <button class="ws-modal-close" data-modal="modal-gmail-contact">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            <form id="form-gmail-contact" class="ws-modal-form" autocomplete="off">
                <input type="hidden" id="gmail-contact-id-field">
                <div class="form-group">
                    <label for="gmail-contact-email-field">Email Address *</label>
                    <input type="email" id="gmail-contact-email-field" placeholder="someone@example.com" required>
                </div>
                <div class="form-group">
                    <label for="gmail-contact-name-field">Display Name</label>
                    <input type="text" id="gmail-contact-name-field" placeholder="e.g. John Smith" maxlength="80">
                </div>
                <div class="form-group">
                    <label>Avatar Colour</label>
                    <div id="gmail-color-picker" class="gmail-color-picker">
                        ${AVATAR_COLORS.map(c => `<button type="button" class="gmail-color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
                    </div>
                    <input type="hidden" id="gmail-contact-color-field" value="${AVATAR_COLORS[0]}">
                </div>
                <div class="ws-modal-footer">
                    <button type="button" class="ws-btn ws-btn-ghost" data-modal="modal-gmail-contact">Cancel</button>
                    <button type="submit" class="ws-btn ws-btn-accent" id="btn-gmail-contact-submit">Watch</button>
                </div>
            </form>
        </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal("modal-gmail-contact"); });
    overlay.querySelector(".ws-modal-close").addEventListener("click", () => closeModal("modal-gmail-contact"));
    overlay.querySelector("[data-modal='modal-gmail-contact']").addEventListener("click", () => closeModal("modal-gmail-contact"));

    document.getElementById("form-gmail-contact")
        .addEventListener("submit", _onContactFormSubmit);

    document.getElementById("gmail-color-picker")
        .addEventListener("click", e => {
            const sw = e.target.closest(".gmail-color-swatch");
            if (!sw) return;
            document.getElementById("gmail-contact-color-field").value = sw.dataset.color;
            document.querySelectorAll(".gmail-color-swatch").forEach(s => s.classList.toggle("selected", s === sw));
        });
}

function _openContactForm(editId) {
    _ensureContactModal();
    _editId = editId;
    document.getElementById("form-gmail-contact").reset();
    const colorField = document.getElementById("gmail-contact-color-field");
    colorField.value = AVATAR_COLORS[0];
    document.querySelectorAll(".gmail-color-swatch").forEach((s, i) => s.classList.toggle("selected", i === 0));

    if (editId) {
        const c = _contacts.find(x => x.id === editId);
        if (!c) return;
        setModalTitle("modal-gmail-contact", "Edit Contact");
        document.getElementById("btn-gmail-contact-submit").textContent  = "Save";
        document.getElementById("gmail-contact-id-field").value          = editId;
        document.getElementById("gmail-contact-email-field").value       = c.email || "";
        document.getElementById("gmail-contact-name-field").value        = c.name  || "";
        const col = c.color || AVATAR_COLORS[0];
        colorField.value = col;
        document.querySelectorAll(".gmail-color-swatch").forEach(s => s.classList.toggle("selected", s.dataset.color === col));
    } else {
        setModalTitle("modal-gmail-contact", "Watch Contact");
        document.getElementById("btn-gmail-contact-submit").textContent = "Watch";
        document.getElementById("gmail-contact-id-field").value         = "";
    }

    openModal("modal-gmail-contact");
    setTimeout(() => document.getElementById("gmail-contact-email-field").focus(), 60);
}

async function _onContactFormSubmit(e) {
    e.preventDefault();
    const email = document.getElementById("gmail-contact-email-field").value.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        toast("Please enter a valid email address", "error"); return;
    }
    const data = {
        email,
        name:      document.getElementById("gmail-contact-name-field").value.trim(),
        color:     document.getElementById("gmail-contact-color-field").value || AVATAR_COLORS[0],
        updatedAt: serverTimestamp(),
    };
    const editId = document.getElementById("gmail-contact-id-field").value;
    try {
        if (editId) {
            await updateDoc(doc(_db, "users", _user.uid, "gmail-contacts", editId), data);
            toast("Contact updated", "success");
        } else {
            await addDoc(refs.gmailContacts(_db, _user.uid), { ...data, pinned: false, createdAt: serverTimestamp() });
            toast("Contact added", "success");
        }
        closeModal("modal-gmail-contact");
        _editId = null;
    } catch (err) { console.error(err); toast("Error saving contact", "error"); }
}

/* ══════════ HELPERS ══════════ */

function _fmtDate(dateStr) {
    if (!dateStr) return "";
    try {
        const d   = new Date(dateStr);
        const now = new Date();
        if (d.toDateString() === now.toDateString())
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const diff = (now - d) / 86400000;
        if (diff < 7)
            return d.toLocaleDateString([], { weekday: "short" });
        return d.toLocaleDateString([], { month: "short", day: "numeric" });
    } catch { return ""; }
}
