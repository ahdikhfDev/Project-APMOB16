import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, User } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DB_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

export { db, ref, set, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged };
export type { User };
