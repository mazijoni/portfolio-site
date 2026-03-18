// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAUK1Qxac2KWSJB42h1swtmkqxQI3AYRHI",
  authDomain: "data-collection-login-7a0bc.firebaseapp.com",
  projectId: "data-collection-login-7a0bc",
  storageBucket: "data-collection-login-7a0bc.firebasestorage.app",
  messagingSenderId: "150014927775",
  appId: "1:150014927775:web:aea8aa8176fc53c959d3aa",
  measurementId: "G-EF7GBRNKV5"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);