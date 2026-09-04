import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDzYi_Wq8Bx1Mq-90InkLcNaTrGu0gZFmg",
  authDomain: "ticket2bell.firebaseapp.com",
  projectId: "ticket2bell",
  storageBucket: "ticket2bell.firebasestorage.app",
  messagingSenderId: "803879234277",
  appId: "1:803879234277:web:8b49c84e9ea23e7931c20c",
};

const app =
  getApps().length === 0
    ? initializeApp(firebaseConfig)
    : getApp();

export const db = getFirestore(app);
export const auth = getAuth(app);

export default app;