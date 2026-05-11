import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const apiBaseUrl = import.meta.env.VITE_API_URL?.trim()?.replace(/\/$/, '') || '';

const readEnv = (...keys) => {
  for (const key of keys) {
    const value = import.meta.env[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const envFirebaseConfig = {
  apiKey: readEnv('VITE_FIREBASE_API_KEY'),
  authDomain: readEnv('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: readEnv('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: readEnv('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: readEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: readEnv('VITE_FIREBASE_APP_ID'),
};

const requiredFirebaseKeys = [
  'apiKey',
  'authDomain',
  'projectId',
  'appId',
];

const hasFirebaseConfig = (config) => requiredFirebaseKeys.every((key) =>
  String(config?.[key] ?? '').trim(),
);

const mergeFirebaseConfig = (...configs) => {
  const merged = {};
  for (const config of configs) {
    if (!config) continue;
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string' && value.trim()) {
        merged[key] = value.trim();
      }
    }
  }
  return merged;
};

let app = null;
let auth = null;
let firebaseInitError = null;
let firebaseInitPromise = null;

const fetchRuntimeFirebaseConfig = async () => {
  if (!apiBaseUrl) return null;

  const response = await fetch(`${apiBaseUrl}/api/auth/firebase-client-config`);
  if (!response.ok) {
    return null;
  }

  return response.json();
};

export const ensureFirebaseAuth = async () => {
  if (auth) {
    return auth;
  }

  if (firebaseInitPromise) {
    return firebaseInitPromise;
  }

  firebaseInitPromise = (async () => {
    firebaseInitError = null;

    let runtimeFirebaseConfig = null;
    if (!hasFirebaseConfig(envFirebaseConfig)) {
      try {
        runtimeFirebaseConfig = await fetchRuntimeFirebaseConfig();
      } catch (error) {
        console.warn('Failed to load Firebase config from backend:', error);
      }
    }

    const firebaseConfig = mergeFirebaseConfig(runtimeFirebaseConfig, envFirebaseConfig);
    if (!hasFirebaseConfig(firebaseConfig)) {
      firebaseInitError = new Error('Firebase configuration is missing.');
      console.warn('Firebase configuration is incomplete. Authentication features are disabled.');
      return null;
    }

    try {
      app = getApps().length ? getApp() : initializeApp(firebaseConfig);
      auth = getAuth(app);
      return auth;
    } catch (error) {
      firebaseInitError = error;
      console.error('Firebase initialization failed:', error);
      return null;
    }
  })();

  return firebaseInitPromise;
};

void ensureFirebaseAuth();

export { auth, firebaseInitError };
export const firebaseReady = Boolean(auth);
export default app;
