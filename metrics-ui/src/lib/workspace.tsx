'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'

export type WorkspaceStore = {
  id: string
  name: string
  plan: string
  mark: string
}

export type WorkspaceUser = {
  id: string
  name: string
  email: string
  role: string
  avatarSrc: string
}

export const STORES: WorkspaceStore[] = [
  { id: 'adidas', name: 'Adidas', plan: 'Free', mark: 'adidas' },
  { id: 'nike', name: 'Nike', plan: 'Growth', mark: 'nike' },
  { id: 'puma', name: 'Puma', plan: 'Pro', mark: 'puma' },
]

export const USERS: WorkspaceUser[] = [
  {
    id: 'sabrina',
    name: 'Sabrina Brown',
    email: 'sabrina@adidas.com',
    role: 'Admin',
    avatarSrc: 'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&w=64&h=64&q=80',
  },
  {
    id: 'marcus',
    name: 'Marcus Lee',
    email: 'marcus@adidas.com',
    role: 'Agent',
    avatarSrc: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=64&h=64&q=80',
  },
  {
    id: 'lena',
    name: 'Lena Ortiz',
    email: 'lena@adidas.com',
    role: 'Owner',
    avatarSrc: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=64&h=64&q=80',
  },
]

const WorkspaceContext = createContext<{
  store: WorkspaceStore
  user: WorkspaceUser
  setStoreId: (id: string) => void
  setUserId: (id: string) => void
} | null>(null)

const DEFAULT_STORE = STORES[0]!
const DEFAULT_USER = USERS[0]!

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [storeId, setStoreId] = useState(DEFAULT_STORE.id)
  const [userId, setUserId] = useState(DEFAULT_USER.id)
  const store = STORES.find((item) => item.id === storeId) ?? DEFAULT_STORE
  const user = USERS.find((item) => item.id === userId) ?? DEFAULT_USER

  return <WorkspaceContext.Provider value={{ store, user, setStoreId, setUserId }}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return value
}

export function StoreMark({ id }: { id: string }) {
  if (id === 'nike') {
    return (
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
        <path fill="currentColor" d="M3 16.2 20.5 8.4c.7-.3 1.3.5.8 1.1L9.2 17.6c-.4.3-.9.2-1.2-.2L3 16.2Z" />
      </svg>
    )
  }
  if (id === 'puma') {
    return (
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
        <path fill="currentColor" d="M4 16.5c3.2-1.4 6.8-4.2 8.6-7.2.6-1 2.2-1.2 2.6.1.5 1.6-.2 3.4-1.6 4.6 2.2.2 4.2-.6 5.4-2 .4-.5 1.2-.2 1.2.4 0 2.6-2.4 5.1-6.4 5.6-2.8.4-6.2-.4-9.8-1.5Z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path fill="currentColor" d="M2 17.2 9.2 14l2.2 1.5L4.6 19.5 2 17.2Zm6.2-4.4 6.4-2.8 2 1.4-7.2 3.2-1.2-1.8Zm4.4-5.2L22 4.2l.2 2.2-8.2 3.6-1.4-2.4Z" />
    </svg>
  )
}
