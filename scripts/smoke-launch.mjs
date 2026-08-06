#!/usr/bin/env node
/**
 * Launches a packaged Erebus binary and speaks MCP to it.
 *
 * A packaged app that cannot start is the one bug users hit before any feature matters,
 * and it is invisible to unit tests — so every release build runs this against the very
 * artifact it just produced.
 *
 *   node scripts/smoke-launch.mjs "/Applications/Erebus.app/Contents/MacOS/Erebus"
 *   node scripts/smoke-launch.mjs /opt/Erebus/erebus --xvfb
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const [binary, ...flags] = process.argv.slice(2);
if (!binary) {
  console.error('usage: smoke-launch.mjs <path to binary> [--xvfb]');
  process.exit(2);
}

const useXvfb = flags.includes('--xvfb');
const command = useXvfb ? 'xvfb-run' : binary;
const args = useXvfb ? ['-a', binary, '--mcp', '--no-sandbox'] : ['--mcp'];

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
const stderr = [];
child.stderr.on('data', (d) => stderr.push(String(d)));

let settled = false;
const finish = (code, message) => {
  if (settled) return;
  settled = true;
  console.log(message);
  if (code !== 0 && stderr.length) console.error(stderr.join('').trim().split('\n').slice(0, 12).join('\n'));
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  process.exit(code);
};

setTimeout(() => finish(1, `FAIL  ${binary} did not answer within 60s`), 60_000);
child.on('error', (err) => finish(1, `FAIL  could not start ${binary}: ${err.message}`));
child.on('exit', (code, signal) => {
  if (!settled) finish(1, `FAIL  ${binary} exited early (code ${code}, signal ${signal})`);
});

readline.createInterface({ input: child.stdout, terminal: false }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // not protocol output
  }
  if (message.id === 1) {
    const info = message.result?.serverInfo;
    if (!info?.name) return finish(1, 'FAIL  initialize returned no serverInfo');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    console.log(`  launched ${info.name} ${info.version}`);
  }
  if (message.id === 2) {
    const tools = message.result?.tools?.length ?? 0;
    if (tools < 20) return finish(1, `FAIL  only ${tools} tools exposed`);
    finish(0, `PASS  ${binary} starts and serves ${tools} tools`);
  }
});

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
  })}\n`,
);
