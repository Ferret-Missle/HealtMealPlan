import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import './firebase.js'

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
