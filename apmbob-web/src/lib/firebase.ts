import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCcDIVP9bles3_gjOk8upHXU7-U6Eh6QDE",
  authDomain: "kelompok16-aff05.firebaseapp.com",
  databaseURL: "https://kelompok16-aff05-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "kelompok16-aff05",
  storageBucket: "kelompok16-aff05.firebasestorage.app",
  messagingSenderId: "474876779233",
  appId: "1:474876779233:web:32efcb3e7633adcc4c75a0",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getDatabase(app);

export { db, ref, set };
