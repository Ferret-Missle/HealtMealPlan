/* eslint-disable react-refresh/only-export-components */
import {
	createUserWithEmailAndPassword,
	GoogleAuthProvider,
	onAuthStateChanged,
	signInWithEmailAndPassword,
	signInWithPopup,
	signOut,
} from "firebase/auth";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { auth } from "../firebase";
import { authApi, groupApi } from "../services/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
	const [user, setUser] = useState(null);
	const [profile, setProfile] = useState(null);
	const [pendingInvitations, setPendingInvitations] = useState([]);
	const [loading, setLoading] = useState(true);

	const loadPendingInvitations = useCallback(async () => {
		if (!auth.currentUser) {
			setPendingInvitations([]);
			return [];
		}

		const res = await groupApi.pendingInvitations();
		const invitations = res.data?.invitations || [];
		setPendingInvitations(invitations);
		return invitations;
	}, []);

	const applyAuthenticatedProfile = useCallback(
		(nextProfile) => {
			setProfile(nextProfile);

			void loadPendingInvitations().catch((inviteErr) => {
				console.error("Failed to load pending invitations", inviteErr);
				setPendingInvitations([]);
			});

			return nextProfile;
		},
		[loadPendingInvitations],
	);

	useEffect(() => {
		let active = true;

		const loadProfile = async (firebaseUser) => {
			try {
				const res = await authApi.me();
				if (active) {
					applyAuthenticatedProfile(res.data);
				}
			} catch (err) {
				// /me が 401/404 の場合 → DBにユーザー未登録。自動登録を試みる。
				// （メール登録後のDB再構築時や、別デバイス初回ログイン時に発生）
				const status = err?.response?.status;
				if (status === 401 || status === 404 || status === 422) {
					try {
						const name =
							firebaseUser.displayName ||
							firebaseUser.email?.split("@")[0] ||
							"ユーザー";
						await authApi.register({
							uid: firebaseUser.uid,
							email: firebaseUser.email || `${firebaseUser.uid}@unknown.local`,
							name,
							terms_version: "1.0",
							privacy_version: "1.0",
						});
						const res2 = await authApi.me();
						if (active) {
							applyAuthenticatedProfile(res2.data);
						}
					} catch {
						if (active) {
							setProfile(null);
							setPendingInvitations([]);
						}
					}
				} else if (active) {
					setProfile(null);
					setPendingInvitations([]);
				}
			}
		};

		const unsub = onAuthStateChanged(auth, (firebaseUser) => {
			if (!active) return;

			setUser(firebaseUser);
			setLoading(false);

			if (!firebaseUser) {
				setProfile(null);
				setPendingInvitations([]);
				return;
			}

			void loadProfile(firebaseUser);
		});

		return () => {
			active = false;
			unsub();
		};
	}, [applyAuthenticatedProfile]);

	const loginEmail = (email, password) =>
		signInWithEmailAndPassword(auth, email, password);

	const registerEmail = async (email, password, name) => {
		const cred = await createUserWithEmailAndPassword(auth, email, password);
		await authApi.register({
			uid: cred.user.uid,
			email,
			name,
			terms_version: "1.0",
			privacy_version: "1.0",
		});
		const res = await authApi.me();
		await applyAuthenticatedProfile(res.data);
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
				terms_version: "1.0",
				privacy_version: "1.0",
			});
		} catch {
			/* already registered */
		}
		const res = await authApi.me();
		await applyAuthenticatedProfile(res.data);
		return cred;
	};

	const logout = () => signOut(auth);

	const refreshProfile = useCallback(async () => {
		const res = await authApi.me();
		setProfile(res.data);
		return res.data;
	}, []);

	const refreshPendingInvitations = useCallback(async () => {
		try {
			return await loadPendingInvitations();
		} catch (inviteErr) {
			console.error("Failed to refresh pending invitations", inviteErr);
			setPendingInvitations([]);
			throw inviteErr;
		}
	}, [loadPendingInvitations]);

	return (
		<AuthContext.Provider
			value={{
				user,
				profile,
				pendingInvitations,
				loading,
				loginEmail,
				registerEmail,
				loginGoogle,
				logout,
				refreshProfile,
				refreshPendingInvitations,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth() {
	return useContext(AuthContext);
}
