// Reads .datasource and .pipe files from the tinybird/ directory at runtime.
//
// At dev time (tsx), import.meta.url points to src/tinybird-resources.ts,
// so __dirname is cli/src/ and tinybird/ is at ../../tinybird/.
//
// After build (tsc), import.meta.url points to dist/tinybird-resources.js,
// so __dirname is cli/dist/ and tinybird/ is still at ../../tinybird/.
//
// When published to npm, the tinybird/ folder won't exist — this module
// is only usable from a repo checkout (which is the expected selfhost flow).

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

interface ResourceFile {
  name: string
  content: string
}

export interface TinybirdResources {
  datasources: ResourceFile[]
  pipes: ResourceFile[]
}

function findTinybirdDir(): string {
  // Walk up from current file to find the tinybird/ directory.
  // Handles both src/ (dev) and dist/ (built) locations.
  let dir = __dirname
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'tinybird')
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate
    }
    dir = path.dirname(dir)
  }
  throw new Error(
    'Could not find tinybird/ directory. ' +
      'Make sure you are running from the strada repository checkout.',
  )
}

function readDirFiles(dirPath: string, ext: string): ResourceFile[] {
  if (!fs.existsSync(dirPath)) return []

  return fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({
      name: f.replace(ext, ''),
      content: fs.readFileSync(path.join(dirPath, f), 'utf-8'),
    }))
}

/**
 * Load all Tinybird resource files from the repository's tinybird/ directory.
 * Returns datasource and pipe file contents ready for deployToMain().
 */
export function loadTinybirdResources(): TinybirdResources {
  const tinybirdDir = findTinybirdDir()

  const datasources = readDirFiles(
    path.join(tinybirdDir, 'datasources'),
    '.datasource',
  )
  const pipes = readDirFiles(
    path.join(tinybirdDir, 'materializations'),
    '.pipe',
  )

  if (datasources.length === 0) {
    throw new Error(
      `No .datasource files found in ${path.join(tinybirdDir, 'datasources')}`,
    )
  }

  return { datasources, pipes }
}
