#!/usr/bin/env node

import { goke } from 'goke'
import dedent from 'string-dedent'
import { createRequire } from 'node:module'
import { selfhostAction } from './selfhost.ts'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

const cli = goke('strada')

cli
  .command(
    'selfhost',
    dedent`
      Set up Strada on your own Tinybird workspace.

      Authenticates with Tinybird via browser OAuth, then deploys all OTel
      datasources and materialized views to your workspace. Outputs the
      environment variables needed to configure the otel-collector.

      For non-interactive usage (CI), pass --token and --base-url directly.
    `,
  )
  .option('-t, --token [token]', 'Tinybird workspace admin token (skips browser login)')
  .option('-u, --base-url [url]', 'Tinybird API base URL (e.g. https://api.us-east.aws.tinybird.co)')
  .example('# Interactive setup (opens browser)')
  .example('strada selfhost')
  .example('# Non-interactive with existing token')
  .example('strada selfhost --token p.eyXXX --base-url https://api.tinybird.co')
  .action(selfhostAction)

cli.help()
cli.version(packageJson.version)
cli.parse()
