import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getSession } from './auth'
import { listChatMessages, sendChatMessage, type ChatMessage } from './lib/chat'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import { loadCloudSession } from './lib/workspace'

type Props = {
  enabled?: boolean
}

const SEEN_KEY = 'rifa-pix-chat-seen-v1'

function loadSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) || ''
  } catch {
    return ''
  }
}

function saveSeen(iso: string) {
  try {
    localStorage.setItem(SEEN_KEY, iso)
  } catch {
    /* ignore */
  }
}

export function TeamChat({ enabled = true }: Props) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unread, setUnread] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const seenRef = useRef(loadSeen())
  const openRef = useRef(open)

  const session = getSession()
  const cloud = loadCloudSession()
  const canUse = Boolean(enabled && isSupabaseConfigured && cloud?.workspace.accessCode && session)

  const authorName =
    session?.role === 'admin'
      ? session.memberName || 'ADM'
      : session?.memberName || 'Membro'

  const refresh = async () => {
    if (!canUse) return
    try {
      const rows = await listChatMessages(150)
      setMessages(rows)
      setError(null)
      const last = rows[rows.length - 1]?.created_at || ''
      if (openRef.current) {
        if (last) {
          seenRef.current = last
          saveSeen(last)
        }
        setUnread(0)
      } else if (last && last > seenRef.current) {
        const count = rows.filter((m) => m.created_at > seenRef.current).length
        setUnread(count)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar chat')
    }
  }

  useEffect(() => {
    openRef.current = open
    if (open) {
      const last = messages[messages.length - 1]?.created_at
      if (last) {
        seenRef.current = last
        saveSeen(last)
      }
      setUnread(0)
      window.setTimeout(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
      }, 40)
    }
  }, [open, messages])

  useEffect(() => {
    if (!canUse) return
    void refresh()
    const id = window.setInterval(() => {
      void refresh()
    }, 3500)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUse])

  useEffect(() => {
    if (!canUse || !supabase || !cloud?.workspace.id || cloud.role !== 'admin') return
    const channel = supabase
      .channel(`chat-${cloud.workspace.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `workspace_id=eq.${cloud.workspace.id}`,
        },
        () => {
          void refresh()
        },
      )
      .subscribe()
    return () => {
      if (supabase) void supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUse, cloud?.workspace.id, cloud?.role])

  useEffect(() => {
    if (!open || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, open])

  if (!canUse) return null

  const onSend = async (e: FormEvent) => {
    e.preventDefault()
    const body = text.trim()
    if (!body || busy || !session) return
    setBusy(true)
    setError(null)
    try {
      const msg = await sendChatMessage({
        authorName,
        body,
        authorRole: session.role === 'admin' ? 'admin' : 'member',
        authorMemberId: session.memberId,
      })
      setText('')
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]))
      seenRef.current = msg.created_at
      saveSeen(msg.created_at)
      setUnread(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao enviar')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={`chat-fab ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="team-chat-panel"
      >
        {open ? 'Fechar chat' : 'Chat da equipe'}
        {!open && unread > 0 && <span className="chat-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <section id="team-chat-panel" className="chat-panel" aria-label="Chat da equipe">
          <header className="chat-head">
            <div>
              <strong>Chat da equipe</strong>
              <p className="hint">ADM e membros do mesmo código</p>
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              ✕
            </button>
          </header>

          <div className="chat-list" ref={listRef}>
            {messages.length === 0 && <p className="empty">Nenhuma mensagem ainda. Digite abaixo.</p>}
            {messages.map((m) => {
              const mine =
                (session?.role === 'admin' && m.author_role === 'admin') ||
                (session?.memberId && m.author_member_id === session.memberId)
              return (
                <article key={m.id} className={`chat-bubble ${mine ? 'mine' : 'theirs'}`}>
                  <header>
                    <strong>{m.author_name}</strong>
                    <span>{m.author_role === 'admin' ? 'ADM' : 'Membro'}</span>
                    <time dateTime={m.created_at}>
                      {new Date(m.created_at).toLocaleString('pt-BR', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </header>
                  <p>{m.body}</p>
                </article>
              )
            })}
          </div>

          {error && <p className="auth-error chat-error">{error}</p>}

          <form className="chat-compose" onSubmit={onSend}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Escreva para a equipe…"
              maxLength={2000}
              disabled={busy}
              autoComplete="off"
            />
            <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
              Enviar
            </button>
          </form>
        </section>
      )}
    </>
  )
}
