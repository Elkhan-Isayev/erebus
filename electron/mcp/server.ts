/**
 * MCP server over stdio: newline-delimited JSON-RPC 2.0.
 *
 * Started with `Erebus --mcp`, it gives an agent the same capabilities the UI has,
 * reusing the stored cluster configuration (secrets included, unlocked by the OS keychain).
 * Nothing but protocol messages may touch stdout.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { visibleTools, type McpTool } from './tools';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

const log = (...args: unknown[]) => console.error('[erebus-mcp]', ...args);

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reply = (id: Request['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });

const fail = (id: Request['id'], code: number, message: string) =>
  send({ jsonrpc: '2.0', id, error: { code, message } });

function toolByName(name: string): McpTool | undefined {
  return visibleTools().find((t) => t.name === name);
}

async function handleRequest(request: Request, version: { value: string }): Promise<void> {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      version.value = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      reply(id, {
        protocolVersion: version.value,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'erebus', version: process.env.EREBUS_VERSION ?? '0.1.0' },
        instructions:
          'Erebus exposes the message brokers configured in the desktop app. Call list_clusters first to get a cluster id, then use the topic, message, consumer-group, schema, connector and ksqlDB tools. Clusters marked read-only reject every write.',
      });
      return;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, {
        tools: visibleTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;

    case 'tools/call': {
      const tool = toolByName(params?.name);
      if (!tool) {
        fail(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        const result = await tool.run(params?.arguments ?? {});
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 2) }],
        });
      } catch (err) {
        // Tool failures are results, not protocol errors — the agent should see the message.
        reply(id, {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        });
      }
      return;
    }

    case 'resources/list':
      reply(id, { resources: [] });
      return;

    case 'prompts/list':
      reply(id, { prompts: [] });
      return;

    default:
      if (id === undefined || id === null) return; // notification we do not implement
      fail(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Feeds protocol lines to `onLine`, calling `onClose` when the client really goes away.
 *
 * On Windows an Electron GUI process gets a stdin handle that libuv cannot read as a
 * stream: `readline` reports `close` before a single byte arrives, so the server used to
 * quit the moment a client started it. Reading the descriptor through the thread pool
 * works there, and keeps the event loop free for the Kafka calls the tools make.
 */
function readProtocolInput(onLine: (line: string) => void, onClose: () => void): void {
  if (process.platform !== 'win32') {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', onLine);
    rl.on('close', onClose);
    return;
  }

  const buffer = Buffer.alloc(64 * 1024);
  let pending = '';

  const pump = (): void => {
    fs.read(0, buffer, 0, buffer.length, null, (err, bytes) => {
      if (err) {
        // Nothing written yet: the pipe is simply idle, so try again shortly.
        if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
          setTimeout(pump, 20);
          return;
        }
        onClose();
        return;
      }
      if (bytes === 0) {
        onClose();
        return;
      }

      pending += buffer.subarray(0, bytes).toString('utf8');
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      pump();
    });
  };

  pump();
}

export function startMcpServer(): void {
  const version = { value: PROTOCOL_VERSIONS[0] };

  readProtocolInput(
    (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let request: Request;
      try {
        request = JSON.parse(trimmed);
      } catch {
        fail(null, -32700, 'Parse error');
        return;
      }
      void handleRequest(request, version).catch((err) => {
        log('handler crashed', err);
        if (request.id !== undefined && request.id !== null) fail(request.id, -32603, (err as Error).message);
      });
    },
    () => {
      log('stdin closed, exiting');
      process.exit(0);
    },
  );

  log(`ready — ${visibleTools().length} tools${process.env.EREBUS_MCP_READONLY ? ' (read-only)' : ''}`);
}
