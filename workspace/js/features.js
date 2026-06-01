/**
 * features.js — Per-user feature flags.
 *
 * Flags live at  users/{uid}/settings/features  and are written by the admin.
 * If no document exists all features default to enabled.
 */

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";

export const FEATURE_KEYS = ["links", "gmail", "analytics", "bluemap", "sheet"];

const DEFAULTS = { links: true, gmail: true, analytics: true, bluemap: true, sheet: true };

let _features = null;

/**
 * Load the user's feature flags from Firestore.
 * Call once in onUserReady before initHub/renderHubButtons.
 */
export async function loadUserFeatures(db, uid) {
    try {
        const snap = await getDoc(doc(db, "users", uid, "settings", "features"));
        _features = snap.exists() ? { ...DEFAULTS, ...snap.data() } : { ...DEFAULTS };
    } catch {
        _features = { ...DEFAULTS };
    }
    return { ..._features };
}

/** Returns true when the feature is enabled (or flags haven't loaded yet). */
export function isFeatureEnabled(feature) {
    if (!_features) return true;
    return _features[feature] !== false;
}

/** Returns a shallow copy of current flags (all keys present). */
export function getFeatures() {
    return { ...DEFAULTS, ..._features };
}
