/**
 * Self-update from GitHub releases.
 *
 * electron-updater cannot be used on macOS here: Squirrel.Mac only accepts an update whose
 * code signature satisfies the running app's designated requirement, and an ad-hoc
 * signature pins that requirement to one exact build. So the updater is ours on every
 * platform, and deliberately small: find the asset this install was made from, download
 * it, check it, and hand the swap to something that outlives the app.
 *
 *   macOS     .zip   — a detached shell script swaps the .app bundle once we have exited.
 *   Windows   setup  — the NSIS installer runs silently over the existing install and relaunches.
 *   Linux     AppImage — the file is replaced in place and relaunched.
 *
 * The portable .exe and deb/rpm installs cannot replace themselves; they get the release page.
 */
import { app, BrowserWindow, net, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UpdateState } from '../shared/types';
import { assetName, compareVersions } from './releases';
import { getSettings } from './store';

const REPO = 'Elkhan-Isayev/erebus';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const run = promisify(execFile);

interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** `sha256:<hex>` — GitHub computes it for every uploaded asset. */
  digest?: string | null;
}

interface Release {
  tag_name: string;
  html_url: string;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

let state: UpdateState = { status: 'idle', currentVersion: app.getVersion(), canInstall: false };
let release: Release | null = null;
let timer: NodeJS.Timeout | null = null;

function setState(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('erebus:update:state', state);
  }
  return state;
}

export const getUpdateState = (): UpdateState => state;

/* --------------------------------------------------------- install target */

type Target =
  | { kind: 'mac'; asset: string; bundle: string }
  | { kind: 'nsis'; asset: string }
  | { kind: 'appimage'; asset: string; file: string }
  | { kind: 'manual'; reason: string };

/** `…/Erebus.app/Contents/MacOS/Erebus` → `…/Erebus.app` */
const macBundle = () => path.resolve(process.execPath, '..', '..', '..');

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function installTarget(): Target {
  if (!app.isPackaged) return { kind: 'manual', reason: 'Development builds do not update themselves.' };
  const arch = process.arch;

  if (process.platform === 'darwin') {
    const bundle = macBundle();
    if (!bundle.endsWith('.app')) return { kind: 'manual', reason: 'Could not find the Erebus.app bundle.' };
    // Launched straight from the disk image, or quarantined into App Translocation.
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
      return { kind: 'manual', reason: 'Move Erebus to the Applications folder first — it is running from a read-only location.' };
    }
    if (!writable(path.dirname(bundle))) {
      return { kind: 'manual', reason: `${path.dirname(bundle)} is not writable for your user.` };
    }
    return { kind: 'mac', asset: assetName('mac', arch), bundle };
  }

  if (process.platform === 'win32') {
    if (process.env.PORTABLE_EXECUTABLE_FILE) {
      return { kind: 'manual', reason: 'The portable build cannot replace itself; download the new one.' };
    }
    return { kind: 'nsis', asset: assetName('nsis', arch) };
  }

  const appImage = process.env.APPIMAGE;
  if (appImage) {
    if (!writable(path.dirname(appImage))) {
      return { kind: 'manual', reason: `${path.dirname(appImage)} is not writable for your user.` };
    }
    return { kind: 'appimage', asset: assetName('appimage', arch), file: appImage };
  }
  return { kind: 'manual', reason: 'Installed from a package — update it with the new .deb or .rpm.' };
}

/* ------------------------------------------------------------------ check */

export async function checkForUpdates(): Promise<UpdateState> {
  if (state.status === 'downloading' || state.status === 'installing') return state;
  setState({ status: 'checking', error: undefined });
  try {
    // net.fetch goes through Chromium's stack, so it honours the system proxy like a browser.
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
    release = (await res.json()) as Release;

    const latest = release.tag_name.replace(/^v/, '');
    const newer = compareVersions(latest, app.getVersion()) > 0;
    const target = installTarget();
    const hasAsset = target.kind !== 'manual' && release.assets.some((a) => a.name === target.asset);
    return setState({
      status: newer ? 'available' : 'current',
      latestVersion: latest,
      releaseUrl: release.html_url,
      releaseNotes: release.body ?? undefined,
      canInstall: newer && hasAsset,
      error: newer && target.kind === 'manual' ? target.reason : undefined,
      checkedAt: Date.now(),
    });
  } catch (err) {
    return setState({ status: 'error', error: `Could not check for updates: ${(err as Error).message}`, checkedAt: Date.now() });
  }
}

