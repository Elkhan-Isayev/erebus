import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalProfile, TerminalSession } from '@shared/types';
import '@xterm/xterm/css/xterm.css';
import { Icon } from './Icons';
import { Button } from './ui';
import { api, bridge } from '@/lib/api';
import { cx } from '@/lib/format';
import { useAppState } from '@/app/AppState';
import { useToast } from '@/lib/toast';

const THEMES = {
  dark: {
    background: '#0a0c12',
    foreground: '#d8dcea',
    cursor: '#7c5cff',
    selectionBackground: 'rgba(124,92,255,0.32)',
    black: '#1b1f2b',
    brightBlack: '#4a5168',
  },
  light: {
    background: '#ffffff',
    foreground: '#20232e',
    cursor: '#6a46f5',
    selectionBackground: 'rgba(124,92,255,0.22)',
    black: '#e3e5ee',
    brightBlack: '#8a8fa3',
  },
} as const;

/** One xterm instance per session, kept alive while the panel is mounted. */
interface View {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  /** The line the user is typing — we do our own editing since there is no pty. */
  input: string;
  history: string[];
  historyIndex: number;
}

export function TerminalPanel({
  sessions,
  activeId,
  onActivate,
  onClose,
  height,
  onHeightChange,
  onHide,
}: {
  sessions: TerminalSession[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  height: number;
  onHeightChange: (height: number) => void;
  onHide: () => void;
}) {
  const toast = useToast();
  const { resolvedTheme, settings } = useAppState();
  const hostRef = useRef<HTMLDivElement>(null);
  const views = useRef(new Map<string, View>());
  const [profilesOpen, setProfilesOpen] = useState(false);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  /* ------------------------------------------------------------ instances */
  const ensureView = useCallback(
    (session: TerminalSession): View => {
      let view = views.current.get(session.id);
      if (view) return view;

      const element = document.createElement('div');
      element.style.width = '100%';
      element.style.height = '100%';
      element.style.display = 'none';
      hostRef.current?.appendChild(element);

      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.35,
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: THEMES[resolvedTheme],
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);

      view = { term, fit, element, input: '', history: [], historyIndex: -1 };
      views.current.set(session.id, view);

      const prompt = () => term.write('\x1b[38;5;141m❯\x1b[0m ');

      term.onData((data) => {
        const current = views.current.get(session.id);
        if (!current) return;

        // Ctrl-C stops whatever is running; otherwise clears the line.
        if (data === '\x03') {
          void api.terminalSignal(session.id, 'SIGINT');
          term.write('^C\r\n');
          current.input = '';
          return;
        }
        if (data === '\r') {
          const command = current.input.trim();
          term.write('\r\n');
          current.input = '';
          if (!command) return prompt();
          current.history = [...current.history.filter((h) => h !== command), command];
          current.historyIndex = -1;
          api.terminalRun(session.id, command).catch((err: Error) => {
            term.write(`\x1b[31m${err.message}\x1b[0m\r\n`);
            prompt();
          });
          return;
        }
        if (data === '\x7f') {
          if (current.input.length > 0) {
            current.input = current.input.slice(0, -1);
            term.write('\b \b');
          }
          return;
        }
        if (data === '\x1b[A' || data === '\x1b[B') {
          const { history } = current;
          if (history.length === 0) return;
          const next =
            data === '\x1b[A'
              ? current.historyIndex < 0
                ? history.length - 1
                : Math.max(0, current.historyIndex - 1)
              : current.historyIndex < 0
                ? -1
                : Math.min(history.length - 1, current.historyIndex + 1);
          current.historyIndex = next;
          const value = next < 0 ? '' : history[next];
          term.write(`\r\x1b[K\x1b[38;5;141m❯\x1b[0m ${value}`);
          current.input = value;
          return;
        }
        if (data >= ' ' || data === '\t') {
          current.input += data;
          term.write(data);
        }
      });

      // Restore scrollback from the main process, then show a prompt if idle.
      void api
        .terminalOutput(session.id)
        .then((buffer) => {
          if (buffer) term.write(buffer);
          if (session.status !== 'running') prompt();
        })
        .catch(() => undefined);

      return view;
    },
    [resolvedTheme],
  );

  /* ---------------------------------------------------------- data stream */
  useEffect(() => {
    const offData = bridge.on('terminal:data', (payload) => {
      const { sessionId, chunk } = payload as { sessionId: string; chunk: string };
      views.current.get(sessionId)?.term.write(chunk);
    });
    const offExit = bridge.on('terminal:exit', (payload) => {
      const { sessionId } = payload as { sessionId: string };
      views.current.get(sessionId)?.term.write('\x1b[38;5;141m❯\x1b[0m ');
    });
    return () => {
      offData();
      offExit();
    };
  }, []);

  /* ------------------------------------------------------- show / measure */
  useEffect(() => {
    for (const session of sessions) ensureView(session);
    for (const [id, view] of views.current) {
      if (!sessions.some((s) => s.id === id)) {
        view.term.dispose();
        view.element.remove();
        views.current.delete(id);
        continue;
      }
      view.element.style.display = id === activeId ? 'block' : 'none';
    }
    const view = activeId ? views.current.get(activeId) : null;
    if (view) {
      requestAnimationFrame(() => {
        try {
          view.fit.fit();
          view.term.focus();
        } catch {
          /* the panel is not laid out yet */
        }
      });
    }
  }, [sessions, activeId, ensureView]);

  useEffect(() => {
    for (const view of views.current.values()) view.term.options.theme = THEMES[resolvedTheme];
  }, [resolvedTheme]);

  useEffect(() => {
    const onResize = () => {
      for (const [id, view] of views.current) {
        if (id !== activeId) continue;
        try {
          view.fit.fit();
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, [activeId, height]);

  useEffect(() => {
    const map = views.current;
    return () => {
      for (const view of map.values()) {
        view.term.dispose();
        view.element.remove();
      }
      map.clear();
    };
  }, []);

  /* ------------------------------------------------------------- resizing */
  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const onMove = (e: MouseEvent) => {
      const next = Math.min(Math.max(startHeight + (startY - e.clientY), 120), window.innerHeight - 200);
      onHeightChange(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const runProfile = async (profile: TerminalProfile) => {
    try {
      const session = await api.terminalCreate(profile.name, profile.cwd, profile.id);
      onActivate(session.id);
      await api.terminalRun(session.id, profile.command);
    } catch (err) {
      toast.error(err);
    }
    setProfilesOpen(false);
  };

  const profiles = useMemo(() => settings.terminals ?? [], [settings.terminals]);

  return (
    <div className="terminal-panel" style={{ height }}>
      <div className="terminal-resizer" onMouseDown={startResize} />
      <div className="terminal-tabs">
        {sessions.map((session) => (
          <button
            key={session.id}
            className={cx('terminal-tab', session.id === activeId && 'active')}
            onClick={() => onActivate(session.id)}
            title={session.command || session.cwd}
          >
            <span className={cx('dot', session.status)} />
            <span className="label">{session.name}</span>
            <span
              className="close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(session.id);
              }}
            >
              <Icon.X width={11} />
            </span>
          </button>
        ))}

        <div style={{ position: 'relative' }}>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            title="New terminal (⌘T)"
            onClick={async () => {
              const session = await api.terminalCreate();
              onActivate(session.id);
            }}
          >
            <Icon.Plus width={14} />
          </Button>
        </div>

        {profiles.length > 0 && (
          <div style={{ position: 'relative' }}>
            <Button size="sm" variant="ghost" onClick={() => setProfilesOpen((v) => !v)} title="Saved commands">
              <Icon.Zap width={13} /> Profiles
            </Button>
            {profilesOpen && (
              <div className="dropdown" style={{ left: 0, right: 'auto', minWidth: 260, top: 'auto', bottom: 'calc(100% + 6px)' }}>
                {profiles.map((profile) => (
                  <button key={profile.id} onClick={() => void runProfile(profile)}>
                    <Icon.Play width={13} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {profile.name}
                    </span>
                    {profile.autoStart && <span className="badge">auto</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {active?.status === 'running' && (
          <Button
            size="sm"
            variant="ghost"
            title="Send SIGINT"
            onClick={() => void api.terminalSignal(active.id, 'SIGINT')}
          >
            <Icon.Stop width={13} /> Stop
          </Button>
        )}
        <Button size="sm" variant="ghost" iconOnly title="Hide terminal (⌘`)" onClick={onHide}>
          <Icon.ChevronDown width={14} />
        </Button>
      </div>

      <div className="terminal-body" ref={hostRef}>
        {sessions.length === 0 && (
          <div className="terminal-empty">
            <span>No terminal open.</span>
            <Button
              size="sm"
              onClick={async () => {
                const session = await api.terminalCreate();
                onActivate(session.id);
              }}
            >
              <Icon.Plus width={13} /> New terminal
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
