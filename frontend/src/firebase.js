import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const apiBaseUrl = import.meta.env.VITE_API_URL?.trim()?.replace(/\/$/, '') || '';
const defaultFirebaseConfig = {
  apiKey: 'AIzaSyB0TwWaDGEvBjyJP1Z_Q_CJSoS-uCT2nbw',
  authDomain: 'healthmealplan-13d77.firebaseapp.com',
  projectId: 'healthmealplan-13d77',
  storageBucket: 'healthmealplan-13d77.firebasestorage.app',
  messagingSenderId: '496976184645',
  appId: '1:496976184645:web:ea1c4a9920f513b7862a2c',
};

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
  apiKey: readEnv('VITE_FIREBASE_API_KEY') || defaultFirebaseConfig.apiKey,
  authDomain: readEnv('VITE_FIREBASE_AUTH_DOMAIN') || defaultFirebaseConfig.authDomain,
  projectId: readEnv('VITE_FIREBASE_PROJECT_ID') || defaultFirebaseConfig.projectId,
  storageBucket: readEnv('VITE_FIREBASE_STORAGE_BUCKET') || defaultFirebaseConfig.storageBucket,
  messagingSenderId: readEnv('VITE_FIREBASE_MESSAGING_SENDER_ID') || defaultFirebaseConfig.messagingSenderId,
  appId: readEnv('VITE_FIREBASE_APP_ID') || defaultFirebaseConfig.appId,
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
