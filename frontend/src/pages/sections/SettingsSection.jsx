import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CalendarSync,
	LogOut,
	Plus,
	Target,
	Trash2,
	Wifi,
	WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "../../components/Toast";
import { useAuth } from "../../hooks/useAuth";
import { authApi, bodyApi, settingsApi } from "../../services/api";
import { addJstMonths, daysUntilJst, formatJstDate } from "../../utils/date";

const SERVICES = [
	{ key: "fitbit", label: "Fitbit", desc: "歩数・睡眠・心拍・体重" },
	{
		key: "healthplanet",
		label: "HealthPlanet (タニタ)",
		desc: "体重・体脂肪・筋肉量・BMI",
	},
	{
		key: "fatsecret",
		label: "FatSecret",
		desc: "食品検索・食事日記同期",
		note: "連携すると食事日記の自動同期が可能。食品検索は連携なしでも利用可能。",
	},
	{ key: "google", label: "Googleカレンダー", desc: "予定取得（外食・運動）" },
];

const BYOK_PROVIDERS = [
	{ key: "anthropic", label: "Anthropic (Claude)", vision: true },
	{ key: "openai", label: "OpenAI (GPT-4o)", vision: true },
	{ key: "gemini", label: "Google Gemini", vision: true },
	{ key: "groq", label: "Groq (Llama 3.3)", vision: false },
	{ key: "mistral", label: "Mistral AI", vision: false },
];

const DIET_STYLES = [
	"和食中心",
	"洋食中心",
	"高タンパク",
	"低炭水化物",
	"糖質制限",
	"ベジタリアン",
	"ビーガン",
];
const GOAL_TYPES = [
	{ key: "lose", label: "減量" },
	{ key: "maintain", label: "維持" },
	{ key: "gain", label: "増量" },
];

// "あと X 日" を計算
function daysRemaining(dateStr) {
	return daysUntilJst(dateStr);
}

// 今日から N ヶ月後の日付文字列
function addMonths(n) {
	return addJstMonths(n);
}

// バックエンドの DateTime("2026-06-07T00:00:00") を <input type="date"> 用の "2026-06-07" に正規化
function normalizeDateInput(v) {
	if (!v) return "";
	if (typeof v !== "string") return "";
	// すでに yyyy-MM-dd ならそのまま
	if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
	// "2026-06-07T..." → 先頭10文字
	if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
	return "";
}

function createGoalForm(source) {
	return {
		target_weight: source?.target_weight ?? "",
		target_kcal: source?.target_kcal ?? "",
		goal_type: source?.goal_type ?? "lose",
		deadline: normalizeDateInput(source?.deadline),
	};
}

