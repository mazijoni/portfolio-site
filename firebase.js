// Firebase config — placeholders are substituted by GitHub Actions at deploy time.
// For local development, values come from firebase.local.js instead.
export const googleClientId = "%%GOOGLE_CLIENT_ID%%";
export const tmdbKey = "%%TMDB_API_KEY%%";

export const firebaseConfig = {
  apiKey: "%%FIREBASE_API_KEY%%",
  authDomain: "%%FIREBASE_AUTH_DOMAIN%%",
  projectId: "%%FIREBASE_PROJECT_ID%%",
  storageBucket: "%%FIREBASE_STORAGE_BUCKET%%",
  messagingSenderId: "%%FIREBASE_MESSAGING_SENDER_ID%%",
  appId: "%%FIREBASE_APP_ID%%",
  measurementId: "%%FIREBASE_MEASUREMENT_ID%%"
};