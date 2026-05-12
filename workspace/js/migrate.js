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

import { db } from "./app.js";

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