export default function SettingsSection() {
	const { user, profile, logout, refreshProfile } = useAuth();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const connected = searchParams.get("connected");
	const oauthError = searchParams.get("error");
	const oauthDetail = searchParams.get("detail");

	const [newApiKey, setNewApiKey] = useState({
		provider: "anthropic",
		key: "",
	});
	const [showApiKeyForm, setShowApiKeyForm] = useState(false);
	const [excludedInput, setExcludedInput] = useState("");
	const toast = useToast();
	// 後方互換シム：既存の setSuccessMsg/setErrorMsg 呼び出しはトーストへリダイレクト
	const setSuccessMsg = (msg) => msg && toast.success(msg);
	const setErrorMsg = (msg) => msg && toast.error(msg);
	// OAuth リダイレクト直後の通知
	useEffect(() => {
		if (oauthError) {
			toast.error(
				`連携に失敗しました (${oauthError}${oauthDetail ? `: ${oauthDetail}` : ""})`,
			);
		}
		if (connected) {
			toast.success(`${connected} を連携しました！`);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [oauthError, oauthDetail, connected]);

	const refreshConnectedState = useCallback(async () => {
		await Promise.allSettled([
			refreshProfile(),
			qc.invalidateQueries({ queryKey: ["settings"] }),
			qc.invalidateQueries({ queryKey: ["dashboard"] }),
			qc.invalidateQueries({ queryKey: ["weight-history"] }),
			qc.invalidateQueries({ queryKey: ["activity-history"] }),
		]);
	}, [qc, refreshProfile]);

	const ensureCurrentUserRegistration = useCallback(async () => {
		if (!user?.uid) {
			throw new Error("ログインユーザー情報を取得できません");
		}

		await authApi.register({
			uid: user.uid,
			email: user.email || `${user.uid}@unknown.local`,
			name:
				profile?.name ||
				user.displayName ||
				user.email?.split("@")[0] ||
				"ユーザー",
			terms_version: "1.0",
			privacy_version: "1.0",
		});
	}, [profile?.name, user]);

	// OAuth リダイレクト直後は接続状態を再取得し、
	// HealthPlanet の場合は体重履歴も取り込んでから URL を整える。
	useEffect(() => {
		if (!connected && !oauthError) return;

		let active = true;

		const handleOAuthRedirect = async () => {
			if (connected) {
				await refreshConnectedState();

				if (connected === "google") {
					try {
						const res = await settingsApi.syncCalendars();
						await refreshConnectedState();
						if (active) {
							const synced = res.data?.synced ?? 0;
							setSuccessMsg(
								`Googleカレンダーを連携しました。${synced}件のカレンダーを同期しました`,
							);
						}
					} catch (e) {
						if (active) {
							const detail =
								e.response?.data?.detail ||
								e.message ||
								"カレンダー一覧の同期に失敗しました";
							setErrorMsg(
								`Googleカレンダーは連携済みですが、カレンダー一覧の同期に失敗しました: ${detail}`,
							);
						}
					}
				}

				if (connected === "healthplanet") {
					try {
						const res = await bodyApi.syncWeightHistory(30);
						const saved = res.data?.saved ?? 0;
						await refreshConnectedState();
						if (active && saved > 0) {
							setSuccessMsg(
								`HealthPlanet を連携しました。体重データを ${saved} 件同期しました`,
							);
						}
					} catch (e) {
						if (active) {
							const detail =
								e.response?.data?.detail ||
								e.message ||
								"体重データの同期に失敗しました";
							setErrorMsg(
								`HealthPlanet は連携済みですが、データ反映に失敗しました: ${detail}`,
							);
						}
					}
				}
			}

			if (active) {
				navigate("/me", { replace: true });
			}
		};

		void handleOAuthRedirect();

		return () => {
			active = false;
		};
	}, [connected, oauthError, navigate, refreshConnectedState]);

	// 健康目標
	const [goalDraft, setGoalDraft] = useState(null);

	const { data: settings, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: () => settingsApi.get().then((r) => r.data),
	});

	const { data: goalsData } = useQuery({
		queryKey: ["body-goals"],
		queryFn: () => bodyApi.goals().then((r) => r.data),
	});

	const goalForm = goalDraft ?? (goalsData ? createGoalForm(goalsData) : null);

	const goalMutation = useMutation({
		mutationFn: (data) => bodyApi.updateGoals(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["body-goals"] });
			qc.invalidateQueries({ queryKey: ["dashboard"] });
			setSuccessMsg("目標を保存しました");
		},
		onError: (e) => setErrorMsg(e.message),
	});

	const prefMutation = useMutation({
		mutationFn: (data) => settingsApi.updatePreferences(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			setSuccessMsg("設定を保存しました");
		},
	});

	const apiKeyMutation = useMutation({
		mutationFn: (data) => settingsApi.registerApiKey(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			refreshProfile();
			setShowApiKeyForm(false);
			setNewApiKey({ provider: "anthropic", key: "" });
			setSuccessMsg("APIキーを登録しました");
		},
		onError: (e) => setErrorMsg(e.message),
	});

	const deleteKeyMutation = useMutation({
		mutationFn: (provider) => settingsApi.deleteApiKey(provider),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			refreshProfile();
		},
	});

	const disconnectMutation = useMutation({
		mutationFn: (service) => authApi.disconnect(service),
		onSuccess: () => refreshConnectedState(),
	});

	const deleteAccountMutation = useMutation({
		mutationFn: () => authApi.deleteAccount(),
		onSuccess: async () => {
			sessionStorage.removeItem("pending_invite_token");
			qc.clear();
			await logout();
			navigate("/login", { replace: true });
		},
		onError: (e) =>
			setErrorMsg(
				e.response?.data?.detail || e.message || "アカウント削除に失敗しました",
			),
	});

	const syncCalMutation = useMutation({
		mutationFn: () => settingsApi.syncCalendars(),
		onSuccess: (response) => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			const synced = response.data?.synced ?? 0;
			setSuccessMsg(`カレンダーを同期しました (${synced}件)`);
		},
		onError: (e) => setErrorMsg(e.message),
	});

	const updateCalendarMutation = useMutation({
		mutationFn: ({ calendarId, use_for_meal_plan }) =>
			settingsApi.updateCalendar(calendarId, { use_for_meal_plan }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			qc.invalidateQueries({ queryKey: ["dashboard"] });
			qc.invalidateQueries({ queryKey: ["dashboard-calendar"] });
			qc.invalidateQueries({ queryKey: ["group-schedules"] });
		},
		onError: (e) => setErrorMsg(e.message),
	});

	const connectedServices = settings?.connected_services || [];
	const apiKeys = settings?.api_keys || [];
	const calendarSettings = settings?.calendar_settings || [];
	const dietStyles = settings?.preferences?.diet_styles || [];
	const excludedFoods = settings?.excluded_foods || [];

	const handleConnect = async (service) => {
		try {
			await ensureCurrentUserRegistration();

			if (service === "fitbit") {
				const res = await authApi.fitbitLoginUrl(user.uid);
				window.location.assign(res.data.url);
			} else if (service === "healthplanet") {
				const res = await authApi.healthplanetLoginUrl(user.uid);
				window.location.assign(res.data.url);
			} else if (service === "google") {
				const res = await authApi.googleLoginUrl(user.uid);
				window.location.assign(res.data.url);
			} else if (service === "fatsecret") {
				const res = await authApi.fatsecretLoginUrl(user.uid);
				window.location.assign(res.data.url);
			}
		} catch (e) {
			const detail = e.response?.data?.detail || e.message;
			setErrorMsg("連携の開始に失敗しました: " + detail);
		}
	};

	const toggleDietStyle = (style) => {
		const next = dietStyles.includes(style)
			? dietStyles.filter((s) => s !== style)
			: [...dietStyles, style];
		prefMutation.mutate({ diet_styles: next });
	};

	const addExcluded = () => {
		if (!excludedInput.trim()) return;
		const next = [...new Set([...excludedFoods, excludedInput.trim()])];
		prefMutation.mutate({ excluded_foods: next });
		setExcludedInput("");
	};

	const removeExcluded = (food) => {
		prefMutation.mutate({
			excluded_foods: excludedFoods.filter((f) => f !== food),
		});
	};

	const updateGoalForm = (updater) => {
		setGoalDraft((current) => updater(current ?? createGoalForm(goalsData)));
	};

	const toggleCalendarSelection = (calendarId, checked) => {
		updateCalendarMutation.mutate({
			calendarId,
			use_for_meal_plan: checked,
		});
	};

	if (isLoading)
		return (
			<div className="loading-screen">
				<div className="spinner" />
			</div>
		);

	return (
		<div>
			{/* Profile */}
			<div className="card">
				<div className="card-title">アカウント</div>
				<div style={{ fontSize: 15 }}>
					<strong>{profile?.name || user?.displayName}</strong>
					<div
						style={{
							fontSize: 13,
							color: "var(--text-secondary)",
							marginTop: 4,
						}}
					>
						{user?.email}
					</div>
				</div>
				<div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
					<span
						className={
							profile?.plan_type === "byok"
								? "connected-badge"
								: "disconnected-badge"
						}
					>
						{profile?.plan_type === "byok"
							? `BYOK (${profile.byok_provider})`
							: "無料プラン (Groq)"}
					</span>
					{profile?.is_developer && (
						<span
							className="connected-badge"
							style={{ background: "#7c3aed", color: "white" }}
							title="開発者アカウント：使用回数制限が撤廃されています"
						>
							🛠 開発者モード
						</span>
					)}
				</div>

				{/* User ID（開発者向け）：クリックでコピー、デフォルトは控えめに省略表示 */}
				<button
					type="button"
					onClick={() => {
						const uid = profile?.id || user?.uid;
						if (uid && navigator.clipboard) {
							navigator.clipboard.writeText(uid);
							toast.success("User ID をコピーしました");
						}
					}}
					title="クリックで User ID をコピー"
					style={{
						marginTop: 8,
						background: "transparent",
						border: "none",
						padding: 0,
						fontSize: 10,
						color: "var(--text-3, #94a3b8)",
						fontFamily: "monospace",
						cursor: "pointer",
						display: "inline-block",
					}}
				>
					{(() => {
						const uid = profile?.id || user?.uid || "";
						if (!uid) return "";
						return uid.length > 12
							? `id: ${uid.slice(0, 6)}…${uid.slice(-4)} 📋`
							: `id: ${uid} 📋`;
					})()}
				</button>
			</div>

			{/* 健康目標 */}
			<div
				className="section-title"
				style={{ display: "flex", alignItems: "center", gap: 6 }}
			>
				<Target size={13} strokeWidth={1.8} />
				健康目標
			</div>
			{goalForm && (
				<div className="card">
					{/* goal_type */}
					<div className="form-group">
						<label className="form-label">目標タイプ</label>
						<div style={{ display: "flex", gap: 8 }}>
							{GOAL_TYPES.map(({ key, label }) => (
								<button
									key={key}
									className={`btn btn-sm${goalForm.goal_type === key ? " btn-primary" : " btn-outline"}`}
									onClick={() =>
										updateGoalForm((f) => ({ ...f, goal_type: key }))
									}
								>
									{label}
								</button>
							))}
						</div>
					</div>

					{/* 目標体重 */}
					<div className="form-group">
						<label className="form-label">目標体重 (kg)</label>
						<input
							className="form-input"
							type="number"
							step="0.1"
							placeholder="例: 65.0"
							value={goalForm.target_weight}
							onChange={(e) =>
								updateGoalForm((f) => ({ ...f, target_weight: e.target.value }))
							}
							style={{ maxWidth: 140 }}
						/>
					</div>

					{/* 目標カロリー */}
					<div className="form-group">
						<label className="form-label">1日の目標カロリー (kcal)</label>
						<input
							className="form-input"
							type="number"
							step="50"
							placeholder="例: 1800"
							value={goalForm.target_kcal}
							onChange={(e) =>
								updateGoalForm((f) => ({ ...f, target_kcal: e.target.value }))
							}
							style={{ maxWidth: 140 }}
						/>
					</div>

					{/* 期限プリセット */}
					<div className="form-group">
						<label className="form-label">達成期限</label>

						{/* ── 保存済み期限の大きな表示 ── */}
						{goalsData?.deadline && (
							<div className="deadline-display">
								<div className="deadline-date">
									{(() => {
										return formatJstDate(goalsData.deadline, {
											year: "numeric",
											month: "long",
											day: "numeric",
										});
									})()}
								</div>
								<div
									className={`deadline-days${
										daysRemaining(goalsData.deadline) === 0
											? " deadline-days--expired"
											: ""
									}`}
								>
									{daysRemaining(goalsData.deadline) > 0
										? `あと ${daysRemaining(goalsData.deadline).toLocaleString()} 日`
										: "期限日"}
								</div>
							</div>
						)}

						{/* ── 期限の再設定 ── */}
						<div
							style={{
								display: "flex",
								gap: 6,
								flexWrap: "wrap",
								marginBottom: 8,
							}}
						>
							{[
								{ label: "1ヶ月", months: 1 },
								{ label: "3ヶ月", months: 3 },
								{ label: "6ヶ月", months: 6 },
								{ label: "1年", months: 12 },
							].map(({ label, months }) => {
								const d = addMonths(months);
								const active = goalForm.deadline === d;
								return (
									<button
										key={months}
										className={`btn btn-sm${active ? " btn-primary" : " btn-outline"}`}
										onClick={() =>
											updateGoalForm((f) => ({ ...f, deadline: d }))
										}
									>
										{label}
									</button>
								);
							})}
						</div>
						{/* カスタム日付 */}
						<input
							className="form-input"
							type="date"
							value={goalForm.deadline}
							onChange={(e) =>
								updateGoalForm((f) => ({ ...f, deadline: e.target.value }))
							}
							style={{ maxWidth: 180 }}
						/>
						{goalForm.deadline && goalForm.deadline !== goalsData?.deadline && (
							<div
								style={{
									fontSize: 12,
									color: "var(--brand)",
									marginTop: 4,
									fontWeight: 600,
								}}
							>
								設定後: あと {daysRemaining(goalForm.deadline).toLocaleString()}{" "}
								日
							</div>
						)}
					</div>

					<button
						className="btn btn-primary btn-full"
						style={{ marginTop: 4 }}
						onClick={() =>
							goalMutation.mutate({
								target_weight: goalForm.target_weight
									? parseFloat(goalForm.target_weight)
									: null,
								target_kcal: goalForm.target_kcal
									? parseInt(goalForm.target_kcal, 10)
									: null,
								goal_type: goalForm.goal_type || null,
								deadline: goalForm.deadline || null,
							})
						}
						disabled={goalMutation.isPending}
					>
						{goalMutation.isPending ? "保存中…" : "目標を保存"}
					</button>
				</div>
			)}

			{/* External services */}
			<div className="section-title">外部サービス連携</div>
			{SERVICES.map((svc) => {
				const isConn = connectedServices.includes(svc.key);
				return (
					<div className="card service-card" key={svc.key}>
						<div className="service-card-inner">
							<div className="service-card-info">
								<div className="service-card-name">{svc.label}</div>
								<div className="service-card-desc">{svc.desc}</div>
								{svc.note && (
									<div
										style={{
											fontSize: 11,
											color: "var(--text-secondary)",
											marginTop: 3,
											lineHeight: 1.4,
										}}
									>
										{svc.note}
									</div>
								)}
							</div>
							<div className="service-card-action">
								{svc.noConnect ? (
									<span
										style={{
											fontSize: 11,
											color: "var(--text-secondary)",
											maxWidth: 180,
											textAlign: "right",
											lineHeight: 1.4,
										}}
										title={svc.note}
									>
										連携不要
									</span>
								) : svc.unavailable ? (
									<span
										style={{
											fontSize: 11,
											color: "var(--text-2)",
											maxWidth: 160,
											textAlign: "right",
											lineHeight: 1.4,
										}}
										title={svc.unavailableReason}
									>
										現在利用不可
									</span>
								) : isConn ? (
									<>
										<span className="connected-badge">
											<Wifi
												size={11}
												strokeWidth={2}
												style={{ marginRight: 3 }}
											/>
											連携済み
										</span>
										<button
											className="btn btn-danger btn-sm"
											onClick={() => disconnectMutation.mutate(svc.key)}
										>
											解除
										</button>
									</>
								) : (
									<button
										className="btn btn-primary btn-sm"
										onClick={() => handleConnect(svc.key)}
									>
										<WifiOff
											size={13}
											strokeWidth={2}
											style={{ marginRight: 4 }}
										/>
										連携する
									</button>
								)}
							</div>
						</div>
					</div>
				);
			})}

			{connectedServices.includes("google") && (
				<>
					<button
						className="btn btn-outline btn-full"
						style={{ marginBottom: 12 }}
						onClick={() => syncCalMutation.mutate()}
						disabled={syncCalMutation.isPending}
					>
						<CalendarSync
							size={14}
							strokeWidth={2}
							style={{ marginRight: 6 }}
						/>
						{syncCalMutation.isPending
							? "カレンダー同期中…"
							: "カレンダーリストを同期"}
					</button>

					<div className="card" style={{ marginBottom: 16 }}>
						<div className="card-title">取得対象のカレンダー</div>
						<div
							style={{
								fontSize: 12,
								color: "var(--text-secondary)",
								marginBottom: 12,
								lineHeight: 1.5,
							}}
						>
							Google
							アカウントで閲覧できるカレンダーだけが表示されます。家族カレンダーや共有カレンダーも、閲覧権限があれば選択できます。
						</div>
						{calendarSettings.length > 0 ? (
							calendarSettings.map((calendar) => (
								<label
									key={calendar.calendar_id}
									className="list-item"
									style={{
										display: "flex",
										alignItems: "center",
										gap: 12,
										cursor: updateCalendarMutation.isPending
											? "wait"
											: "pointer",
									}}
								>
									<input
										type="checkbox"
										checked={calendar.use_for_meal_plan}
										onChange={(e) =>
											toggleCalendarSelection(
												calendar.calendar_id,
												e.target.checked,
											)
										}
										disabled={updateCalendarMutation.isPending}
										style={{ width: 16, height: 16 }}
									/>
									<div style={{ flex: 1, minWidth: 0 }}>
										<div style={{ fontSize: 14, fontWeight: 500 }}>
											{calendar.calendar_name}
										</div>
										<div
											style={{
												fontSize: 11,
												color: "var(--text-secondary)",
												marginTop: 2,
											}}
										>
											{calendar.is_shared ? "共有カレンダー" : "マイカレンダー"}
										</div>
									</div>
								</label>
							))
						) : (
							<div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
								まだカレンダーが同期されていません。上のボタンで一覧を同期してください。
							</div>
						)}
					</div>
				</>
			)}

			{/* LLM / BYOK */}
			<div className="section-title">LLMプラン</div>
			<div className="card">
				<div className="card-title">
					現在のプラン:{" "}
					{settings?.plan?.force_free_llm
						? "🆓 無料切替中 (Groq)"
						: profile?.plan_type === "byok"
							? "BYOKプラン"
							: "無料プラン (Groq)"}
				</div>

				{/* 無料 LLM 切替トグル：APIキー登録済みの全ユーザーに表示 */}
				{(settings?.plan?.plan_type === "byok" || apiKeys.length > 0) && (
					<div
						style={{
							marginBottom: 12,
							padding: 10,
							background: "var(--bg)",
							borderRadius: 8,
						}}
					>
						<label
							style={{
								display: "flex",
								alignItems: "flex-start",
								gap: 10,
								cursor: "pointer",
								fontSize: 13,
							}}
						>
							<input
								type="checkbox"
								checked={!!settings?.plan?.force_free_llm}
								onChange={(e) => {
									settingsApi
										.updateForceFree({ force_free_llm: e.target.checked })
										.then(() => qc.invalidateQueries({ queryKey: ["settings"] }))
										.catch((err) =>
											toast.error(err.response?.data?.detail || err.message),
										);
								}}
								style={{ marginTop: 2 }}
							/>
							<div>
								<div style={{ fontWeight: 600 }}>
									🆓 無料 LLM (Groq) に一時切替
								</div>
								<div
									style={{
										fontSize: 11,
										color: "var(--text-secondary)",
										marginTop: 2,
									}}
								>
									ON にすると BYOK のAPIキーを使わず、無料の Groq モデルを使用します。
									API 利用料を抑えたいときに便利。月間上限は無料プラン扱いになります。
								</div>
							</div>
						</label>
					</div>
				)}

				{/* 使用モデル選択 */}
				{settings?.plan?.available_models?.length > 0 && (
					<div className="form-group" style={{ marginBottom: 12 }}>
						<label className="form-label">使用モデル</label>
						<select
							className="form-input"
							value={settings.plan.byok_model || ""}
							onChange={(e) => {
								const model = e.target.value || null;
								settingsApi
									.updateLlmModel({ byok_model: model })
									.then(() => qc.invalidateQueries({ queryKey: ["settings"] }))
									.catch((err) =>
										toast.error(err.response?.data?.detail || err.message),
									);
							}}
						>
							<option value="">デフォルト（自動）</option>
							{settings.plan.available_models.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}{m.pricing_note ? ` ｜ ${m.pricing_note}` : ""}
								</option>
							))}
						</select>
						<div
							style={{
								fontSize: 11,
								color: "var(--text-secondary)",
								marginTop: 4,
							}}
						>
							※ 円換算は概算です（1 USD = 155円）。プランによって選択できるモデルが変わります。
						</div>
					</div>
				)}

				{apiKeys.map((k) => (
					<div key={k.provider} className="list-item">
						<div>
							<div style={{ fontSize: 14, fontWeight: 500 }}>
								{BYOK_PROVIDERS.find((p) => p.key === k.provider)?.label ||
									k.provider}
							</div>
							<div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
								…{k.hint}
							</div>
						</div>
						<button
							className="btn btn-danger btn-sm"
							onClick={() => deleteKeyMutation.mutate(k.provider)}
						>
							<Trash2 size={13} strokeWidth={2} style={{ marginRight: 4 }} />
							削除
						</button>
					</div>
				))}

				<button
					className="btn btn-secondary btn-full"
					style={{ marginTop: 12 }}
					onClick={() => setShowApiKeyForm(true)}
				>
					<Plus size={14} strokeWidth={2} style={{ marginRight: 4 }} />
					APIキーを追加（BYOKプランに切り替え）
				</button>

				{showApiKeyForm && (
					<div
						style={{
							marginTop: 12,
							padding: 12,
							background: "var(--bg)",
							borderRadius: 8,
						}}
					>
						<div className="form-group">
							<label className="form-label">プロバイダー</label>
							<select
								className="form-input"
								value={newApiKey.provider}
								onChange={(e) =>
									setNewApiKey((k) => ({ ...k, provider: e.target.value }))
								}
							>
								{BYOK_PROVIDERS.map((p) => (
									<option key={p.key} value={p.key}>
										{p.label}
										{!p.vision ? " (写真推定不可)" : ""}
									</option>
								))}
							</select>
						</div>
						<div className="form-group">
							<label className="form-label">APIキー</label>
							<input
								className="form-input"
								type="password"
								placeholder="sk-…"
								value={newApiKey.key}
								onChange={(e) =>
									setNewApiKey((k) => ({ ...k, key: e.target.value }))
								}
							/>
							<div
								style={{
									fontSize: 11,
									color: "var(--text-secondary)",
									marginTop: 4,
								}}
							>
								※ AES-256-GCMで暗号化して保存。末尾4文字のみ表示されます。
							</div>
						</div>
						<div style={{ display: "flex", gap: 8 }}>
							<button
								className="btn btn-primary"
								style={{ flex: 1 }}
								onClick={() =>
									apiKeyMutation.mutate({
										provider: newApiKey.provider,
										api_key: newApiKey.key,
									})
								}
								disabled={!newApiKey.key || apiKeyMutation.isPending}
							>
								{apiKeyMutation.isPending ? "登録中…" : "登録"}
							</button>
							<button
								className="btn btn-outline"
								onClick={() => setShowApiKeyForm(false)}
							>
								キャンセル
							</button>
						</div>
					</div>
				)}
			</div>

			{/* Diet preferences */}
			<div className="section-title">食の好み</div>
			<div className="card">
				<div className="card-title">ダイエットスタイル</div>
				<div className="chip-list">
					{DIET_STYLES.map((style) => (
						<div
							key={style}
							className="chip"
							style={
								dietStyles.includes(style)
									? {}
									: { background: "var(--bg)", color: "var(--text-secondary)" }
							}
							onClick={() => toggleDietStyle(style)}
						>
							{dietStyles.includes(style) ? "✓ " : ""}
							{style}
						</div>
					))}
				</div>
			</div>

			<div className="card">
				<div className="card-title">除外食材（アレルギー・嫌いなもの）</div>
				<div className="chip-list" style={{ marginBottom: 12 }}>
					{excludedFoods.map((food) => (
						<div
							key={food}
							className="chip removable"
							onClick={() => removeExcluded(food)}
						>
							{food}
						</div>
					))}
				</div>
				<div style={{ display: "flex", gap: 8 }}>
					<input
						className="form-input"
						placeholder="例: 甲殻類、乳製品…"
						value={excludedInput}
						onChange={(e) => setExcludedInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && addExcluded()}
					/>
					<button className="btn btn-secondary" onClick={addExcluded}>
						追加
					</button>
				</div>
			</div>

			{/* 危険操作 */}
			<div
				className="section-title"
				style={{ color: "var(--red-text)", marginTop: 24 }}
			>
				危険な操作
			</div>
			<div
				className="card"
				style={{ borderColor: "#fecaca", background: "#fff7f7" }}
			>
				<div style={{ marginBottom: 16 }}>
					<div
						className="card-title"
						style={{ color: "var(--red-text)", marginBottom: 6 }}
					>
						ログアウト
					</div>
					<p
						style={{
							fontSize: 13,
							color: "var(--text-secondary)",
							lineHeight: 1.6,
						}}
					>
						この端末でのログイン状態を解除します。誤操作を避けるため、通常操作から離した位置に置いています。
					</p>
					<button
						className="btn btn-outline btn-sm"
						style={{ marginTop: 12 }}
						onClick={logout}
					>
						<LogOut size={14} strokeWidth={2} style={{ marginRight: 4 }} />
						ログアウト
					</button>
				</div>

				<div style={{ height: 1, background: "#fecaca", marginBottom: 16 }} />

				<div className="card-title" style={{ color: "var(--red-text)" }}>
					アカウント削除
				</div>
				<p
					style={{
						fontSize: 13,
						color: "var(--text-secondary)",
						lineHeight: 1.6,
					}}
				>
					アカウントを削除すると、Firebase
					の認証情報、保存済みの記録、連携設定、APIキー、所属情報が削除され、元に戻せません。
				</p>
				<button
					className="btn btn-danger"
					style={{ marginTop: 12 }}
					disabled={deleteAccountMutation.isPending}
					onClick={() => {
						const confirmed = window.confirm(
							"アカウントを削除すると、ログイン情報と保存データは元に戻せません。本当に削除しますか？",
						);
						if (!confirmed) return;
						deleteAccountMutation.mutate();
					}}
				>
					<Trash2 size={14} strokeWidth={2} style={{ marginRight: 4 }} />
					{deleteAccountMutation.isPending ? "削除中…" : "アカウントを削除"}
				</button>
			</div>

			{/* ビルド情報（最新コードが配信されているか確認用・ナビバーで隠れないよう余白付き） */}
			<div
				style={{
					fontSize: 10,
					color: "var(--text-3, #94a3b8)",
					textAlign: "center",
					marginTop: 24,
					paddingBottom: 96, // ボトムナビゲーション分のスペース
				}}
				title="このバージョンが配信されているコード"
			>
				build:{" "}
				{typeof window !== "undefined" ? window.__APP_COMMIT__ || "—" : "—"}
				{" · "}
				{typeof window !== "undefined" && window.__APP_BUILD_TIME__
					? new Date(window.__APP_BUILD_TIME__).toLocaleString("ja-JP")
					: "—"}
			</div>
		</div>
	);
}
