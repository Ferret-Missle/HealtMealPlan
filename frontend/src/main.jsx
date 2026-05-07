import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import './firebase.js'

// ビルド情報をコンソールに出力（最新バンドルが配信されているか確認用）
// eslint-disable-next-line no-undef
const __commit = typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'unknown'
// eslint-disable-next-line no-undef
const __buildTime = typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : 'unknown'
console.info(`%c健康ナビ %ccommit=${__commit} %cbuild=${__buildTime}`,
  'color:#16a34a;font-weight:bold', 'color:#3b82f6', 'color:#94a3b8')
window.__APP_COMMIT__ = __commit
window.__APP_BUILD_TIME__ = __buildTime

// Service Worker の新バージョン検知 → 自動リロード
// （古い SW がキャッシュした古いバンドルを表示し続ける問題を解消）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (window.__sw_reloading) return
    window.__sw_reloading = true
    window.location.reload()
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
