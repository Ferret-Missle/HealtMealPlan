import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, LogOut, UserPlus } from "lucide-react";
import { useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { groupApi } from "../../services/api";

export default function GroupSection() {
	const { user } = useAuth();
	const qc = useQueryClient();
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteUrl, setInviteUrl] = useState("");
	const [newGroupName, setNewGroupName] = useState("");
	const [showCreate, setShowCreate] = useState(false);
	const [error, setError] = useState("");
	const [success, setSuccess] = useState("");

	const { data: group, isLoading } = useQuery({
		queryKey: ["my-group"],
		queryFn: () => groupApi.myGroup().then((r) => r.data),
	});

	const inviteMutation = useMutation({
		mutationFn: (email) => groupApi.invite(group.id, { email }),
		onSuccess: (res) => {
			setInviteUrl(res.data.invite_url);
			setSuccess("招待リンクを生成しました");
		},
		onError: (e) => setError(e.response?.data?.detail || e.message),
	});

	const transferMutation = useMutation({
		mutationFn: (targetUserId) =>
			groupApi.transferOwner(group.id, targetUserId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["my-group"] });
			setSuccess("オーナー権限を移譲しました");
		},
		onError: (e) => setError(e.response?.data?.detail || e.message),
	});

	const cancelInviteMutation = useMutation({
		mutationFn: (inviteId) => groupApi.cancelInvitation(group.id, inviteId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["my-group"] });
			setSuccess("招待を取り消しました");
		},
		onError: (e) => setError(e.response?.data?.detail || e.message),
	});

	const leaveMutation = useMutation({
		mutationFn: () => groupApi.leave(group.id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["my-group"] });
			setSuccess("グループから脱退しました");
		},
		onError: (e) => setError(e.response?.data?.detail || e.message),
	});

	const createMutation = useMutation({
		mutationFn: (name) => groupApi.create({ name, type: "family" }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["my-group"] });
			setShowCreate(false);
			setNewGroupName("");
			setSuccess("グループを作成しました");
		},
		onError: (e) => setError(e.message),
	});

	if (isLoading)
		return (
			<div className="loading-screen">
				<div className="spinner" />
			</div>
		);

	return (
		<div>
			{error && (
				<div className="alert alert-error" onClick={() => setError("")}>
					{error}
				</div>
			)}
			{success && (
				<div className="alert alert-success" onClick={() => setSuccess("")}>
					{success}
				</div>
			)}

			{group && (
				<>
					<div className="card">
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "flex-start",
							}}
						>
							<div>
								<div style={{ fontWeight: 700, fontSize: 16 }}>
									{group.name}
								</div>
								<div
									style={{
										fontSize: 13,
										color: "var(--text-secondary)",
										marginTop: 2,
									}}
								>
									{group.type === "personal" ? "個人グループ" : "家族グループ"}
								</div>
							</div>
							<span className="tag tag-green">
								{group.role === "owner" ? "オーナー" : "メンバー"}
							</span>
						</div>

						<div style={{ marginTop: 12 }}>
							<div className="card-title">
								メンバー ({group.members.length}/7)
							</div>
							{group.members.map((m) => (
								<div key={m.user_id} className="list-item">
									<div>
										<div style={{ fontSize: 14, fontWeight: 500 }}>
											{m.name}
										</div>
										<div
											style={{ fontSize: 12, color: "var(--text-secondary)" }}
										>
											{m.role === "owner" ? "👑 オーナー" : "メンバー"}
											{!m.privacy_public && " · データ非公開"}
										</div>
									</div>
									<div
										style={{ display: "flex", gap: 6, alignItems: "center" }}
									>
										{m.user_id === user.uid && (
											<span className="tag tag-gray">あなた</span>
										)}
										{/* オーナーが他のメンバーに権限を移譲 */}
										{group.role === "owner" &&
											m.user_id !== user.uid &&
											m.role !== "owner" && (
												<button
													className="btn btn-outline"
													style={{ fontSize: 11, padding: "3px 8px" }}
													disabled={transferMutation.isPending}
													onClick={() => {
														if (
															window.confirm(
																`${m.name} さんにオーナー権限を移譲しますか？\nあなたはメンバーになります。`,
															)
														) {
															transferMutation.mutate(m.user_id);
														}
													}}
												>
													👑 移譲
												</button>
											)}
									</div>
								</div>
							))}
							{group.pending_invitation_list?.length > 0 && (
								<div style={{ marginTop: 8 }}>
									<div
										style={{
											fontSize: 12,
											fontWeight: 600,
											color: "var(--text-secondary)",
											marginBottom: 4,
										}}
									>
										招待中（{group.pending_invitation_list.length}人）
									</div>
									{group.pending_invitation_list.map((inv) => (
										<div
											key={inv.id}
											className="list-item"
											style={{
												background: "var(--bg)",
												borderRadius: 8,
												padding: "6px 10px",
												marginBottom: 4,
											}}
										>
											<div>
												<div style={{ fontSize: 13, fontWeight: 500 }}>
													{inv.email}
												</div>
												<div
													style={{
														fontSize: 11,
														color: "var(--text-secondary)",
													}}
												>
													有効期限:{" "}
													{new Date(inv.expires_at).toLocaleString("ja-JP", {
														month: "numeric",
														day: "numeric",
														hour: "2-digit",
														minute: "2-digit",
													})}
												</div>
											</div>
											{group.role === "owner" && (
												<button
													className="btn btn-danger"
													style={{ fontSize: 12, padding: "3px 10px" }}
													onClick={() => {
														if (
															window.confirm(
																`${inv.email} への招待を取り消しますか？`,
															)
														) {
															cancelInviteMutation.mutate(inv.id);
														}
													}}
													disabled={cancelInviteMutation.isPending}
												>
													取り消し
												</button>
											)}
										</div>
									))}
								</div>
							)}
						</div>
					</div>

					{/* Invite (owner only) */}
					{group.role === "owner" &&
						group.type === "family" &&
						group.total_slots_used < 7 && (
							<div className="card">
								<div className="card-title">メンバーを招待</div>
								<div style={{ display: "flex", gap: 8 }}>
									<input
										className="form-input"
										type="email"
										placeholder="招待するメールアドレス"
										value={inviteEmail}
										onChange={(e) => setInviteEmail(e.target.value)}
									/>
									<button
										className="btn btn-primary"
										onClick={() => inviteMutation.mutate(inviteEmail)}
										disabled={!inviteEmail || inviteMutation.isPending}
									>
										<UserPlus
											size={15}
											strokeWidth={2}
											style={{ marginRight: 4 }}
										/>
										招待
									</button>
								</div>
								{inviteUrl && (
									<div
										style={{
											marginTop: 8,
											padding: 8,
											background: "var(--bg)",
											borderRadius: 8,
										}}
									>
										<div
											style={{
												fontSize: 12,
												color: "var(--text-secondary)",
												marginBottom: 4,
											}}
										>
											招待リンク（72時間有効・1回限り）:
										</div>
										<div
											style={{
												fontSize: 12,
												wordBreak: "break-all",
												color: "var(--green-800)",
											}}
										>
											{inviteUrl}
										</div>
										<button
											className="btn btn-outline"
											style={{
												fontSize: 12,
												marginTop: 8,
												padding: "4px 12px",
											}}
											onClick={() => navigator.clipboard.writeText(inviteUrl)}
										>
											<Copy
												size={13}
												strokeWidth={2}
												style={{ marginRight: 4 }}
											/>
											コピー
										</button>
									</div>
								)}
							</div>
						)}

					{/* Switch to family group */}
					{group.type === "personal" && group.role === "owner" && (
						<div className="card">
							<div className="card-title">家族グループを作成</div>
							<p
								style={{
									fontSize: 13,
									color: "var(--text-secondary)",
									marginBottom: 12,
								}}
							>
								現在は個人グループです。家族グループを作成すると、メンバーを招待してグループで献立を管理できます。
							</p>
							{!showCreate ? (
								<button
									className="btn btn-primary btn-full"
									onClick={() => setShowCreate(true)}
								>
									家族グループを作成
								</button>
							) : (
								<div>
									<input
										className="form-input"
										placeholder="グループ名（例: 山田家）"
										value={newGroupName}
										onChange={(e) => setNewGroupName(e.target.value)}
										style={{ marginBottom: 8 }}
									/>
									<div style={{ display: "flex", gap: 8 }}>
										<button
											className="btn btn-primary"
											style={{ flex: 1 }}
											onClick={() => createMutation.mutate(newGroupName)}
											disabled={!newGroupName || createMutation.isPending}
										>
											作成
										</button>
										<button
											className="btn btn-outline"
											onClick={() => setShowCreate(false)}
										>
											キャンセル
										</button>
									</div>
								</div>
							)}
						</div>
					)}

					{/* Leave group */}
					{group.type === "family" && (
						<div style={{ marginTop: 16 }}>
							<button
								className="btn btn-danger btn-full"
								onClick={() => {
									if (window.confirm("グループから脱退しますか？"))
										leaveMutation.mutate();
								}}
								disabled={leaveMutation.isPending}
							>
								<LogOut size={15} strokeWidth={2} style={{ marginRight: 4 }} />
								グループを脱退
							</button>
							{group.role === "owner" && group.members.length > 1 && (
								<div
									style={{
										fontSize: 12,
										color: "var(--text-secondary)",
										marginTop: 4,
										textAlign: "center",
									}}
								>
									※ メンバー一覧の「👑 移譲」ボタンで先に権限を移譲してください
								</div>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}
