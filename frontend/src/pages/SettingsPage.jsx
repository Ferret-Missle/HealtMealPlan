import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/Toast";
import {
	getNotificationPermission,
	isNotificationEnabled,
	isNotificationSupported,
	requestNotificationPermission,
	setNotificationEnabled,
} from "../utils/notify";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { authApi, settingsApi } from "../services/api";

const SERVICES = [
	{
		key: "fitbit",
		label: "Fitbit",
		icon: "💚",
		desc: "歩数・睡眠・心拍・体重",
	},
	{
		key: "healthplanet",
		label: "HealthPlanet (タニタ)",
		icon: "⚖️",
		desc: "体重・体脂肪・筋肉量・BMI",
	},
	{
		key: "fatsecret",
		label: "FatSecret",
		icon: "🍎",
		desc: "食品データベース・食事記録",
	},
	{
		key: "google",
		label: "Googleカレンダー",
		icon: "📅",
		desc: "予定取得（外食・運動）",
	},
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

// ─── 通知セクション ──────────────────────────────────────────────────────────
function NotificationSection() {
	const supported = isNotificationSupported();
	const [permission, setPermission] = useState(getNotificationPermission());
	const [enabled, setEnabled] = useState(isNotificationEnabled());
	const [statusMsg, setStatusMsg] = useState("");

	const handleEnable = async () => {
		setStatusMsg("");
		const result = await requestNotificationPermission();
		setPermission(getNotificationPermission());
		if (result.ok) {
			setEnabled(true);
			setStatusMsg("✅ 通知を有効化しました。献立生成完了時に通知されます。");
			// テスト通知
			try {
				new Notification("通知が有効になりました", {
					body: "献立生成の完了をお知らせします",
					icon: "/favicon.ico",
				});
			} catch {
				/* ignore */
			}
		} else if (result.reason === "denied") {
			setStatusMsg(
				"⚠ ブラウザ側で通知がブロックされています。ブラウザの設定から許可してください。",
			);
		} else {
			setStatusMsg(`通知の有効化がキャンセルされました (${result.reason || "—"})`);
		}
	};

	const handleDisable = () => {
		setNotificationEnabled(false);
		setEnabled(false);
		setStatusMsg("通知を無効化しました");
	};

	return (
		<>
			<div className="section-title">通知</div>
			<div className="card">
				{!supported ? (
					<div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
						このブラウザは通知 API に対応していません
					</div>
				) : (
					<>
						<div style={{ marginBottom: 8, fontSize: 13 }}>
							献立生成の完了・エラー通知
						</div>
						<div
							style={{
								fontSize: 11,
								color: "var(--text-secondary)",
								marginBottom: 10,
							}}
						>
							ブラウザ通知を有効化すると、AI による献立生成が完了したときに
							ポップアップ通知でお知らせします。生成中は別の画面に移動していてもOKです。
							<br />
							<span style={{ color: "var(--primary)" }}>
								※ 今後、スマホへのプッシュ通知に対応予定
							</span>
						</div>
						{enabled ? (
							<button
								className="btn btn-secondary"
								onClick={handleDisable}
								style={{ fontSize: 13 }}
							>
								🔕 通知を無効化
							</button>
						) : (
							<button
								className="btn btn-primary"
								onClick={handleEnable}
								disabled={permission === "denied"}
								style={{ fontSize: 13 }}
							>
								{permission === "denied"
									? "🚫 ブラウザでブロック中"
									: "🔔 ブラウザ通知を有効化"}
							</button>
						)}
						{statusMsg && (
							<div
								style={{
									fontSize: 12,
									color: "var(--text-secondary)",
									marginTop: 8,
								}}
							>
								{statusMsg}
							</div>
						)}
					</>
				)}
			</div>
		</>
	);
}

export default function SettingsPage() {
	const { user, profile, logout, refreshProfile } = useAuth();
	const qc = useQueryClient();
	const [searchParams] = useSearchParams();
	const connected = searchParams.get("connected");

	const [newApiKey, setNewApiKey] = useState({
		provider: "anthropic",
		key: "",
	});
	const [showApiKeyForm, setShowApiKeyForm] = useState(false);
	const [excludedInput, setExcludedInput] = useState("");
	// LLMキーフォーム / HealthPlanetモーダル の中だけ inline で出す
	const [apiKeyError,  setApiKeyError]  = useState("");   // LLMプランセクション
	const [hpError,      setHpError]      = useState("");   // HealthPlanet モーダル内
	const toast = useToast();
	// 後方互換シム: setSuccessMsg / setServiceError → toast
	const setSuccessMsg = (msg) => msg && toast.success(msg);
	const setServiceError = (msg) => msg && toast.error(msg);
	// クエリパラメータ ?connected=... 経由の連携完了通知
	useEffect(() => {
		if (connected) toast.success(`${connected} を連携しました！`);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [connected]);

	const { data: settings, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: () => settingsApi.get().then((r) => r.data),
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
			setApiKeyError("");
			setSuccessMsg("APIキーを登録しました");
		},
		onError: (e) => setApiKeyError(e.message),
	});

	const deleteKeyMutation = useMutation({
		mutationFn: (provider) => settingsApi.deleteApiKey(provider),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			refreshProfile();
		},
		onError: (e) => setApiKeyError(e.message),
	});

	const disconnectMutation = useMutation({
		mutationFn: (service) => authApi.disconnect(service),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			refreshProfile();
			setServiceError("");
		},
		onError: (e) => setServiceError(e.message),
	});

	const syncCalMutation = useMutation({
		mutationFn: () => settingsApi.syncCalendars(),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			setServiceError("");
			setSuccessMsg("カレンダーを同期しました");
		},
		onError: (e) => setServiceError(e.message),
	});

	const connectedServices = settings?.connected_services || [];
	const apiKeys = settings?.api_keys || [];
	const dietStyles = settings?.preferences?.diet_styles || [];
	const excludedFoods = settings?.excluded_foods || [];

	// HealthPlanet manual code entry state
	const [hpPendingUserId, setHpPendingUserId] = useState(null);
	const [hpCode, setHpCode] = useState("");
	const [hpSubmitting, setHpSubmitting] = useState(false);

	const handleConnect = async (service) => {
		try {
			if (service === "fitbit") {
				const res = await authApi.fitbitLoginUrl(user.uid);
				window.location.href = res.data.url;
			} else if (service === "healthplanet") {
				const res = await authApi.healthplanetLoginUrl(user.uid);
				window.open(res.data.url, "_blank");
				setHpPendingUserId(user.uid);
				setHpCode("");
			} else if (service === "google") {
				const res = await authApi.googleLoginUrl(user.uid);
				window.location.href = res.data.url;
			} else if (service === "fatsecret") {
				const res = await authApi.fatsecretRequestToken(user.uid);
				window.location.href = res.data.authorize_url;
			}
		} catch (e) {
			setServiceError("連携の開始に失敗しました: " + e.message);
		}
	};

	const handleHealthPlanetCodeSubmit = async () => {
		if (!hpCode.trim()) return;
		let code = hpCode.trim();
		try {
			const urlObj = new URL(code);
			code = urlObj.searchParams.get("code") || code;
		} catch {
			// Not a URL, use as-is
		}
		setHpSubmitting(true);
		try {
			await authApi.healthplanetExchange(hpPendingUserId, code);
			qc.invalidateQueries({ queryKey: ["settings"] });
			setSuccessMsg("HealthPlanet を連携しました！");
			setHpPendingUserId(null);
			setHpCode("");
		} catch (e) {
			setHpError(
				"コードの交換に失敗しました: " + e.message,
			);
		} finally {
			setHpSubmitting(false);
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

	if (isLoading)
		return (
			<div className="loading-screen">
				<div className="spinner" />
			</div>
		);

	return (
		<div>
			<div className="page-header">
				<h1 className="page-title">⚙️ 設定</h1>
				<button
					className="btn btn-outline"
					style={{ fontSize: 12 }}
					onClick={logout}
				>
					ログアウト
				</button>
			</div>

			{/* HealthPlanet manual code entry modal */}
			{hpPendingUserId && (
				<div
					style={{
						position: "fixed",
						inset: 0,
						background: "rgba(0,0,0,0.5)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						zIndex: 1000,
					}}
				>
					<div
						className="card"
						style={{ maxWidth: 480, width: "90%", margin: 0 }}
					>
						<div className="card-title">HealthPlanet 連携コードの入力</div>
						<p style={{ fontSize: 13, marginBottom: 12 }}>
							新しいタブで HealthPlanet の認証ページが開きました。
							<br />
							許可すると <strong>healthplanet.jp/success.html</strong>{" "}
							に移動します。
							<br />
							そのページのブラウザURLバーから <code>?code=</code>{" "}
							以降のコード（または URL 全体）をコピーして貼り付けてください。
						</p>
						<input
							className="input"
							style={{ width: "100%", marginBottom: 8 }}
							placeholder="コードまたはリダイレクト後のURL全体を貼り付け"
							value={hpCode}
							onChange={(e) => setHpCode(e.target.value)}
						/>
						{hpError && (
							<div className="alert alert-error" style={{ marginBottom: 8 }}
								onClick={() => setHpError("")}>
								{hpError}
							</div>
						)}
						<div style={{ display: "flex", gap: 8 }}>
							<button
								className="btn btn-primary"
								onClick={handleHealthPlanetCodeSubmit}
								disabled={hpSubmitting || !hpCode.trim()}
							>
								{hpSubmitting ? "処理中..." : "連携する"}
							</button>
							<button
								className="btn btn-outline"
								onClick={() => { setHpPendingUserId(null); setHpError(""); }}
							>
								キャンセル
							</button>
						</div>
					</div>
				</div>
			)}

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
				<div
					style={{
						marginTop: 8,
						display: "flex",
						alignItems: "center",
						gap: 8,
					}}
				>
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
				</div>
			</div>

			{/* API connections */}
			<div className="section-title">外部サービス連携</div>
			{SERVICES.map((svc) => {
				const isConnected = connectedServices.includes(svc.key);
				return (
					<div className="card service-card" key={svc.key}>
						<div className="service-card-inner">
							<div className="service-card-info">
								<div className="service-card-name">
									{svc.icon} {svc.label}
								</div>
								<div className="service-card-desc">{svc.desc}</div>
							</div>
							<div className="service-card-action">
								{isConnected ? (
									<>
										<span className="connected-badge">連携済み</span>
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
										連携する
									</button>
								)}
							</div>
						</div>
					</div>
				);
			})}

			{/* Calendar sync */}
			{connectedServices.includes("google") && (
				<button
					className="btn btn-outline btn-full"
					style={{ marginBottom: 12 }}
					onClick={() => syncCalMutation.mutate()}
					disabled={syncCalMutation.isPending}
				>
					{syncCalMutation.isPending
						? "カレンダー同期中..."
						: "📅 カレンダーリストを同期"}
				</button>
			)}

			{/* 通知設定 */}
			<NotificationSection />

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

				{/* BYOK ユーザー向け：無料 LLM 切替トグル（API キーが1つでも登録されていれば表示） */}
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
								alignItems: "center",
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
											setApiKeyError(err.response?.data?.detail || err.message),
										);
								}}
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

				{/* 身体情報スコープ選択 */}
				<div className="form-group" style={{ marginBottom: 12 }}>
					<label className="form-label">献立に反映する身体情報の量</label>
					<select
						className="form-input"
						value={settings?.preferences?.body_data_scope || "off"}
						onChange={(e) => {
							const newPrefs = {
								...(settings?.preferences || {}),
								body_data_scope: e.target.value,
							};
							preferencesMutation.mutate({ preferences: newPrefs });
						}}
					>
						<option value="off">使わない（最低トークン）</option>
						<option value="minimal">最小：体重・体脂肪・BMI・目標体重</option>
						<option value="medium">中：+ 活動量・体重トレンド</option>
						<option value="full">大：+ 直近7日の食事量比較</option>
					</select>
					<div
						style={{
							fontSize: 11,
							color: "var(--text-secondary)",
							marginTop: 4,
						}}
					>
						※ 量を増やすほど精度が上がりますが、LLMトークン使用量が増えます（off→full で約 +500〜1500 tok/食）
					</div>
				</div>

				{/* モデル選択 */}
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
										setApiKeyError(err.response?.data?.detail || err.message),
									);
							}}
						>
							<option value="">デフォルト（自動）</option>
							{settings.plan.available_models.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
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
							※ プランによって選択できるモデルが変わります。高品質モデルほどコストとトークンが増えます。
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
								...{k.hint}
							</div>
						</div>
						<button
							className="btn btn-danger"
							style={{ fontSize: 12, padding: "4px 10px" }}
							onClick={() => deleteKeyMutation.mutate(k.provider)}
						>
							削除
						</button>
					</div>
				))}

				<button
					className="btn btn-secondary btn-full"
					style={{ marginTop: 12 }}
					onClick={() => setShowApiKeyForm(true)}
				>
					+ APIキーを追加（BYOKプランに切り替え）
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
								placeholder="sk-..."
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
						{apiKeyError && (
							<div className="alert alert-error" style={{ marginBottom: 8 }}
								onClick={() => setApiKeyError("")}>
								{apiKeyError}
							</div>
						)}
						<div style={{ display: "flex", gap: 8 }}>
							<button
								className="btn btn-primary"
								style={{ flex: 1 }}
								onClick={() => {
									setApiKeyError("");
									apiKeyMutation.mutate({
										provider: newApiKey.provider,
										api_key: newApiKey.key,
									});
								}}
								disabled={!newApiKey.key || apiKeyMutation.isPending}
							>
								{apiKeyMutation.isPending ? "登録中..." : "登録"}
							</button>
							<button
								className="btn btn-outline"
								onClick={() => { setShowApiKeyForm(false); setApiKeyError(""); }}
							>
								キャンセル
							</button>
						</div>
					</div>
				)}
				{/* APIキー削除エラー（フォームが閉じていても表示） */}
				{apiKeyError && !showApiKeyForm && (
					<div className="alert alert-error" style={{ marginTop: 8, cursor: "pointer" }}
						onClick={() => setApiKeyError("")}>
						{apiKeyError}
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
									: { background: "#f5f5f5", color: "var(--text-secondary)" }
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
						placeholder="例: 甲殻類、乳製品..."
						value={excludedInput}
						onChange={(e) => setExcludedInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && addExcluded()}
					/>
					<button className="btn btn-secondary" onClick={addExcluded}>
						追加
					</button>
				</div>
			</div>
		</div>
	);
}
