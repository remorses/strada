// Full-bleed hero with Holocron 10s video, darkened via ffmpeg.
// Invert + hue-rotate + blend in light. Poster shows while the mp4 loads.
'use client'

import { useState } from 'react'
import { Button } from './ui/button.tsx'
import { authClient } from '../auth-client.ts'
import { GoogleIcon } from './login-button.tsx'

const TOP_GRADIENT = [
  'linear-gradient(to bottom,',
  'var(--background) 0%,',
  'color-mix(in srgb, var(--background) 92%, transparent) 8%,',
  'color-mix(in srgb, var(--background) 78%, transparent) 16%,',
  'color-mix(in srgb, var(--background) 60%, transparent) 26%,',
  'color-mix(in srgb, var(--background) 40%, transparent) 38%,',
  'color-mix(in srgb, var(--background) 20%, transparent) 52%,',
  'color-mix(in srgb, var(--background) 8%, transparent) 68%,',
  'transparent 85%)',
].join(' ')

const BOTTOM_GRADIENT = [
  'linear-gradient(to top,',
  'var(--background) 0%,',
  'color-mix(in srgb, var(--background) 90%, transparent) 10%,',
  'color-mix(in srgb, var(--background) 70%, transparent) 20%,',
  'color-mix(in srgb, var(--background) 45%, transparent) 35%,',
  'color-mix(in srgb, var(--background) 20%, transparent) 50%,',
  'color-mix(in srgb, var(--background) 8%, transparent) 65%,',
  'transparent 80%)',
].join(' ')

function GitHubIcon(props: React.ComponentProps<'svg'>) {
  return (
    <svg viewBox='0 0 24 24' fill='currentColor' aria-hidden='true' {...props}>
      <path d='M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z' />
    </svg>
  )
}

export function HeroSection() {
  const [loading, setLoading] = useState(false)

  async function handleSignUp() {
    setLoading(true)
    try {
      await authClient.signIn.social({
        provider: 'google',
        callbackURL: '/wip',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='relative mt-4 lg:mt-8 mb-6 lg:mb-10 w-screen ml-[calc(-50vw+50%)] flex flex-col items-center overflow-hidden bg-background'>
      <video
        autoPlay
        muted
        loop
        playsInline
        poster='/hero-bg-poster.jpg'
        className='absolute z-0 invert hue-rotate-290 mix-blend-multiply dark:invert-0 dark:hue-rotate-0 dark:mix-blend-screen w-full max-w-(--grid-max-width) left-1/2 -translate-x-1/2 top-0'
      >
        <source src='/hero-bg.mp4' type='video/mp4' />
      </video>

      <div
        className='absolute top-0 inset-x-0 h-[70%] z-1 pointer-events-none'
        style={{ background: TOP_GRADIENT }}
      />

      <div
        className='absolute bottom-0 inset-x-0 h-[40%] z-1 pointer-events-none'
        style={{ background: BOTTOM_GRADIENT }}
      />

      <div className='relative z-2 flex flex-col items-center justify-center text-center max-w-[820px] mx-auto w-full px-5 pb-20 lg:pb-[180px] gap-8 text-balance'>
        <h1 className='flex flex-col items-center font-heading text-[40px] sm:text-[56px] lg:text-[76px] font-semibold leading-[0.9] tracking-[-0.02em] text-foreground'>
          <span>delightful open-source</span>
          <span>observability you own</span>
        </h1>

        <div className='flex gap-3 flex-wrap justify-center'>
          <Button size='lg' className='gap-2.5' loading={loading} onClick={handleSignUp}>
            <GoogleIcon data-icon='inline-start' />
            Sign up with Google
          </Button>
          <Button
            variant='ghost'
            size='lg'
            className='no-underline gap-2'
            render={
              <a
                href='https://github.com/remorses/strada'
                target='_blank'
                rel='noopener noreferrer'
              />
            }
          >
            <GitHubIcon data-icon='inline-start' />
            GitHub
          </Button>
        </div>
      </div>
    </div>
  )
}
