import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const requiredFirebaseKeys = [
  'apiKey',
  'authDomain',
  'projectId',
  'appId',
];

const hasFirebaseConfig = requiredFirebaseKeys.every((key) =>
  String(firebaseConfig[key] ?? '').trim(),
);

let app = null;
let auth = null;
let firebaseInitError = null;

if (hasFirebaseConfig) {
  try {
    app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
  } catch (error) {
    firebaseInitError = error;
    console.error('Firebase initialization failed:', error);
  }
} else {
  firebaseInitError = new Error('Firebase configuration is missing.');
  console.warn('Firebase configuration is incomplete. Authentication features are disabled.');
}

export { auth, firebaseInitError };
export const firebaseReady = Boolean(auth);
export default app;
