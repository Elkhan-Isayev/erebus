import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetName, compareVersions } from './releases';

describe('compareVersions', () => {
  it.each([
    ['0.2.6', '0.2.5', 1],
    ['0.2.5', '0.2.6', -1],
    ['0.2.10', '0.2.9', 1],
    ['1.0.0', '0.99.99', 1],
    ['v0.2.6', '0.2.6', 0],
    ['0.3', '0.3.0', 0],
    ['0.3.0', '0.3.0-beta.1', 1],
    ['0.3.0-beta.1', '0.3.0', -1],
    ['0.3.0-beta.1', '0.3.0-beta.2', -1],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('assetName', () => {
  it.each([
    ['mac', 'arm64', 'Erebus-mac-arm64.zip'],
    ['mac', 'x64', 'Erebus-mac-x64.zip'],
    ['nsis', 'x64', 'Erebus-win-x64-setup.exe'],
    ['nsis', 'arm64', 'Erebus-win-arm64-setup.exe'],
    ['appimage', 'x64', 'Erebus-linux-x86_64.AppImage'],
    ['appimage', 'arm64', 'Erebus-linux-arm64.AppImage'],
  ] as const)('%s on %s → %s', (kind, arch, expected) => {
    expect(assetName(kind, arch)).toBe(expected);
  });

  // The updater finds its asset by name; if electron-builder.yml renames one, updates break silently.
  it('agrees with the artifact names electron-builder is configured to produce', () => {
    const config = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    expect(config).toContain('artifactName: ${productName}-${os}-${arch}.${ext}'); // mac zip
    expect(config).toContain('artifactName: ${productName}-win-${arch}-setup.${ext}');
    expect(config).toMatch(/appImage:\s*\n\s*artifactName: \$\{productName\}-linux-\$\{arch\}\.\$\{ext\}/);
    expect(config).toMatch(/mac:[\s\S]*target: zip/);
  });
});
