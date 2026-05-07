/**
 * 通知ユーティリティ
 *
 * 現状: ブラウザの Notification API を使用
 * 将来: Service Worker + Web Push API でスマホ通知に拡張予定
 *
 * localStorage キー:
 *  - notify_enabled: ユーザーが通知を有効化したかどうか
 */

const STORAGE_KEY = "notify_enabled";

export function isNotificationSupported() {
	return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission() {
	if (!isNotificationSupported()) return "unsupported";
	return Notification.permission; // "default" | "granted" | "denied"
}

export function isNotificationEnabled() {
	if (!isNotificationSupported()) return false;
	if (Notification.permission !== "granted") return false;
	try {
		return localStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

export async function requestNotificationPermission() {
	if (!isNotificationSupported()) {
		return { ok: false, reason: "unsupported" };
	}
	if (Notification.permission === "granted") {
		try {
			localStorage.setItem(STORAGE_KEY, "1");
		} catch {
			/* ignore */
		}
		return { ok: true };
	}
	if (Notification.permission === "denied") {
		return { ok: false, reason: "denied" };
	}
	const result = await Notification.requestPermission();
	if (result === "granted") {
		try {
			localStorage.setItem(STORAGE_KEY, "1");
		} catch {
			/* ignore */
		}
		return { ok: true };
	}
	return { ok: false, reason: result };
}

export function setNotificationEnabled(enabled) {
	try {
		localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
	} catch {
		/* ignore */
	}
}

/**
 * 通知を発火する。設定が無効・許可されていなければ何もしない。
 *
 * @param {string} title
 * @param {object} options - { body, icon, tag, ... }
 */
export function notify(title, options = {}) {
	if (!isNotificationEnabled()) return null;
	try {
		const n = new Notification(title, {
			icon: "/favicon.ico",
			badge: "/favicon.ico",
			...options,
		});
		// クリックでアプリ画面にフォーカス
		n.onclick = () => {
			window.focus();
			n.close();
		};
		return n;
	} catch (e) {
		console.warn("Notification failed:", e);
		return null;
	}
}

/**
 * 献立生成完了通知。エラー時は別タイトル。
 */
export function notifyMealPlanResult({ success, message, error }) {
	if (error) {
		return notify("⚠ 献立生成エラー", {
			body: message || "生成中にエラーが発生しました",
			tag: "meal-plan-error",
		});
	}
	if (success) {
		return notify("✅ 献立の生成が完了しました", {
			body: message || "アプリを開いて確認してください",
			tag: "meal-plan-done",
		});
	}
	return null;
}