/* ---------------------------------------------------------------- install */

async function download(asset: ReleaseAsset, dest: string): Promise<void> {
  const res = await net.fetch(asset.browser_download_url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length')) || asset.size;
  const hash = createHash('sha256');
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  let lastEmit = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.byteLength;
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      if (Date.now() - lastEmit > 150) {
        lastEmit = Date.now();
        setState({ received, total });
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  setState({ received, total });

  if (received !== asset.size) throw new Error(`Download was cut short: ${received} of ${asset.size} bytes`);
  const expected = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null;
  if (expected && hash.digest('hex') !== expected) throw new Error('Downloaded file does not match its published checksum');
}

/** The swap has to happen after we exit, so a shell outlives us and does it. */
const MAC_SWAP_SCRIPT = `
pid="$1"; app="$2"; staged="$3"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$app.previous"
mv "$app" "$app.previous" || { open "$app"; exit 1; }
if mv "$staged" "$app"; then
  rm -rf "$app.previous"
else
  mv "$app.previous" "$app"
fi
xattr -dr com.apple.quarantine "$app" 2>/dev/null
open "$app"
`;

async function installMac(bundle: string, zip: string, workDir: string): Promise<void> {
  const extracted = path.join(workDir, 'extracted');
  await run('/usr/bin/ditto', ['-x', '-k', zip, extracted]);
  const name = fs.readdirSync(extracted).find((entry) => entry.endsWith('.app'));
  if (!name) throw new Error('The update archive holds no .app bundle');
  const staged = path.join(extracted, name);
  // Refuse a bundle that would not launch rather than swap it in and strand the user.
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);

  const script = path.join(workDir, 'swap.sh');
  fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
  spawn('/bin/sh', [script, String(process.pid), bundle, staged], { detached: true, stdio: 'ignore' }).unref();
}

function installNsis(installer: string): void {
  // /S installs silently into the existing location; --force-run starts the app afterwards.
  spawn(installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
}

function installAppImage(file: string, downloaded: string): void {
  const next = `${file}.update`;
  fs.copyFileSync(downloaded, next);
  fs.chmodSync(next, 0o755);
  // Renaming over a running AppImage is fine: the old inode lives until we exit.
  fs.renameSync(next, file);
  app.relaunch({ execPath: file, args: [] });
}

export async function installUpdate(): Promise<void> {
  if (state.status !== 'available' || !release) throw new Error('No update is ready to install');
  const target = installTarget();
  const asset = target.kind === 'manual' ? undefined : release.assets.find((a) => a.name === target.asset);
  if (target.kind === 'manual' || !asset) {
    await shell.openExternal(release.html_url || RELEASES_PAGE);
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erebus-update-'));
  const file = path.join(workDir, asset.name);
  setState({ status: 'downloading', received: 0, total: asset.size, error: undefined });
  try {
    await download(asset, file);
    setState({ status: 'installing' });
    if (target.kind === 'mac') await installMac(target.bundle, file, workDir);
    else if (target.kind === 'nsis') installNsis(file);
    else installAppImage(target.file, file);
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    setState({ status: 'available', error: `Update failed: ${(err as Error).message}` });
    throw err;
  }
  app.quit();
}

/* -------------------------------------------------------------- schedule */

export function startUpdateChecks(): void {
  if (timer || !app.isPackaged) return;
  const tick = () => {
    if (getSettings().checkForUpdates !== false) void checkForUpdates();
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  timer = setInterval(tick, CHECK_INTERVAL_MS);
}
