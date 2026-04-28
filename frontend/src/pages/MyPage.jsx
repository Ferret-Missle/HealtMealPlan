import { useState } from 'react';
import { Scale, Moon, Users, Settings } from 'lucide-react';
import BodyWeightSection from './sections/BodyWeightSection';
import GroupSection from './sections/GroupSection';
import SettingsSection from './sections/SettingsSection';

const TABS = [
  { key: 'body',     label: '体重・睡眠', Icon: Scale },
  { key: 'group',    label: 'グループ',   Icon: Users },
  { key: 'settings', label: '設定',       Icon: Settings },
];

export default function MyPage() {
  const [activeTab, setActiveTab] = useState('body');

  return (
    <div>
      {/* Internal tab bar */}
      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            className={`tab-btn${activeTab === key ? ' active' : ''}`}
            onClick={() => setActiveTab(key)}
          >
            <Icon size={15} strokeWidth={1.8} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'body'     && <BodyWeightSection />}
      {activeTab === 'group'    && <GroupSection />}
      {activeTab === 'settings' && <SettingsSection />}
    </div>
  );
}
