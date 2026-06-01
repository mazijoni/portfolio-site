/**
 * auth.js — Firebase Auth guard + header user chip + account switcher.
 */

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";
import { doc, setDoc }                from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";
import { switchApp }                  from "./hub.js";

const ADMIN_EMAIL   = "maze.development.admin@gmail.com";
const _ACCOUNTS_KEY = "ws_saved_accounts";

/* ── Saved-account helpers ── */

function _getSavedAccounts() {
    try { return JSON.parse(localStorage.getItem(_ACCOUNTS_KEY)) || []; }
    catch { return []; }
}

function _saveAccount(user) {
    const accounts = _getSavedAccounts();
    const idx      = accounts.findIndex(a => a.uid === user.uid);
    const entry    = {
        uid:         user.uid,
        email:       user.email        || "",
        displayName: user.displayName  || "",
        photoURL:    user.photoURL     || "",
        /* track provider so we know whether to use Google sign-in or email/password */
        provider:    user.providerData?.[0]?.providerId || "password",
        lastSeen:    Date.now(),
    };
    if (idx >= 0) accounts[idx] = entry;
    else          accounts.push(entry);
    localStorage.setItem(_ACCOUNTS_KEY, JSON.stringify(accounts));
}

/* ── Main init ── */

export function initAuth(auth, db, onReady) {
    onAuthStateChanged(auth, (user) => {
        if (!user) {
            window.location.href = "../login.html?redirect=workspace/";
            return;
        }

        if (user.email === ADMIN_EMAIL && !window.location.pathname.includes("admin.html")) {
            window.location.href = "admin.html";
            return;
        }

        if (user.email !== ADMIN_EMAIL && window.location.pathname.includes("admin.html")) {
            window.location.href = "index.html";
            return;
        }

        _saveAccount(user);
        _updateHeaderUI(user);
        _buildAvatarPopup(auth, user);

        setDoc(doc(db, "user_profiles", user.uid), {
            uid:         user.uid,
            email:       user.email        || "",
            displayName: user.displayName  || "",
            photoURL:    user.photoURL     || "",
        }, { merge: true }).catch(console.error);

        document.getElementById("btn-signout")?.addEventListener("click", async () => {
            await signOut(auth);
            window.location.href = "../login.html";
        });

        onReady(user);
    });
}

/* ── Avatar popup ── */

function _buildAvatarPopup(auth, user) {
    const avatarEl = document.getElementById("user-avatar");
    const popupEl  = document.getElementById("avatar-popup");
    if (!popupEl) return;

    const others = _getSavedAccounts().filter(a => a.uid !== user.uid);

    popupEl.innerHTML = `
        <div class="avatar-popup-name"  id="user-name"></div>
        <div class="avatar-popup-email" id="user-email"></div>
        <div class="avatar-popup-divider"></div>
        <button class="avatar-popup-btn" id="avatar-popup-settings">
            <span class="material-symbols-outlined" style="font-size:14px">settings</span>
            Settings
        </button>
        <button class="avatar-popup-btn avatar-popup-signout" id="avatar-popup-signout">
            <span class="material-symbols-outlined" style="font-size:14px">logout</span>
            Sign out
        </button>
        <div class="avatar-popup-divider"></div>
        ${others.length > 0 ? `
            <div class="avatar-popup-switch-label">Switch account</div>
            <div class="avatar-popup-accounts" id="avatar-popup-accounts"></div>
        ` : ""}
        <button class="avatar-popup-btn" id="avatar-popup-add-account">
            <span class="material-symbols-outlined" style="font-size:14px">person_add</span>
            Add / switch account
        </button>
    `;

    _updateHeaderUI(user);

    const accountsList = document.getElementById("avatar-popup-accounts");
    if (accountsList) {
        others.forEach(a => {
            const btn = document.createElement("button");
            btn.className = "avatar-popup-account-item";
            const initials = ((a.displayName || a.email || "?")[0]).toUpperCase();
            btn.innerHTML = `
                ${a.photoURL
                    ? `<img src="${_escAttr(a.photoURL)}" class="avatar-mini" alt="" onerror="this.style.display='none'">`
                    : `<span class="avatar-mini avatar-mini--init">${_escHtml(initials)}</span>`}
                <div class="account-item-info">
                    <span class="account-item-name">${_escHtml(a.displayName || a.email)}</span>
                    <span class="account-item-email">${_escHtml(a.email)}</span>
                </div>
                ${a.provider === "google.com"
                    ? `<span class="account-item-badge">Google</span>`
                    : ""}
            `;
            btn.addEventListener("click", () => _switchToAccount(auth, a));
            accountsList.appendChild(btn);
        });
    }

    document.getElementById("avatar-popup-signout")?.addEventListener("click", async () => {
        await signOut(auth);
        window.location.href = "../login.html";
    });

    document.getElementById("avatar-popup-settings")?.addEventListener("click", () => {
        popupEl.classList.remove("open");
        switchApp("settings");
    });

    document.getElementById("avatar-popup-add-account")?.addEventListener("click", async () => {
        popupEl.classList.remove("open");
        await signOut(auth);
        window.location.href = "../login.html";
    });

    avatarEl.addEventListener("click", (e) => {
        e.stopPropagation();
        popupEl.classList.toggle("open");
    });

    document.addEventListener("click", () => popupEl.classList.remove("open"));
}

/**
 * Sign out then redirect to login with the right hint so the user does not
 * have to re-enter credentials from scratch.
 *
 * - Google accounts: pass ?google_hint=email so login.html can auto-open the
 *   Google sign-in popup with that account pre-selected (no password required).
 * - Email/password accounts: pass ?email=xxx so the email field is pre-filled.
 */
async function _switchToAccount(auth, account) {
    await signOut(auth);
    const params = new URLSearchParams(
        account.provider === "google.com"
            ? { google_hint: account.email }
            : { email: account.email }
    );
    window.location.href = `../login.html?${params}`;
}

/* ── UI helpers ── */

function _updateHeaderUI(user) {
    const nameEl   = document.getElementById("user-name");
    const emailEl  = document.getElementById("user-email");
    const avatarEl = document.getElementById("user-avatar");
    const display  = user.displayName || user.email || "User";

    if (nameEl)  nameEl.textContent  = display;
    if (emailEl) emailEl.textContent = user.email || "";

    if (user.photoURL) {
        avatarEl.innerHTML = `<img src="${_escAttr(user.photoURL)}" alt="avatar">`;
    } else {
        avatarEl.textContent = display[0].toUpperCase();
    }
}

function _escAttr(str) {
    return str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _escHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
