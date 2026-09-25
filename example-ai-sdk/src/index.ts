// Example AI SDK agent loop that emits model, stream, and tool-call spans to Strada.
import { openai, type OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { captureException, flush, initStrada, logs, SeverityNumber, shutdown } from '@strada.sh/sdk'
import { registerOpenTelemetry } from '@strada.sh/sdk/otel'

const projectId = process.env.STRADA_PROJECT_ID
if (!projectId) {
  throw new Error('Missing STRADA_PROJECT_ID. Run with `sigillo run -- pnpm start`.')
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error('Missing OPENAI_API_KEY. Add it to Sigillo before running the example.')
}

const endpoint = process.env.STRADA_ENDPOINT || `https://${projectId}-ingest.strada.sh`
const modelId = 'gpt-5-mini'

initStrada({
  projectId,
  endpoint,
  service: 'example-ai-sdk',
  environment: process.env.NODE_ENV || 'development',
  telemetry: {
    traces: {
      scheduledDelayMillis: 250,
      exportTimeoutMillis: 5_000,
    },
  },
})
// AI SDK spans (experimental_telemetry) use the global @opentelemetry/api tracer.
registerOpenTelemetry()

const projectStatus = {
  project: 'strada',
  openIssues: 7,
  failingChecks: ['browser telemetry verification'],
  deployTarget: 'preview',
}

const tools = {
  getProjectStatus: tool({
    description: 'Read the current status for a project.',
    inputSchema: z.object({
      project: z.string().describe('Project name to inspect.'),
    }),
    execute: async ({ project }) => ({
      ...projectStatus,
      project,
    }),
  }),
  estimateFixCost: tool({
    description: 'Estimate the implementation cost for fixing one project issue.',
    inputSchema: z.object({
      issue: z.string().describe('Issue or failing check to estimate.'),
    }),
    execute: async ({ issue }) => ({
      issue,
      effort: issue.includes('browser') ? 'medium' : 'small',
      suggestedOwner: 'observability-agent',
    }),
  }),
  createTodo: tool({
    description: 'Create a follow-up todo in the local planning board.',
    inputSchema: z.object({
      title: z.string().describe('Todo title.'),
      priority: z.enum(['low', 'medium', 'high']).describe('Todo priority.'),
    }),
    execute: async ({ title, priority }) => ({
      id: `todo_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      title,
      priority,
      created: true,
    }),
  }),
}

const logger = logs.getLogger('example-ai-sdk')

try {
  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: 'ai_sdk_agent_started',
    attributes: {
      'event.name': 'ai_sdk_agent_started',
      'custom.model': modelId,
      'custom.example': 'example-ai-sdk',
    },
  })

  const result = await generateText({
    model: openai(modelId),
    system: [
      'You are a concise engineering agent.',
      'Use tools before answering.',
      'Create exactly one todo for the most important next action.',
    ].join('\n'),
    prompt: 'Inspect the Strada project status, estimate the most urgent fix, and summarize the next action.',
    tools,
    maxRetries: 0,
    stopWhen: stepCountIs(5),
    providerOptions: {
      openai: {
        store: false,
        textVerbosity: 'low',
      } satisfies OpenAILanguageModelResponsesOptions,
    },
    experimental_telemetry: {
      isEnabled: true,
      functionId: 'example-ai-sdk-agent-loop',
      metadata: {
        example: 'example-ai-sdk',
        model: modelId,
      },
    },
    onStepFinish({ stepNumber, toolCalls, toolResults, finishReason, usage }) {
      console.log(
        JSON.stringify({
          stepNumber,
          finishReason,
          toolCalls: toolCalls.map((call) => call.toolName),
          toolResults: toolResults.map((result) => result.toolName),
          totalTokens: usage.totalTokens,
        }),
      )
    },
  })

  console.log('\nFinal answer:\n')
  console.log(result.text)

  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: 'ai_sdk_agent_finished',
    attributes: {
      'event.name': 'ai_sdk_agent_finished',
      'custom.model': modelId,
      'custom.steps': String(result.steps.length),
    },
  })
} catch (error) {
  captureException(error, {
    handled: true,
    mechanism: 'generic',
    tags: { example: 'example-ai-sdk' },
  })
  console.error(error)
  process.exitCode = 1
} finally {
  await flush()
  await shutdown()
}
