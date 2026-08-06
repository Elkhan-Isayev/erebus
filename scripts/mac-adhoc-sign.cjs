const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Ad-hoc signs the macOS bundle after packaging.
 *
 * Without an Apple Developer identity electron-builder leaves the bundle unsigned: it keeps
 * only the linker-signed signature of the original Electron binary, which no longer matches
 * the renamed bundle and has no `_CodeSignature` at all. macOS then refuses to launch the app
 * from a browser download — the file carries `com.apple.quarantine` and Gatekeeper reports it
 * as damaged, with no way for the user to override it.
 *
 * An ad-hoc signature is not notarisation and does not remove the first-launch prompt, but it
 * makes the bundle verifiable, so right-click → Open (or `xattr -dr com.apple.quarantine`)
 * works the way the README describes.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const run = (args) => execFileSync('codesign', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

  run(['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);
  run(['--verify', '--deep', '--strict', appPath]);

  console.log(`  • ad-hoc signed and verified ${path.basename(appPath)}`);
};
