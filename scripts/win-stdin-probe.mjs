/* Temporary: does the packaged Windows app read stdin, and does the pipe type matter? */
import { spawn } from 'node:child_process';

const exe = process.argv[2];

function probe(label, stdio) {
  return new Promise((resolve) => {
    const child = spawn(exe, ['--mcp'], { stdio });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    const done = (verdict) => {
      try { child.kill(); } catch { /* gone */ }
      const tail = err.trim().split('\n').slice(-2).join(' / ').slice(0, 140);
      resolve(`[${label}] ${verdict} | answered=${out.includes('serverInfo')} | stderr=${tail}`);
    };
    child.on('exit', (code) => setTimeout(() => done(`exited code=${code}`), 400));
    setTimeout(() => done('still running'), 12000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\n');
  });
}

console.log(await probe('pipe', ['pipe', 'pipe', 'pipe']));
console.log(await probe('overlapped', ['overlapped', 'pipe', 'pipe']));
