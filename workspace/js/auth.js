/**
 * auth.js — Firebase Auth guard + header user chip.
 */

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";
import { doc, setDoc }                from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

/**
 * @param {import("firebase/auth").Auth} auth
 * @param {import("firebase/firestore").Firestore} db
 * @param {(user: object) => void} onReady  called when user is authenticated
 */
const ADMIN_EMAIL = "maze.development.admin@gmail.com";

export function initAuth(auth, db, onReady) {
    onAuthStateChanged(auth, (user) => {
        if (!user) {
            window.location.href = "../login.html?redirect=workspace/";
            return;
        }

        // Redirect admin to admin panel instead of normal workspace
        if (user.email === ADMIN_EMAIL &&
            !window.location.pathname.includes("admin.html")) {
            window.location.href = "admin.html";
            return;
        }

        // Redirect non-admin away from admin.html
        if (user.email !== ADMIN_EMAIL &&
            window.location.pathname.includes("admin.html")) {
            window.location.href = "index.html";
            return;
        }

        _updateHeaderUI(user);

        // Write/refresh the user's public profile so others can find them by email
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

        document.getElementById("avatar-popup-settings")?.addEventListener("click", () => {
            popupEl.classList.remove("open");
            document.getElementById("hub-btn-settings")?.click();
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
