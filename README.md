![Superargs: Update MCP server args from the chat](https://raw.githubusercontent.com/supercorp-ai/superargs/main/superargs.png)

**Superargs** allows setting up MCP server args during runtime.
Provide arguments to any **MCP server** during interaction with assistant instead of during initial setup.
Whether it’s authentication tokens, environment variables, or other CLI arguments, Superargs makes it easy to provide it during runtime.

Supported by [superinterface.ai](https://superinterface.ai), [supermachine.ai](https://supermachine.ai) and [supercorp.ai](https://supercorp.ai).

## Installation & Usage

Run Superargs via `npx`:

```bash
npx -y superargs --stdio "npx -y @modelcontextprotocol/server-postgres {{databaseUrl}}"
```

- **`--stdio`**: Shell command that runs a stdio MCP server with args to be replaced during runtime in the form `{{argName}}`.
- **`--update-args-tool-name`**: (Optional) Custom name for the tool used to update/restart args. Defaults to `update_args`.

### Args

Args in the `--stdio` command are denoted by `{{argName}}`. For example:

```bash
npx -y superargs --stdio "GITHUB_PERSONAL_ACCESS_TOKEN={{githubToken}} npx -y @modelcontextprotocol/server-github"
```

In this command:
- `{{githubToken}}` is an arg that can be set at runtime using the `update_args` tool (or a custom tool name if specified).

## Once Started

- **Initial state**: At the start, the MCP server will not have any args set.

- If underlying MCP stdio server can start without args, it will try to start without them to provide tools lists and other MCP server functions.
If it can work without args, the only difference will be that it will have an additional **update_args** tool to update args.

- If the server requires args to start, it will not start until the args are set and it will only have the **update_args** tool.
All other MCP server functions will either return an empty list or an error message.

- **When update_args is used**: The server will restart with the new args and all MCP server functions will be available.

- **Tool to Update Args**: By default, named `update_args`, allows updating args and restarting the child MCP server.

## Examples

Another example with GitHub MCP server:

```bash
npx -y superargs --stdio "GITHUB_PERSONAL_ACCESS_TOKEN={{githubToken}} npx -y @modelcontextprotocol/server-github"
```

And with SQLite MCP server:

```bash
npx -y superargs --stdio "uv mcp-server-sqlite --db-path={{dbPath}}"
```

### Example with MCP Inspector

1. **Run MCP Inspector with Superargs**:

    ```bash
    npx @modelcontextprotocol/inspector npx -y superargs --stdio "npx -y @modelcontextprotocol/server-postgres {{databaseUrl}}"
    ```

    This command starts Superargs and connects it to MCP Inspector, enabling you to manage your PostgreSQL MCP server through the inspector interface.

2. **Manage MCP Server**:

    With MCP Inspector, you can list tools, run prompts, access resources, or perform other MCP actions through Superargs.

## How It Works

**Superargs** acts as a middleware wrapper around your MCP server, enabling dynamic injection of args at runtime. It forwards all MCP requests (tools, prompts, resources, messages, roots, etc.) to the underlying child server and introduces an additional tool to manage these args.

### Key Features

- **Dynamic Arg Injection**: Replace placeholders in your MCP server command with actual values during runtime.
- **Customizable Tool Name**: Rename the arg update tool via `--update-args-tool-name` to suit your workflow.
- **Comprehensive MCP Support**: Forwards all MCP requests to the child server, including tools, prompts, resources, messages, and roots.
- **Change Notifications**: Sends notifications like `sendToolListChanged`, `sendPromptListChanged`, and `sendResourceUpdated` when args are updated, ensuring connected clients are aware of changes.

### Main Use Case

**Superargs** empowers users to set up and configure MCP servers dynamically during their interactions with AI assistants.
Instead of requiring administrators to pre-configure servers with necessary args and credentials, users can provide these details on-the-fly through conversation, enhancing flexibility and reducing setup overhead.

### Providing sensitive args securely

Args are passed to the child MCP server in the command specified. Nothing is stored.

If you don’t want the LLM to ever see these args, do a direct call to the MCP server through server client (so it’s not the assistant who is calling it, but your code directly).

## Why MCP?

[Model Context Protocol](https://modelcontextprotocol.io/) standardizes how AI tools exchange data. If your MCP server requires dynamic args such as authentication tokens or configuration paths, **Superargs** allows you to provide them at runtime without altering the server's code. This enables flexible deployments, remote access, and easier debugging.

## Contributing

Contributions are welcome! Whether you have ideas for new features, improvements, or encounter any issues, please open an [issue](https://github.com/supercorp-ai/superargs/issues) or submit a [pull request](https://github.com/supercorp-ai/superarg/pulls).

## License

[MIT License](./LICENSE)

---

**Superargs** is supported by [Superinterface](https://superinterface.ai), [Supermachine](https://supermachine.ai) and [Supercorp](https://supercorp.ai).
