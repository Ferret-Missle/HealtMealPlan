import { Settings, Users } from "lucide-react";
import { useState } from "react";
import GroupSection from "./sections/GroupSection";
import SettingsSection from "./sections/SettingsSection";

const TABS = [
	{ key: "settings", label: "設定", Icon: Settings },
	{ key: "group", label: "グループ", Icon: Users },
];

export default function MyPage() {
	const [activeTab, setActiveTab] = useState("settings");

	return (
		<div>
			<div className="page-header">
				<h1 className="page-title">マイページ</h1>
			</div>

			<div className="tab-bar" style={{ marginBottom: 16 }}>
				{TABS.map(({ key, label, Icon }) => (
					<button
						key={key}
						className={`tab-btn${activeTab === key ? " active" : ""}`}
						onClick={() => setActiveTab(key)}
					>
						<Icon
							size={15}
							strokeWidth={1.5}
							style={{ marginRight: 4, verticalAlign: "middle" }}
						/>
						{label}
					</button>
				))}
			</div>

			{activeTab === "settings" && <SettingsSection />}
			{activeTab === "group" && <GroupSection />}
		</div>
	);
}
