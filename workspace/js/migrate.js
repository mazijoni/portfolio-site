/**
 * migrate.js — One-time automatic migrations that run on every login.
 *
 * Currently handles:
 *   • private.html categories → workspace projects
 *     Every document in  users/{uid}/categories  is turned into a
 *     users/{uid}/projects  document (if not already migrated).
 *     The project stores  sourceCategoryId  so the media tab can
 *     query users/{uid}/links where categoryId === sourceCategoryId.
 */

import {
    collection, doc, getDocs, addDoc, updateDoc, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";
import {
    ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-storage.js";

import { db, storage } from "./app.js";

/**
 * Entry point — call once after the user is authenticated.
 * Silent: logs to console, never throws to the caller.
 */
export async function runMigrations(uid) {
    try {
        await _migrateCategoriesToProjects(uid);
    } catch (err) {
        console.error("[migrate] Unexpected error:", err);
    }
    // Run catbox migration independently so a failure doesn't block startup
    _migrateCatboxToStorage(uid).catch(err =>
        console.error("[migrate] Catbox migration error:", err)
    );
}

/* ── private.html categories → workspace projects ── */

async function _migrateCategoriesToProjects(uid) {
    const [catsSnap, projectsSnap] = await Promise.all([
        getDocs(query(collection(db, "users", uid, "categories"), orderBy("createdAt"))),
        getDocs(collection(db, "users", uid, "projects")),
    ]);

    if (catsSnap.empty) return; // nothing to migrate

    // Build set of category IDs that already have a corresponding project.
    // Used only to retroactively flag categories that were migrated before
    // the `migrated` flag was introduced.
    const existingProjectCatIds = new Set(
        projectsSnap.docs
            .map(d => d.data().sourceCategoryId)
            .filter(Boolean)
    );

    let count = 0;
    for (const catDoc of catsSnap.docs) {
        const cat = catDoc.data();

        // Primary guard: category was already handled in a previous run
        if (cat.migrated) continue;

        if (existingProjectCatIds.has(catDoc.id)) {
            // Project already exists (legacy run without the flag) —
            // just stamp the flag so future deletes don't re-trigger migration.
            await updateDoc(doc(db, "users", uid, "categories", catDoc.id), { migrated: true });
            continue;
        }

        await addDoc(collection(db, "users", uid, "projects"), {
            title:            cat.name || "Untitled",
            sourceCategoryId: catDoc.id,
            // Preserve original creation time where possible
            createdAt:        cat.createdAt ?? serverTimestamp(),
        });

        // Stamp the flag so this category is never re-migrated
        await updateDoc(doc(db, "users", uid, "categories", catDoc.id), { migrated: true });
        count++;
    }

    if (count > 0) {
        console.log(`[migrate] Created ${count} project(s) from private dashboard categories.`);
    }
}

/* ── Catbox → Firebase Storage ── */

// Fields that may contain an image URL, keyed by link type
const _CATBOX_IMAGE_FIELDS = {
    image:   ["url"],
    site:    ["imageUrl"],
    video:   ["thumbUrl"],
    creator: ["avatarUrl"],
    person:  ["avatarUrl"],
};

function _isCatboxUrl(url) {
    return typeof url === "string" &&
        (url.includes("files.catbox.moe") || url.includes("litter.catbox.moe"));
}

/**
 * Fetch an image blob, trying multiple CORS proxies if the direct request
 * is blocked or fails.
 */
async function _fetchImageBlob(url) {
    const proxies = [
        u => u,  // direct
        u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
        u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    ];

    for (const makeUrl of proxies) {
        try {
            const resp = await fetch(makeUrl(url));
            if (resp.ok) return resp.blob();
        } catch { /* try next */ }
    }

    throw new Error(`All fetch attempts failed for: ${url}`);
}

/**
 * One-time migration: download every catbox.moe image stored in
 * users/{uid}/links and re-upload it to Firebase Storage, then update
 * the Firestore document so it points at the new URL.
 *
 * Uses localStorage as a fast-path guard so the scan only happens once
 * per browser — but only set after a fully clean run (no failures).
 * The per-document `catboxMigrated` flag is only stamped when all of
 * that document's fields were successfully migrated.
 */
async function _migrateCatboxToStorage(uid) {
    const lsKey = `catboxMigDone_${uid}`;
    if (localStorage.getItem(lsKey)) return;

    const snap = await getDocs(collection(db, "users", uid, "links"));
    if (snap.empty) {
        localStorage.setItem(lsKey, "1");
        return;
    }

    let processed = 0;
    let anyFailed = false;

    for (const linkDoc of snap.docs) {
        const data = linkDoc.data();
        if (data.catboxMigrated) continue;

        const fields       = _CATBOX_IMAGE_FIELDS[data.type] || [];
        const catboxFields = fields.filter(f => _isCatboxUrl(data[f]));
        if (!catboxFields.length) continue;

        const updates  = {};
        let   docFailed = false;

        for (const field of catboxFields) {
            const originalUrl = data[field];
            try {
                const blob = await _fetchImageBlob(originalUrl);
                const ext  = originalUrl.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "jpg";
                const path = `users/${uid}/links/${linkDoc.id}/${field}.${ext}`;
                const storageRef = ref(storage, path);
                await uploadBytes(storageRef, blob, { contentType: blob.type || "image/jpeg" });
                updates[field] = await getDownloadURL(storageRef);
                console.log(`[migrate] catbox → storage: ${field} of ${linkDoc.id}`);
            } catch (err) {
                console.warn(`[migrate] Could not migrate ${field} of ${linkDoc.id}:`, err);
                docFailed = true;
                anyFailed = true;
            }
        }

        // Only mark this document done if every field succeeded
        if (!docFailed) updates.catboxMigrated = true;

        if (Object.keys(updates).length) {
            await updateDoc(doc(db, "users", uid, "links", linkDoc.id), updates);
        }
        if (!docFailed) processed++;
    }

    if (processed > 0) {
        console.log(`[migrate] Catbox migration complete — ${processed} document(s) updated.`);
    }

    // Only set the "all done" guard when nothing failed so we retry next login
    if (!anyFailed) {
        localStorage.setItem(lsKey, "1");
    } else {
        console.log("[migrate] Some catbox images could not be fetched — will retry on next login.");
    }
}

