#!/usr/bin/env node

import { z } from 'zod'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import {
  Server,
} from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// MCP types for requests we might forward:
import {
  // For bridging "initialize"
  InitializeRequestSchema,
  InitializeRequest,
  InitializeResult,

  // Typical requests
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  PingRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,

  // For "tool" type
  Tool,
} from '@modelcontextprotocol/sdk/types.js'

// We'll define a union of possible child methods as strings
type ChildMethod =
  | 'initialize'
  | 'tools/list'
  | 'tools/call'
  | 'ping'
  | 'completion/complete'
  | 'logging/setLevel'
  | 'resources/subscribe'
  | 'resources/unsubscribe'
  | 'prompts/list'
  | 'prompts/get'
  | 'resources/list'
  | 'resources/read'
  | 'resources/templates/list'
  | 'sampling/createMessage'
  | 'roots/list'

// If you want to forward `notifications/initialized` to the child as well,
// we do NOT have a typed schema in this example, so we’ll just do a string:
type NotificationMethod = 'notifications/initialized'

// For string interpolation like `{{TOKEN}}`
const ARGS_REGEX = /{{(.*?)}}/g

function findArgs(command: string): string[] {
  const matches = new Set<string>()
  let match
  while ((match = ARGS_REGEX.exec(command)) !== null) {
    matches.add(match[1].trim())
  }
  return [...matches]
}

