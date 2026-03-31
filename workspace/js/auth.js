/**
 * auth.js — Firebase Auth guard + header user chip.
 */

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";

/**
 * @param {import("firebase/auth").Auth} auth
 * @param {import("firebase/firestore").Firestore} db
 * @param {(user: object) => void} onReady  called when user is authenticated
 */
export function initAuth(auth, db, onReady) {
    onAuthStateChanged(auth, (user) => {
        if (!user) {
            window.location.href = "../login.html?redirect=workspace/";
            return;
        }

        _updateHeaderUI(user);

        document.getElementById("btn-signout").addEventListener("click", async () => {
            await signOut(auth);
            window.location.href = "../login.html";
        });

        // Avatar popup (mobile sign-out)
        const avatarEl  = document.getElementById("user-avatar");
        const popupEl   = document.getElementById("avatar-popup");
        const popupSignout = document.getElementById("avatar-popup-signout");

        avatarEl.addEventListener("click", (e) => {
            e.stopPropagation();
            popupEl.classList.toggle("open");
        });

        popupSignout.addEventListener("click", async () => {
            await signOut(auth);
            window.location.href = "../login.html";
        });

        document.addEventListener("click", () => {
            popupEl.classList.remove("open");
        });

        onReady(user);
    });
}

function _updateHeaderUI(user) {
    const nameEl   = document.getElementById("user-name");
    const avatarEl = document.getElementById("user-avatar");
    const display  = user.displayName || user.email || "User";

    nameEl.textContent = display;

    if (user.photoURL) {
        avatarEl.innerHTML = `<img src="${_escAttr(user.photoURL)}" alt="avatar">`;
    } else {
        avatarEl.textContent = display[0].toUpperCase();
    }
}

function _escAttr(str) {
    return str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
