/** Release naming shared by the updater and its tests; must agree with electron-builder.yml. */

export type InstallKind = 'mac' | 'nsis' | 'appimage';

/** The release asset an install of this kind and architecture updates from. */
export function assetName(kind: InstallKind, arch: string): string {
  switch (kind) {
    case 'mac':
      return `Erebus-mac-${arch}.zip`;
    case 'nsis':
      return `Erebus-win-${arch}-setup.exe`;
    case 'appimage':
      // electron-builder names AppImages after the Linux arch, not Node's.
      return `Erebus-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`;
  }
}

/** 0.2.10 > 0.2.9; a leading v is ignored; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ''] = v.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}
