import { useEffect, useRef, useState } from 'react'
import { Html5QrcodeScanner } from 'html5-qrcode'

/**
 * S2-05: バーコードスキャンコンポーネント
 * onResult(barcode: string) コールバックで結果を返す
 */
export default function BarcodeScanner({ onResult, onClose }) {
  const scannerRef = useRef(null)
  const [error, setError] = useState(null)
  const containerId = 'barcode-scanner-container'

  useEffect(() => {
    const scanner = new Html5QrcodeScanner(
      containerId,
      {
        fps: 10,
        qrbox: { width: 250, height: 150 },
        aspectRatio: 1.0,
        supportedScanTypes: [0], // QR_CODE=0 includes barcodes
        formatsToSupport: [
          /* EAN-13, EAN-8, UPC-A, UPC-E, Code-128, Code-39 */
          2, 3, 6, 7, 10, 11
        ],
      },
      false
    )

    scanner.render(
      (decodedText) => {
        scanner.clear().catch(() => {})
        onResult(decodedText)
      },
      (errorMsg) => {
        // scanning in progress - ignore minor errors
      }
    )

    scannerRef.current = scanner

    return () => {
      scanner.clear().catch(() => {})
    }
  }, [onResult])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content barcode-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>バーコードをスキャン</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <p className="scan-hint">パッケージのバーコードをカメラに向けてください</p>
        {error && <p className="error-text">{error}</p>}
        <div id={containerId} />
        <button className="btn btn-secondary" onClick={onClose} style={{ marginTop: '1rem' }}>
          キャンセル
        </button>
      </div>
    </div>
  )
}
