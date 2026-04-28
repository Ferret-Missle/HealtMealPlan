import { useState, useEffect, createContext, useContext } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { auth } from '../firebase';
import { authApi } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        try {
          const res = await authApi.me();
          setProfile(res.data);
        } catch {
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const loginEmail = (email, password) =>
    signInWithEmailAndPassword(auth, email, password);

  const registerEmail = async (email, password, name) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await authApi.register({
      uid: cred.user.uid,
      email,
      name,
      terms_version: '1.0',
      privacy_version: '1.0',
    });
    const res = await authApi.me();
    setProfile(res.data);
    return cred;
  };

  const loginGoogle = async () => {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    try {
      await authApi.register({
        uid: cred.user.uid,
        email: cred.user.email,
        name: cred.user.displayName || cred.user.email,
        terms_version: '1.0',
        privacy_version: '1.0',
      });
    } catch { /* already registered */ }
    const res = await authApi.me();
    setProfile(res.data);
    return cred;
  };

  const logout = () => signOut(auth);

  const refreshProfile = async () => {
    const res = await authApi.me();
    setProfile(res.data);
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, loginEmail, registerEmail, loginGoogle, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
