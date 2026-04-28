import { useRef, useState } from 'react'
import { mealsApi } from '../services/api'

/**
 * S2-06: 食事写真撮影 → Vision LLMで栄養推定
 * onEstimated(result) コールバックで推定結果を返す
 */
export default function PhotoCapture({ mealType = 'lunch', onEstimated, onClose }) {
  const fileRef = useRef(null)
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => setPreview({ dataUrl: ev.target.result, file })
    reader.readAsDataURL(file)
  }

  const handleEstimate = async () => {
    if (!preview) return
    setLoading(true)
    setError(null)
    try {
      // Strip data URL prefix → pure base64
      const b64 = preview.dataUrl.split(',')[1]
      const mime = preview.file.type || 'image/jpeg'
      const result = await mealsApi.photoEstimate({ image_b64: b64, mime_type: mime, meal_type: mealType })
      onEstimated(result)
    } catch (err) {
      const msg = err.response?.data?.detail || '推定に失敗しました。Vision対応BYOKプランが必要です。'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content photo-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>📷 食事写真から栄養を推定</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <p className="scan-hint">食事の写真を選択してください（JPEG/PNG）</p>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={handleFile}
          style={{ display: 'none' }}
        />

        {!preview ? (
          <div className="photo-actions">
            <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
              📸 カメラで撮影 / ファイルを選択
            </button>
          </div>
        ) : (
          <div className="photo-preview-area">
            <img src={preview.dataUrl} alt="preview" className="photo-preview-img" />
            <div className="photo-actions">
              <button className="btn btn-secondary" onClick={() => setPreview(null)}>
                撮り直す
              </button>
              <button
                className="btn btn-primary"
                onClick={handleEstimate}
                disabled={loading}
              >
                {loading ? '推定中...' : 'AI栄養推定'}
              </button>
            </div>
          </div>
        )}

        {error && <p className="error-text" style={{ marginTop: '0.5rem' }}>{error}</p>}

        <button className="btn btn-ghost" onClick={onClose} style={{ marginTop: '1rem' }}>
          キャンセル
        </button>
      </div>
    </div>
  )
}
