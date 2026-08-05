import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppSettings, ClusterConfig, ThemeMode } from '@shared/types';
import { api, type AppInfo } from '@/lib/api';

interface AppStateValue {
  clusters: ClusterConfig[];
  reloadClusters: () => Promise<ClusterConfig[]>;
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: ThemeMode) => void;
  cycleTheme: () => void;
  info: AppInfo | null;
  ready: boolean;
}

const AppStateContext = createContext<AppStateValue | null>(null);

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  defaultMessageLimit: 100,
  showInternalTopics: false,
  liveTailBuffer: 500,
  terminals: [],
};

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [clusters, setClusters] = useState<ClusterConfig[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  const reloadClusters = useCallback(async () => {
    const list = await api.listClusters();
    setClusters(list);
    return list;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [list, loaded, appInfo] = await Promise.all([api.listClusters(), api.getSettings(), api.info()]);
        setClusters(list);
        setSettings(loaded);
        setInfo(appInfo);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme]);

  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    const saved = await api.updateSettings(patch);
    setSettings(saved);
  }, []);

  const setTheme = useCallback((theme: ThemeMode) => void saveSettings({ theme }), [saveSettings]);

  const cycleTheme = useCallback(() => {
    const order: ThemeMode[] = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(settings.theme) + 1) % order.length];
    void saveSettings({ theme: next });
  }, [settings.theme, saveSettings]);

  const value = useMemo<AppStateValue>(
    () => ({
      clusters,
      reloadClusters,
      settings,
      saveSettings,
      theme: settings.theme,
      resolvedTheme,
      setTheme,
      cycleTheme,
      info,
      ready,
    }),
    [clusters, reloadClusters, settings, saveSettings, resolvedTheme, setTheme, cycleTheme, info, ready],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider');
  return ctx;
}
