'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import { PROJECTS, type Project } from './mock-data.ts'

export type WorkspaceUser = {
  id: string
  name: string
  email: string
  role: string
  avatarSrc: string
}

export const USERS: WorkspaceUser[] = [
  {
    id: 'sabrina',
    name: 'Sabrina Brown',
    email: 'sabrina@strada.sh',
    role: 'Admin',
    avatarSrc: 'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&w=64&h=64&q=80',
  },
  {
    id: 'marcus',
    name: 'Marcus Lee',
    email: 'marcus@strada.sh',
    role: 'Member',
    avatarSrc: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=64&h=64&q=80',
  },
  {
    id: 'lena',
    name: 'Lena Ortiz',
    email: 'lena@strada.sh',
    role: 'Owner',
    avatarSrc: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=64&h=64&q=80',
  },
]

export function findUser(id?: string) {
  return USERS.find((user) => user.id === id)
}

const WorkspaceContext = createContext<{
  project: Project
  user: WorkspaceUser
  setProjectId: (id: string) => void
  setUserId: (id: string) => void
} | null>(null)

const DEFAULT_PROJECT = PROJECTS[0]!
const DEFAULT_USER = USERS[0]!

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [projectId, setProjectId] = useState(DEFAULT_PROJECT.id)
  const [userId, setUserId] = useState(DEFAULT_USER.id)
  const project = PROJECTS.find((item) => item.id === projectId) ?? DEFAULT_PROJECT
  const user = USERS.find((item) => item.id === userId) ?? DEFAULT_USER

  return <WorkspaceContext.Provider value={{ project, user, setProjectId, setUserId }}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return value
}

const PROJECT_TINTS = ['bg-[#3b6fe0]', 'bg-[#2f9e44]', 'bg-[#d6409f]']

export function ProjectMark({ project }: { project: Project }) {
  const index = PROJECTS.findIndex((item) => item.id === project.id)
  return (
    <span className={`flex size-full items-center justify-center text-[11px] font-semibold text-white uppercase ${PROJECT_TINTS[index % PROJECT_TINTS.length]}`}>
      {project.slug.slice(0, 1)}
    </span>
  )
}
