import { useEffect, useMemo, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { authRedirectTo, isSupabaseConfigured, supabase } from './supabase'
import { formatErr, translateAuthErr } from './errors'

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(isSupabaseConfigured)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const user: User | null = session?.user ?? null
  return useMemo(
    () => ({
      configured: isSupabaseConfigured,
      loading,
      session,
      user,
      async signUp(email: string, password: string, organizerName: string) {
        if (!supabase) throw new Error('Supabase não configurado')
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { organizer_name: organizerName },
            emailRedirectTo: authRedirectTo(),
          },
        })
        if (error) throw new Error(translateAuthErr(formatErr(error)))
      },
      async signIn(email: string, password: string) {
        if (!supabase) throw new Error('Supabase não configurado')
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw new Error(translateAuthErr(formatErr(error)))
      },
      async signOut() {
        if (!supabase) return
        await supabase.auth.signOut()
      },
    }),
    [loading, session, user],
  )
}
