import { Link } from 'react-router-dom';

export default function PrivacyPage() {
  return (
    <div className="legal-page">
      <div className="legal-container">
        <Link to="/login" className="legal-back-link">← ログイン画面に戻る</Link>
        <header className="legal-header">
          <h1>プライバシーポリシー</h1>
          <p className="legal-meta">最終更新日: 2026年5月1日</p>
        </header>

        <section className="legal-section">
          <h2>1. 取得する情報</h2>
          <p>本サービスでは、以下の情報を取得します。</p>
          <ul>
            <li><strong>アカウント情報</strong>: 氏名、メールアドレス、パスワード（ハッシュ化して保存）</li>
            <li><strong>健康データ</strong>: 体重、身長、歩数、睡眠、食事記録、目標カロリーなど</li>
            <li><strong>外部連携データ</strong>: Fitbit / Google Fit / FatSecret などから取得した活動・栄養データ</li>
            <li><strong>利用ログ</strong>: アクセス日時、IPアドレス、ブラウザ情報、操作履歴</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>2. 利用目的</h2>
          <ul>
            <li>本サービスの提供および機能改善</li>
            <li>AIによる献立提案・健康アドバイスの生成</li>
            <li>外部サービス（Fitbitなど）との連携機能の実現</li>
            <li>不正アクセスの検知および防止</li>
            <li>ユーザーからの問い合わせ対応</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>3. 健康データの取り扱い</h2>
          <p>
            ユーザーの健康データは、本サービスの機能提供に必要な範囲でのみ利用します。匿名化・統計化された情報を除き、ユーザー個人を特定できる形で第三者に提供することはありません。
          </p>
        </section>

        <section className="legal-section">
          <h2>4. 第三者提供</h2>
          <p>以下の場合を除き、ユーザーの個人情報を第三者へ提供することはありません。</p>
          <ul>
            <li>ユーザーの同意がある場合</li>
            <li>法令に基づく開示請求があった場合</li>
            <li>人の生命・身体・財産の保護のために必要であって本人の同意を得ることが困難な場合</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>5. 外部サービス連携</h2>
          <p>
            ユーザーが Fitbit / Google Fit / FatSecret などの外部サービスを連携した場合、各サービスのプライバシーポリシーが適用されます。連携の解除はマイページ &gt; サービス連携 から随時行えます。
          </p>
        </section>

        <section className="legal-section">
          <h2>6. Cookie等の利用</h2>
          <p>
            本サービスは、ログイン状態の維持や利便性向上のために Cookie および類似技術を利用します。ブラウザ設定により Cookie を無効化できますが、一部機能が利用できなくなる場合があります。
          </p>
        </section>

        <section className="legal-section">
          <h2>7. データの保管・セキュリティ</h2>
          <p>
            取得した情報は、暗号化通信（HTTPS）で送受信し、適切なアクセス制御のもと保管します。ただし、インターネット上の通信に絶対的な安全は存在せず、運営者は合理的な範囲での安全管理措置を講じます。
          </p>
        </section>

        <section className="legal-section">
          <h2>8. ユーザーの権利</h2>
          <p>
            ユーザーは、自身の個人情報について、開示・訂正・削除を求めることができます。マイページから直接編集できる項目に加え、アカウント削除を希望する場合はサポート窓口までご連絡ください。
          </p>
        </section>

        <section className="legal-section">
          <h2>9. お問い合わせ</h2>
          <p>
            本ポリシーに関するお問い合わせは、サポート窓口（マイページ &gt; ヘルプ）までお願いいたします。
          </p>
        </section>

        <section className="legal-section">
          <h2>10. ポリシーの変更</h2>
          <p>
            本ポリシーは、必要に応じて変更されることがあります。重要な変更がある場合は、本サービス上で通知します。
          </p>
        </section>

        <footer className="legal-footer">
          <Link to="/terms" className="legal-link">利用規約を見る →</Link>
          <Link to="/login" className="btn btn-primary btn-full" style={{ marginTop: 16 }}>ログイン画面に戻る</Link>
        </footer>
      </div>
    </div>
  );
}
