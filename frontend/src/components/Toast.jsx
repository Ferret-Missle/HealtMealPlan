import { createContext, useCallback, useContext, useEffect, useState } from "react";

const ToastContext = createContext(null);

let _id = 0;
const nextId = () => ++_id;

export function ToastProvider({ children }) {
	const [toasts, setToasts] = useState([]);

	const show = useCallback((message, type = "info", duration = 4000) => {
		const id = nextId();
		setToasts((prev) => [...prev, { id, message, type }]);
		if (duration > 0) {
			setTimeout(() => {
				setToasts((prev) => prev.filter((t) => t.id !== id));
			}, duration);
		}
		return id;
	}, []);

	const dismiss = useCallback((id) => {
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}, []);

	const api = {
		show,
		success: (msg, dur) => show(msg, "success", dur),
		error: (msg, dur) => show(msg, "error", dur ?? 6000),
		info: (msg, dur) => show(msg, "info", dur),
		dismiss,
	};

	return (
		<ToastContext.Provider value={api}>
			{children}
			<div
				style={{
					position: "fixed",
					top: 16,
					right: 16,
					zIndex: 9999,
					display: "flex",
					flexDirection: "column",
					gap: 8,
					pointerEvents: "none",
					maxWidth: "calc(100vw - 32px)",
				}}
			>
				{toasts.map((t) => (
					<ToastItem key={t.id} toast={t} onClose={() => dismiss(t.id)} />
				))}
			</div>
		</ToastContext.Provider>
	);
}

function ToastItem({ toast, onClose }) {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const t = setTimeout(() => setVisible(true), 10);
		return () => clearTimeout(t);
	}, []);
	const colors = {
		success: { bg: "#16a34a", icon: "✅" },
		error: { bg: "#dc2626", icon: "⚠" },
		info: { bg: "#3b82f6", icon: "ℹ" },
	};
	const c = colors[toast.type] || colors.info;
	return (
		<div
			onClick={onClose}
			style={{
				background: c.bg,
				color: "white",
				padding: "10px 14px",
				borderRadius: 8,
				boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
				display: "flex",
				gap: 8,
				alignItems: "center",
				cursor: "pointer",
				fontSize: 13,
				maxWidth: 380,
				transform: visible ? "translateX(0)" : "translateX(120%)",
				opacity: visible ? 1 : 0,
				transition: "transform 0.25s ease, opacity 0.25s ease",
				pointerEvents: "auto",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
			}}
		>
			<span style={{ fontSize: 16, flexShrink: 0 }}>{c.icon}</span>
			<span style={{ flex: 1 }}>{toast.message}</span>
			<span style={{ opacity: 0.7, fontSize: 11, flexShrink: 0 }}>×</span>
		</div>
	);
}

export function useToast() {
	const ctx = useContext(ToastContext);
	if (!ctx) {
		// プロバイダ外で使われた場合のフォールバック（no-op）
		return {
			show: () => {},
			success: () => {},
			error: () => {},
			info: () => {},
			dismiss: () => {},
		};
	}
	return ctx;
}
