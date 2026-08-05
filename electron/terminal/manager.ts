/**
 * Terminal sessions. Each session runs one command at a time through the user's login
 * shell, so PATH and profile are exactly what a normal terminal would give you —
 * which is what `kubectl port-forward` and friends need.
 *
 * These are pipes, not a pty: fine for CLIs and long-running port-forwards, not for
 * full-screen TUIs like vim or htop.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { TerminalSession } from '../../shared/types';

type Emit = (channel: string, payload: unknown) => void;

interface Session {
  id: string;
  name: string;
  cwd: string;
  command: string;
  status: TerminalSession['status'];
  exitCode: number | null;
  startedAt: number | null;
  createdAt: number;
  profileId?: string;
  child: ChildProcessWithoutNullStreams | null;
  /** Scrollback kept in the main process so tabs survive navigation and MCP can read it. */
  buffer: string;
}

const MAX_BUFFER = 256 * 1024;
const sessions = new Map<string, Session>();
let emit: Emit = () => {};

export function setEmitter(fn: Emit): void {
  emit = fn;
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/bash';
}

function shellArgs(command: string): string[] {
  // A login shell picks up the PATH additions that GUI apps otherwise miss.
  return process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-l', '-c', command];
}

const toPublic = (s: Session): TerminalSession => ({
  id: s.id,
  name: s.name,
  cwd: s.cwd,
  command: s.command,
  status: s.status,
  exitCode: s.exitCode,
  startedAt: s.startedAt,
  createdAt: s.createdAt,
  profileId: s.profileId,
});

function append(session: Session, chunk: string): void {
  session.buffer += chunk;
  if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(-MAX_BUFFER);
  emit('terminal:data', { sessionId: session.id, chunk });
}

export function listSessions(): TerminalSession[] {
  return [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt).map(toPublic);
}

export function createSession(options: { name?: string; cwd?: string; id?: string; profileId?: string } = {}): TerminalSession {
  const id = options.id ?? randomUUID();
  const session: Session = {
    id,
    name: options.name ?? 'Terminal',
    cwd: options.cwd || os.homedir(),
    command: '',
    status: 'idle',
    exitCode: null,
    startedAt: null,
    createdAt: Date.now(),
    profileId: options.profileId,
    child: null,
    buffer: '',
  };
  sessions.set(id, session);
  emit('terminal:sessions', listSessions());
  return toPublic(session);
}

export function run(sessionId: string, command: string): TerminalSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Terminal session ${sessionId} does not exist`);
  if (session.child) throw new Error('A command is already running in this session — stop it first');

  session.command = command;
  session.status = 'running';
  session.exitCode = null;
  session.startedAt = Date.now();

  const child = spawn(defaultShell(), shellArgs(command), {
    cwd: session.cwd,
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
    // Own process group, so Ctrl-C reaches kubectl and not just the shell.
    detached: process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams;

  session.child = child;
  append(session, `\x1b[38;5;141m$ ${command}\x1b[0m\r\n`);

  const forward = (data: Buffer) => append(session, data.toString('utf8').replace(/(?<!\r)\n/g, '\r\n'));
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);

  child.on('error', (err) => {
    append(session, `\x1b[31m${err.message}\x1b[0m\r\n`);
  });

  child.on('close', (code, signal) => {
    session.child = null;
    session.status = 'exited';
    session.exitCode = code ?? null;
    const label = signal ? `signal ${signal}` : `exit code ${code}`;
    append(session, `\x1b[38;5;244m[${label}]\x1b[0m\r\n`);
    emit('terminal:exit', { sessionId: session.id, exitCode: code, signal });
    emit('terminal:sessions', listSessions());
  });

  emit('terminal:sessions', listSessions());
  return toPublic(session);
}

export function write(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  if (!session?.child) throw new Error('Nothing is running in this session');
  session.child.stdin.write(data);
}

/** Windows has no signals and no process groups — taskkill walks the tree instead. */
function killTree(pid: number, force: boolean): void {
  execFile('taskkill', ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], () => {});
}

export function signal(sessionId: string, sig: NodeJS.Signals = 'SIGINT'): void {
  const session = sessions.get(sessionId);
  const pid = session?.child?.pid;
  if (!session?.child || !pid) return;

  if (process.platform === 'win32') {
    killTree(pid, sig === 'SIGKILL');
    return;
  }
  // The shell leads its own process group; signal the group so port-forwards actually stop.
  try {
    process.kill(-pid, sig);
  } catch {
    session.child.kill(sig);
  }
}

export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const pid = session.child?.pid;
  if (session.child && pid) {
    if (process.platform === 'win32') {
      killTree(pid, true);
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        session.child.kill('SIGKILL');
      }
    }
  }
  sessions.delete(sessionId);
  emit('terminal:sessions', listSessions());
}

export function output(sessionId: string, maxChars = 20_000): string {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Terminal session ${sessionId} does not exist`);
  return session.buffer.slice(-maxChars);
}

export function rename(sessionId: string, name: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.name = name;
  emit('terminal:sessions', listSessions());
}

export function killAll(): void {
  for (const id of [...sessions.keys()]) closeSession(id);
}
