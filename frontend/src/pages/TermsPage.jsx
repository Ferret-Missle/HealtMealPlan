import { Link, useNavigate } from 'react-router-dom';

export default function TermsPage() {
  const navigate = useNavigate();
  return (
    <div className="legal-page">
      <div className="legal-container">
        <header className="legal-header">
          <button className="legal-back" onClick={() => navigate(-1)} aria-label="戻る">←</button>
          <h1>利用規約</h1>
          <p className="legal-meta">最終更新日: 2026年5月1日</p>
        </header>

        <section className="legal-section">
          <h2>第1条（適用）</h2>
          <p>
            本規約は、健康ナビ（以下「本サービス」）の利用に関する条件を、本サービスの利用者（以下「ユーザー」）と運営者との間で定めるものです。ユーザーは本規約に同意したうえで本サービスを利用するものとします。
          </p>
        </section>

        <section className="legal-section">
          <h2>第2条（アカウント登録）</h2>
          <ul>
            <li>ユーザーは正確かつ最新の情報を登録するものとします。</li>
            <li>登録情報の管理責任はユーザーが負うものとし、第三者と共有してはなりません。</li>
            <li>運営者は、虚偽の情報による登録、または規約違反が認められた場合、アカウントを停止できるものとします。</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>第3条（健康データの取り扱い）</h2>
          <p>
            本サービスは、ユーザーが入力または連携した健康データ（体重・歩数・食事記録・睡眠など）を、献立提案や健康管理機能の提供のために利用します。これらのデータは、ユーザーの明示的な同意なく第三者へ提供することはありません。
          </p>
        </section>

        <section className="legal-section">
          <h2>第4条（禁止事項）</h2>
          <ul>
            <li>法令または公序良俗に反する行為</li>
            <li>本サービスの運営を妨害する行為</li>
            <li>他のユーザーまたは第三者の権利を侵害する行為</li>
            <li>不正アクセスやリバースエンジニアリング</li>
            <li>本サービスを商業目的で無断利用する行為</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>第5条（免責事項）</h2>
          <p>
            本サービスが提供する献立や健康アドバイスは、医療行為や専門家による診断を代替するものではありません。重大な健康上の判断を行う際は、必ず医師や管理栄養士など専門家にご相談ください。本サービスの利用により生じた損害について、運営者は一切の責任を負わないものとします。
          </p>
        </section>

        <section className="legal-section">
          <h2>第6条（サービスの変更・終了）</h2>
          <p>
            運営者は、ユーザーへの事前通知なく、本サービスの内容を変更または終了できるものとします。これによりユーザーに損害が生じた場合でも、運営者は責任を負わないものとします。
          </p>
        </section>

        <section className="legal-section">
          <h2>第7条（規約の変更）</h2>
          <p>
            運営者は、必要に応じて本規約を変更できるものとします。変更後の規約は、本サービス上に掲載した時点で効力を生じます。
          </p>
        </section>

        <section className="legal-section">
          <h2>第8条（準拠法・管轄）</h2>
          <p>
            本規約の解釈には日本法を適用し、本サービスに関して紛争が生じた場合は、運営者の所在地を管轄する裁判所を専属的合意管轄とします。
          </p>
        </section>

        <footer className="legal-footer">
          <Link to="/privacy" className="legal-link">プライバシーポリシーを見る →</Link>
        </footer>
      </div>
    </div>
  );
}