function replaceArgs(command: string, values: Record<string, string>) {
  return command.replace(ARGS_REGEX, (_, name) => {
    const key = name.trim()
    return key in values ? values[key] : `{{${key}}}`
  })
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('stdio', {
      type: 'string',
      demandOption: true,
      description:
        'Shell command that runs an MCP server over stdio, e.g. "ENV=foo npx -y server-github {{myToken}}"',
    })
    .option('update-args-tool-name', {
      type: 'string',
      default: 'update_args',
      description:
        'Name of the tool used to update args and restart stdio (default: "update_args")',
    })
    .help()
    .parseSync()

  const originalCommand = argv.stdio.trim()
  const updateArgsToolName = argv.updateArgsToolName.trim()

  console.error('[superargs] Starting...')
  console.error('[superargs] Superargs is supported by Superinterface - https://superinterface.ai')
  console.error(`[superargs]  - stdio: ${argv.stdio}`)
  console.error(`[superargs]  - updateArgsToolName: ${argv.updateArgsToolName}`)

  const argNames = findArgs(originalCommand)
  console.error(`[superargs] Found args: ${JSON.stringify(argNames)}`)

  // The parent server (the one we expose to the "outer" client)
  const parentServer = new Server(
    { name: 'superargs', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        sampling: {},
        roots: {},
        logging: {},
      },
    }
  )

  // Child state
  let child: ChildProcessWithoutNullStreams | null = null
  let childRequestIdCounter = 0
  const pendingChildCalls = new Map<number, { resolve: (v: any) => void; reject: (err: any) => void }>()
  let currentValues: Record<string, string> = {}

  // We spawn only if needed (the first time a request arrives or after user updates args)
  function spawnChild() {
    killChild()

    const finalCmd = replaceArgs(originalCommand, currentValues)
    console.error(`[superargs] Spawning child process:\n  ${finalCmd}`)

    child = spawn(finalCmd, { shell: true })
    child.on('exit', (code, signal) => {
      console.error(`[superargs] Child process exited with code=${code}, signal=${signal}`)
      child = null

      // Reject any pending calls
      for (const { reject } of pendingChildCalls.values()) {
        reject(new Error(`Child process exited (code=${code}, signal=${signal})`))
      }
      pendingChildCalls.clear()
    })

    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          console.error('[superargs] Child produced non-JSON line:', line)
          continue
        }

        handleChildMessage(msg)
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      console.error('[superargs] [child stderr]', chunk.toString('utf8'))
    })
  }

  function killChild() {
    if (!child) return
    console.error('[superargs] Killing existing child...')
    child.kill('SIGTERM')
    child = null

    for (const { reject } of pendingChildCalls.values()) {
      reject(new Error('Child killed'))
    }
    pendingChildCalls.clear()
  }

  function handleChildMessage(msg: any) {
    if (!msg || msg.jsonrpc !== '2.0') {
      console.error('[superargs] Invalid JSON-RPC from child:', msg)
      return
    }
    if (typeof msg.id === 'number' && pendingChildCalls.has(msg.id)) {
      // It's a response to one of our calls
      const { resolve, reject } = pendingChildCalls.get(msg.id)!
      pendingChildCalls.delete(msg.id)
      if ('error' in msg) reject(msg.error)
      else resolve(msg.result)
      return
    }
    // Otherwise, it's probably a notification from the child
    // We can ignore or log
    console.error('[superargs] Child unhandled message:', msg)
  }

  // A simple call child
  async function callChild(method: ChildMethod, params: any): Promise<any> {
    if (!child) {
      spawnChild()
    }
    if (!child) {
      throw new Error('Could not spawn child?')
    }
    const id = ++childRequestIdCounter
    const req = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      pendingChildCalls.set(id, { resolve, reject })
      child!.stdin.write(JSON.stringify(req) + '\n')
    })
  }

  // For notifications (like "notifications/initialized"), we just forward them (no response)
  function notifyChild(method: NotificationMethod, params: any) {
    if (!child) {
      spawnChild()
    }
    if (child) {
      const msg = { jsonrpc: '2.0', method, params }
      child.stdin.write(JSON.stringify(msg) + '\n')
    }
  }

  // Now we set up a queue so we handle outer requests one at a time in the correct order
  type QueueItem =
    | {
        type: 'request'
        method: ChildMethod
        params: any
        resolve: (v: any) => void
        reject: (err: any) => void
      }
    | {
        type: 'notification'
        method: NotificationMethod
        params: any
      }

  const requestQueue: QueueItem[] = []
  let processing = false

  async function processQueue() {
    if (processing) return
    processing = true

    while (requestQueue.length > 0) {
      const item = requestQueue.shift()!
      try {
        if (item.type === 'request') {
          const result = await callChild(item.method, item.params)
          item.resolve(result)
        } else {
          // notification
          notifyChild(item.method, item.params)
        }
      } catch (err) {
        if (item.type === 'request') {
          item.reject(err)
        } else {
          console.error('[superargs] Error forwarding notification =>', err)
        }
      }
    }

    processing = false
  }

  function enqueueRequest<T = any>(method: ChildMethod, params: any): Promise<T> {
    return new Promise((resolve, reject) => {
      requestQueue.push({ type: 'request', method, params, resolve, reject })
      processQueue()
    })
  }

  function enqueueNotification(method: NotificationMethod, params: any) {
    requestQueue.push({ type: 'notification', method, params })
    processQueue()
  }

  // The "update_args" tool
  const updateArgsTool: Tool = {
    name: updateArgsToolName,
    description: 'Updates placeholders (tokens, etc.) then restarts the child.',
    inputSchema: {
      type: 'object',
      properties: argNames.reduce((acc, name) => {
        acc[name] = { type: 'string', description: `Value for arg "{{${name}}}"` }
        return acc
      }, {} as Record<string, any>),
    },
  }

  // ------------- REQUEST HANDLERS -------------
  // (1) "initialize" -> we do it in the queue
  parentServer.setRequestHandler(InitializeRequestSchema, async (request) => {
    const childResp = await enqueueRequest('initialize', request.params)
    // Merge child’s response with our serverInfo
    return {
      ...childResp,
      serverInfo: { name: 'superargs', version: '1.0.0' },
    } as InitializeResult
  })

  const NotificationsInitializedSchema = z.object({
  method: z.literal('notifications/initialized'),
  // If your notification has parameters, define them here, e.g. z.object({...})
  // or if you don't know, you can allow unknown or any:
  params: z.unknown().optional(),
})

  // (2) "notifications/initialized" -> forward to child as well
  // There's no typed schema for this built-in, so we do string-based:
  // parentServer.setNotificationHandler('notifications/initialized', async (params) => {
  parentServer.setNotificationHandler(NotificationsInitializedSchema, async (request) => {
    enqueueNotification('notifications/initialized', request.params)
  })

  // (3) "tools/list"
  parentServer.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const resp = await enqueueRequest('tools/list', {})
      const childTools = resp.tools ?? []
      // Add "update_args"
      return { tools: [...childTools, updateArgsTool] }
    } catch (err) {
      console.error('[superargs] Could not list child tools. Fallback:', err)
      return { tools: [updateArgsTool] }
    }
  })

  // (4) "tools/call"
  parentServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params
    if (name === updateArgsToolName) {
      // update placeholders & re-spawn
      if (toolArgs && typeof toolArgs === 'object') {
        for (const [k, v] of Object.entries(toolArgs)) {
          if (typeof v === 'string') currentValues[k] = v
        }
      }
      spawnChild()
      // Possibly broadcast updates
      parentServer.sendToolListChanged()
      parentServer.sendResourceListChanged()
      parentServer.sendPromptListChanged()
      return {
        content: [{ type: 'text', text: 'Updated args and restarted child.' }],
        isError: false,
      }
    }
    // Otherwise forward
    return enqueueRequest('tools/call', { name, arguments: toolArgs })
  })

  // (5) Forward everything else similarly
  ;[
    { method: 'ping', schema: PingRequestSchema },
    { method: 'completion/complete', schema: CompleteRequestSchema },
    { method: 'logging/setLevel', schema: SetLevelRequestSchema },
    { method: 'resources/subscribe', schema: SubscribeRequestSchema },
    { method: 'resources/unsubscribe', schema: UnsubscribeRequestSchema },
    { method: 'prompts/list', schema: ListPromptsRequestSchema },
    { method: 'prompts/get', schema: GetPromptRequestSchema },
    { method: 'resources/list', schema: ListResourcesRequestSchema },
    { method: 'resources/read', schema: ReadResourceRequestSchema },
    { method: 'resources/templates/list', schema: ListResourceTemplatesRequestSchema },
    { method: 'sampling/createMessage', schema: CreateMessageRequestSchema },
    { method: 'roots/list', schema: ListRootsRequestSchema },
  ].forEach(({ method, schema }) => {
    parentServer.setRequestHandler(schema, async (request) => {
      return enqueueRequest(method as ChildMethod, request.params)
    })
  })

  // Finally, connect parent server => stdio
  const transport = new StdioServerTransport()
  await parentServer.connect(transport)
  console.error('[superargs] Ready. Waiting on stdio for requests.')
}

main().catch((err) => {
  console.error('[superargs] Fatal error:', err)
  process.exit(1)
})
