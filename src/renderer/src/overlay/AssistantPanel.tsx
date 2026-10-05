import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiEvent } from '@shared/types'
import { zepper } from '../bridge'
import { IconArrowRight, IconSparkle } from '../icons'
import { useUiEvents } from '../useSnapshot'

interface Reply {
  requestId: string
  question: string | null
  text: string
  done: boolean
  error?: string
}

const newId = (): string => Math.random().toString(36).slice(2)

/**
 * "Ask this page": a summary of the page as soon as it opens, then questions about it, answered
 * by Apple Intelligence on the Mac. Answers stream in as they're written.
 */
export function AssistantPanel({ title, host }: { title: string; host: string }): React.JSX.Element {
  const [replies, setReplies] = useState<Reply[]>(() => [{ requestId: newId(), question: null, text: '', done: false }])
  const [question, setQuestion] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const busy = replies.some((r) => !r.done)

  // The summary starts straight away.
  useEffect(() => {
    zepper.send({ type: 'assistant.run', requestId: replies[0].requestId })
    input.current?.focus()
    // Only on open.
  }, [])

  useUiEvents(
    useCallback((event: UiEvent) => {
      if (event.type !== 'assistant.text') return
      setReplies((all) =>
        all.map((r) => (r.requestId === event.requestId ? { ...r, text: event.text, done: event.done, error: event.error } : r))
      )
    }, [])
  )

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [replies])

  const ask = (): void => {
    const text = question.trim()
    if (!text || busy) return
    const history = replies.filter((r) => r.question && r.done && !r.error).map((r) => [r.question!, r.text] as [string, string])
    const reply: Reply = { requestId: newId(), question: text, text: '', done: false }
    setReplies((all) => [...all, reply])
    setQuestion('')
    zepper.send({ type: 'assistant.run', requestId: reply.requestId, question: text, history })
  }

  return (
    <div className="assistant">
      <div className="assistant-header">
        <IconSparkle size={15} className="assistant-mark" />
        <div className="assistant-heading">
          <div className="assistant-title">{title || host}</div>
          <div className="assistant-host">{host}</div>
        </div>
      </div>
      <div className="assistant-replies" ref={list}>
        {replies.map((reply) => (
          <div key={reply.requestId} className="assistant-reply">
            {reply.question && <div className="assistant-question">{reply.question}</div>}
            {reply.error ? (
              <div className="assistant-error">{reply.error}</div>
            ) : reply.text ? (
              <div className="assistant-text">{reply.text}</div>
            ) : (
              <div className="assistant-thinking">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="assistant-ask"
        onSubmit={(e) => {
          e.preventDefault()
          ask()
        }}
      >
        <input
          ref={input}
          value={question}
          placeholder="Ask about this page…"
          spellCheck={false}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" disabled={!question.trim() || busy} title="Ask">
          <IconArrowRight size={14} />
        </button>
      </form>
      <div className="assistant-footnote">Apple Intelligence, on this Mac. Answers can be wrong.</div>
    </div>
  )
}
