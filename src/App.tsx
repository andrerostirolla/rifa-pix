import { useState } from 'react'
import CloudApp from './CloudApp'
import { isSupabaseConfigured } from './lib/supabase'
import { useAuth } from './lib/useAuth'
import LocalApp from './LocalApp'
import { LoginScreen } from './LoginScreen'
import { isAuthenticated } from './auth'

export default function App() {
  const auth = useAuth()
  const [localAuthed, setLocalAuthed] = useState(() => isAuthenticated())

  if (isSupabaseConfigured) {
    if (auth.loading) {
      return (
        <div className="auth-shell">
          <div className="auth-card panel">
            <p className="brand">RifaPIX</p>
            <p className="hint">Carregando…</p>
          </div>
        </div>
      )
    }
    if (!auth.user) return <LoginScreen onLocalAuthenticated={() => undefined} />
    return <CloudApp />
  }

  if (!localAuthed) return <LoginScreen onLocalAuthenticated={() => setLocalAuthed(true)} />
  return <LocalApp />
}
