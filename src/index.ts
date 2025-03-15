#!/usr/bin/env node

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import {
  ListToolsRequestSchema,
  ListToolsRequest,
  ListToolsResult,
  CallToolRequestSchema,
  CallToolRequest,
  CallToolResult,
  ListPromptsRequestSchema,
  ListPromptsRequest,
  GetPromptRequestSchema,
  GetPromptRequest,
  ListResourcesRequestSchema,
  ListResourcesRequest,
  ReadResourceRequestSchema,
  ReadResourceRequest,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesRequest,
  CreateMessageRequestSchema,
  CreateMessageRequest,
  ListRootsRequestSchema,
  ListRootsRequest,
  PingRequestSchema,
  PingRequest,
  CompleteRequestSchema,
  CompleteRequest,
  SetLevelRequestSchema,
  SetLevelRequest,
  SubscribeRequestSchema,
  SubscribeRequest,
  UnsubscribeRequestSchema,
  UnsubscribeRequest,
  Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

type Method = ListToolsRequest['method'] |
  CallToolRequest['method'] |
  ListPromptsRequest['method'] |
  GetPromptRequest['method'] |
  ListResourcesRequest['method'] |
  ReadResourceRequest['method'] |
  CreateMessageRequest['method'] |
  ListRootsRequest['method'] |
  ListResourceTemplatesRequest['method'] |
  PingRequest['method'] |
  CompleteRequest['method'] |
  SetLevelRequest['method'] |
  SubscribeRequest['method'] |
  UnsubscribeRequest['method']

type ForwardedRequest = {
  method: Method
  schema: any
  fallbackRequesHandler?: (request: any) => any
}

const ARGS_REGEX = /{{(.*?)}}/g

const findArgs = (command: string): string[] => {
  const matches = new Set<string>()
  let match
  while ((match = ARGS_REGEX.exec(command)) !== null) {
    matches.add(match[1].trim())
  }
  return Array.from(matches)
}

const replaceArgs = (command: string, values: Record<string, string>): string => {
  return command.replace(ARGS_REGEX, (_, name: string) => {
    const key = name.trim()
    return key in values ? values[key] : `{{${key}}}`
  })
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('stdio', {
      type: 'string',
      demandOption: true,
      description: 'Shell command that runs an MCP server over stdio, e.g. "ENV=foo npx -y server-github {{myToken}}"'
    })
    .option('update-args-tool-name', {
      type: 'string',
      default: 'update_args',
      description: 'Name of the tool used to update args and restart stdio (default: "update_args")'
    })
    .help()
    .parseSync()

  console.error('[superargs] Starting...')
  console.error('[superargs] Superargs is supported by Superinterface - https://superinterface.ai')
  console.error(`[superargs]  - stdio: ${argv.stdio}`)
  console.error(`[superargs]  - updateArgsToolName: ${argv.updateArgsToolName}`)

  const originalCommand = argv.stdio.trim()
  const updateArgsToolName = argv.updateArgsToolName.trim()

  const args = findArgs(originalCommand)
  console.error(`[superargs] Found args: ${JSON.stringify(args)}`)

  const parentServer = new Server(
    {
      name: 'superargs',
      version: '1.0.0',
    },
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

  let child: ChildProcessWithoutNullStreams | null = null
  let requestIdCounter = 0
  const pendingRequests = new Map<number, {resolve: (val:any)=>void, reject: (err:Error)=>void}>()

  let currentValues: Record<string, string> = {}
  let argsUpdated = false

  const spawnChild = () => {
    killChild()

    const finalCmd = replaceArgs(originalCommand, currentValues)
    console.error(`[superargs] Spawning child process:\n  ${finalCmd}`)

    child = spawn(finalCmd, { shell: true })

    const req = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }

    child.stdin.write(JSON.stringify(req) + '\n')

    child.on('exit', (code, signal) => {
      console.error(`[superargs] Child process exited with code=${code}, signal=${signal}`)
      child = null

      for (const { reject } of pendingRequests.values()) {
        reject(new Error('Child process exited'))
      }
      pendingRequests.clear()
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
        } catch (err) {
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

  const killChild = () => {
    if (!child) return

    console.error('[superargs] Killing existing child...')
    child.kill('SIGTERM')
    child = null

    for (const { reject } of pendingRequests.values()) {
      reject(new Error('Child killed'))
    }
    pendingRequests.clear()
  }

  const handleChildMessage = (msg: any) => {
    if (!msg || msg.jsonrpc !== '2.0') {
      console.error('[superargs] Invalid JSON-RPC from child:', msg)
      return
    }
    const id = msg.id
    if (!id || !pendingRequests.has(id)) {
      console.error('[superargs] Child responded with unknown id=', id)
      return
    }
    const { resolve, reject } = pendingRequests.get(id)!
    pendingRequests.delete(id)

    if ('error' in msg) {
      reject(msg.error)
    } else {
      resolve(msg.result)
    }
  }

  const ensureChildRunning = () => {
    if (!child) {
      spawnChild()
    }
  }

  const callChild = (method: Method, params: any): Promise<any> => {
    if (!child) {
      throw new Error('Child is not running.')
    }
    const id = ++requestIdCounter
    const req = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject })
      child!.stdin.write(JSON.stringify(req) + '\n')
    })
  }

  const broadcastChildUpdates = async () => {
    argsUpdated = true
    parentServer.sendToolListChanged()
    parentServer.sendResourceListChanged()
    parentServer.sendPromptListChanged()
  }

  const updateArgsTool: Tool = {
    name: updateArgsToolName,
    description: 'Updates args (tokens, etc.).',
    inputSchema: {
      type: 'object',
      properties: args.reduce((acc, v) => {
        acc[v] = {
          type: 'string',
          description: `Value for arg "{{${v}}}"`,
        }
        return acc
      }, {} as Record<string, any>),
      required: [],
    }
  }

  parentServer.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      ensureChildRunning()
      const resp = await callChild('tools/list', {})
      const childTools = resp.tools ?? []
      return {
        tools: [...childTools, updateArgsTool],
      } as ListToolsResult
    } catch (err) {
      console.error('[superargs] Could not list child tools, fallback to [updateArgsTool]:', err)
      return {
        tools: [updateArgsTool],
      } as ListToolsResult
    }
  })

  parentServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    if (name === updateArgsToolName) {
      if (args && typeof args === 'object') {
        for (const [k, v] of Object.entries(args)) {
          if (typeof v === 'string') {
            currentValues[k] = v
          }
        }
      }
      spawnChild()
      await broadcastChildUpdates()

      return {
        content: [
          {
            type: 'text',
            text: 'Updated successfully.',
          },
        ],
        isError: false,
      } as CallToolResult
    }

    ensureChildRunning()
    return callChild('tools/call', {
      name,
      arguments: args,
    })
  })

  const forwardedRequests: ForwardedRequest[] = [
    {
      method: 'ping',
      schema: PingRequestSchema,
      fallbackRequesHandler: () => ({}),
    },
    {
      method: 'completion/complete',
      schema: CompleteRequestSchema,
    },
    {
      method: 'logging/setLevel',
      schema: SetLevelRequestSchema,
    },
    {
      method: 'resources/subscribe',
      schema: SubscribeRequestSchema,
    },
    {
      method: 'resources/unsubscribe',
      schema: UnsubscribeRequestSchema,
    },
    {
      method: 'prompts/list',
      schema: ListPromptsRequestSchema,
      fallbackRequesHandler: () => ({ prompts: [] }),
    },
    {
      method: 'prompts/get',
      schema: GetPromptRequestSchema,
    },
    {
      method: 'resources/list',
      schema: ListResourcesRequestSchema,
      fallbackRequesHandler: () => ({ resources: [] }),
    },
    {
      method: 'resources/read',
      schema: ReadResourceRequestSchema,
    },
    {
      method: 'resources/templates/list',
      schema: ListResourceTemplatesRequestSchema,
      fallbackRequesHandler: () => ({ resourceTemplates: [] }),
    },
    {
      method: 'sampling/createMessage',
      schema: CreateMessageRequestSchema,
    },
    {
      method: 'roots/list',
      schema: ListRootsRequestSchema,
      fallbackRequesHandler: () => ({ roots: [] }),
    },
  ]

  for (const { method, schema, fallbackRequesHandler } of forwardedRequests) {
    parentServer.setRequestHandler(schema, async (request) => {
      ensureChildRunning()

      let result

      try {
        result = await callChild(method, request.params)
      } catch (err) {
        console.error(`[superargs] Could not forward request [${method}]:`, err)

        if (!argsUpdated && fallbackRequesHandler) {
          return fallbackRequesHandler(request)
        } else {
          throw err
        }
      }

      return result
    })
  }

  const parentTransport = new StdioServerTransport()
  await parentServer.connect(parentTransport)

  console.error('[superargs] Ready. Waiting on stdio for requests.')
}

main().catch((err) => {
  console.error('[superargs] Fatal error:', err)
  process.exit(1)
})
