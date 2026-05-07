import { useState, useRef, useEffect } from 'react'
import { chatApi } from '../services/api'

/**
 * S2-04: AIチャット相談ウィジェット
 * フローティングボタン → チャットパネル（モバイル全画面）
 */
export default function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'こんにちは！栄養・食事についてお気軽に質問してください🥗' }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [planInfo, setPlanInfo] = useState(null)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  const send = async () => {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setLoading(true)

    try {
      const history = messages.slice(-6).map(m => ({ role: m.role, content: m.content }))
      const data = await chatApi.send({ message: text, history })
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply,
        tokens: {
          input: data.input_tokens,
          output: data.output_tokens,
          model: data.llm_model,
        }
      }])
      setPlanInfo(data.plan_type)
    } catch (err) {
      const msg = err.response?.data?.detail || 'エラーが発生しました。しばらくしてからお試しください。'
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${msg}` }])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        className="chat-fab"
        onClick={() => setOpen(o => !o)}
        aria-label="AIチャット相談"
        title="AIアドバイザーに相談"
      >
        {open ? '✕' : '💬'}
      </button>

      {open && (
        <div className="chat-panel">
          <div className="chat-panel-header">
            <span>🥗 栄養アドバイザー</span>
            {planInfo === 'free' && (
              <span className="chat-limit-badge">無料: 月5回</span>
            )}
            <button className="btn-icon" onClick={() => setOpen(false)}>✕</button>
          </div>

          <div className="chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`chat-bubble ${msg.role}`}>
                {msg.role === 'assistant' && <span className="chat-avatar">🤖</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{msg.content}</p>
                  {msg.tokens && (msg.tokens.input != null || msg.tokens.output != null) && (
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 10,
                        color: 'var(--text-3, #94a3b8)',
                        display: 'flex',
                        gap: 6,
                        flexWrap: 'wrap',
                      }}
                    >
                      {msg.tokens.model && <span>🤖 {msg.tokens.model}</span>}
                      {msg.tokens.input != null && <span>入力 {msg.tokens.input.toLocaleString()} tok</span>}
                      {msg.tokens.output != null && <span>出力 {msg.tokens.output.toLocaleString()} tok</span>}
                      {msg.tokens.input != null && msg.tokens.output != null && (
                        <span>合計 {(msg.tokens.input + msg.tokens.output).toLocaleString()} tok</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="chat-bubble assistant">
                <span className="chat-avatar">🤖</span>
                <p className="typing-indicator">
                  <span /><span /><span />
                </p>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="chat-input-row">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="質問を入力（Enterで送信）"
              rows={2}
              disabled={loading}
            />
            <button
              className="btn btn-primary chat-send-btn"
              onClick={send}
              disabled={!input.trim() || loading}
            >
              送信
            </button>
          </div>
        </div>
      )}
    </>
  )
}
