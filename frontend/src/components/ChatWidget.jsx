import { useState, useRef, useEffect } from 'react'
import { Send, X, Trash2, Bot, User as UserIcon, Sparkles } from 'lucide-react'
import { chatApi } from '../services/api'

/**
 * S2-04: AI チャット相談ウィジェット
 * フローティングボタン → チャットパネル（モバイル全画面）
 */
const STORAGE_KEY = 'chat_history_v2'
const SUGGESTIONS = [
  '今日の食事をどう改善すればいい？',
  '減量に効果的な朝食は？',
  '最近の体重トレンドはどう？',
  'PFC バランスを改善するメニューを教えて',
  'おすすめの間食を教えて',
]

const INITIAL_MSG = {
  role: 'assistant',
  content:
    'こんにちは！🥗 栄養・食事・健康習慣についてお気軽に質問してください。\n体重・歩数・食事ログなど、連携済みのデータを参考にお答えします。',
}

function loadStoredMessages() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return [INITIAL_MSG]
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length ? parsed : [INITIAL_MSG]
  } catch {
    return [INITIAL_MSG]
  }
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState(loadStoredMessages)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [planInfo, setPlanInfo] = useState(null)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  // メッセージ永続化
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-30)))
    } catch {
      /* ignore */
    }
  }, [messages])

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, open, loading])

  // テキストエリア自動リサイズ
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [input])

  const send = async (textArg) => {
    const text = (textArg ?? input).trim()
    if (!text || loading) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setLoading(true)

    try {
      const history = messages
        .slice(-6)
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, content: m.content }))
      const data = await chatApi.send({ message: text, history })
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.reply,
          tokens: {
            input: data.input_tokens,
            output: data.output_tokens,
            model: data.llm_model,
          },
        },
      ])
      setPlanInfo(data.plan_type)
    } catch (err) {
      const msg =
        err.response?.data?.detail ||
        err.message ||
        'エラーが発生しました。しばらくしてからお試しください。'
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `⚠ ${msg}`, error: true },
      ])
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

  const clearChat = () => {
    if (window.confirm('チャット履歴をクリアしますか？')) {
      setMessages([INITIAL_MSG])
    }
  }

  const showSuggestions = messages.length <= 1 && !loading

  return (
    <>
      {/* Floating button */}
      <button
        className="chat-fab"
        onClick={() => setOpen((o) => !o)}
        aria-label="AIチャット相談"
        title="AIアドバイザーに相談"
      >
        {open ? <X size={22} strokeWidth={2.5} /> : <Sparkles size={22} strokeWidth={2} />}
      </button>

      {open && (
        <div className="chat-panel-v2">
          <div className="chat-panel-header-v2">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="chat-header-avatar">
                <Bot size={16} strokeWidth={2} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>栄養アドバイザー</div>
                <div style={{ fontSize: 10, opacity: 0.85 }}>
                  あなたの実データを参考にお答えします
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className="chat-icon-btn"
                onClick={clearChat}
                title="履歴をクリア"
                aria-label="履歴をクリア"
              >
                <Trash2 size={14} strokeWidth={2} />
              </button>
              <button
                className="chat-icon-btn"
                onClick={() => setOpen(false)}
                title="閉じる"
                aria-label="閉じる"
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>
          </div>

          {planInfo === 'free' && (
            <div className="chat-plan-banner">
              🆓 無料プラン (Groq) ・ 月 5 回まで
            </div>
          )}

          <div className="chat-messages-v2">
            {messages.map((msg, i) => (
              <div key={i} className={`chat-row chat-row-${msg.role}`}>
                <div className="chat-avatar-v2">
                  {msg.role === 'assistant' ? (
                    <Bot size={14} strokeWidth={2} />
                  ) : (
                    <UserIcon size={14} strokeWidth={2} />
                  )}
                </div>
                <div className="chat-bubble-v2" data-role={msg.role} data-error={msg.error || false}>
                  <div className="chat-bubble-text">{msg.content}</div>
                  {msg.tokens && (msg.tokens.input != null || msg.tokens.output != null) && (
                    <div className="chat-tokens">
                      {msg.tokens.model && <span>🤖 {msg.tokens.model}</span>}
                      {msg.tokens.input != null && (
                        <span>入力 {msg.tokens.input.toLocaleString()}</span>
                      )}
                      {msg.tokens.output != null && (
                        <span>出力 {msg.tokens.output.toLocaleString()}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="chat-row chat-row-assistant">
                <div className="chat-avatar-v2">
                  <Bot size={14} strokeWidth={2} />
                </div>
                <div className="chat-bubble-v2" data-role="assistant">
                  <div className="chat-typing">
                    <span /><span /><span />
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* サジェスト（初回のみ表示） */}
          {showSuggestions && (
            <div className="chat-suggestions">
              <div className="chat-suggestions-label">💡 質問の例:</div>
              <div className="chat-suggestions-list">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    className="chat-suggestion-chip"
                    onClick={() => send(s)}
                    disabled={loading}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="chat-input-row-v2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="質問を入力 (Enter で送信 / Shift+Enter で改行)"
              rows={1}
              disabled={loading}
            />
            <button
              className="chat-send-btn-v2"
              onClick={() => send()}
              disabled={!input.trim() || loading}
              aria-label="送信"
              title="送信"
            >
              <Send size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
