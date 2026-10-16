import { createContext, useContext } from 'react'
import type { Company } from './store.ts'
import type { StringKey } from './i18n.ts'

export interface Ctx {
  company: Company
  selected: string | null
  select: (id: string | null) => void
  openProjects: () => void
  /** Org chart: dim everyone not involved in the selected project. */
  focus: boolean
  setFocus: (f: boolean) => void
}

export const CompanyContext = createContext<Ctx | null>(null)

export function useCompanyCtx(): Ctx {
  const c = useContext(CompanyContext)
  if (!c) throw new Error('CompanyContext missing')
  return c
}

export const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export function ago(ts: number, t: (k: StringKey) => string): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return t('justNow')
  if (s < 3600) return `${Math.round(s / 60)} ${t('minAgo')}`
  if (s < 86400) return `${Math.round(s / 3600)} ${t('hAgo')}`
  return `${Math.round(s / 86400)} ${t('dAgo')}`
}
