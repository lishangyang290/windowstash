import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
export const macAppName = 'WindowStash Companion.app';
export const macPackageId = 'app.windowstash.companion.installer';
export const macInstallerName = version => `WindowStash-v${version}-macOS-arm64-setup.pkg`;
const run = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
const plist = path => JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]));
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

export function validateMacApp(app, version) {
  const info = plist(join(app, 'Contents/Info.plist'));
  requireValue(info.CFBundleIdentifier === 'app.windowstash.companion', 'Companion Bundle ID 不正确');
  requireValue(info.CFBundleExecutable === 'windowstash-companion', 'Companion 启动路径不正确');
  requireValue(info.CFBundleShortVersionString === version, 'Companion 版本不正确');
  const binaries = readdirSync(join(app, 'Contents/MacOS')).sort();
  requireValue(JSON.stringify(binaries) === JSON.stringify(['windowstash-companion', 'windowstash-native-host']), '应用可执行文件清单不正确');
  for (const binary of binaries) {
    const path = join(app, 'Contents/MacOS', binary);
    const stat = lstatSync(path);
    requireValue(stat.isFile() && (stat.mode & 0o111), `${binary} 不可执行`);
    requireValue(run('/usr/bin/lipo', ['-archs', path]).trim() === 'arm64', `${binary} 必须为 arm64`);
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}

// Expands only into a caller-owned temporary directory; never executes package scripts.
export function expandMacPackage(installer, destination, version) {
  const members = run('/usr/sbin/pkgutil', ['--payload-files', resolve(installer)]).trim().split('\n');
  requireValue(new Set(members).size === members.length, '安装器包含重复的归档路径');
  requireValue(members.every(name => {
    // pkgbuild may encode extended attributes as AppleDouble archive members.
    const parts = name.split('/').map(part => part.startsWith('._') ? part.slice(2) : part);
    const normalized = parts.join('/');
    return !parts.includes('..') && (normalized === '.' || normalized === `./${macAppName}` || normalized.startsWith(`./${macAppName}/`));
  }), '安装器包含应用外路径');
  run('/usr/sbin/pkgutil', ['--expand-full', resolve(installer), destination]);
  const distribution = readFileSync(join(destination, 'Distribution'), 'utf8');
  requireValue(/hostArchitectures="arm64"/.test(distribution), '安装器必须限定 arm64');
  requireValue(/enable_localSystem="true"/.test(distribution) && /enable_currentUserHome="false"/.test(distribution), '安装器目标卷不正确');
  const components = readdirSync(destination).filter(name => name.endsWith('.pkg'));
  requireValue(components.length === 1, '必须且只能包含一个应用组件');
  const component = join(destination, components[0]);
  const info = readFileSync(join(component, 'PackageInfo'), 'utf8');
  requireValue(info.includes(`identifier="${macPackageId}"`) && info.includes(`version="${version}"`) && info.includes('install-location="/Applications"'), '安装包标识、版本或安装位置不正确');
  requireValue(/relocatable="false"/.test(info) && /overwrite-permissions="true"/.test(info), '安装包禁止重定位并需统一应用权限');
  requireValue(/<upgrade-bundle>\s*<bundle id="app\.windowstash\.companion"\/>\s*<\/upgrade-bundle>/.test(info), '必须完整替换应用而非合并旧文件');
  requireValue(/<strict-identifier>\s*<bundle id="app\.windowstash\.companion"\/>\s*<\/strict-identifier>/.test(info), '必须核对原应用标识');
  requireValue(!/<bundle-version>\s*<bundle\b/.test(info), '同版本重复安装不能跳过应用更新');
  const payload = join(component, 'Payload');
  requireValue(JSON.stringify(readdirSync(payload)) === JSON.stringify([macAppName]), '安装器包含多余或缺失的应用');
  const scripts = join(component, 'Scripts');
  const expectedScripts = ['postinstall', 'preinstall', 'processes.sh'];
  requireValue(JSON.stringify(readdirSync(scripts).sort()) === JSON.stringify(expectedScripts), '安装脚本清单不正确');
  for (const name of expectedScripts) {
    requireValue(readFileSync(join(scripts, name)).equals(readFileSync(join(repository, 'scripts/macos-installer', name))), `安装脚本内容不一致：${name}`);
    run('/bin/sh', ['-n', join(scripts, name)]);
  }
  validateMacApp(join(payload, macAppName), version);
  return payload;
}

export function buildMacPackage(app, installer, version) {
  requireValue(process.platform === 'darwin' && process.arch === 'arm64', '请在 Apple Silicon macOS 上打包');
  requireValue(/^\d+\.\d+\.\d+$/.test(version), '无效安装包版本');
  validateMacApp(app, version);
  requireValue(!existsSync(installer) || lstatSync(installer).isFile(), '输出位置必须为普通安装包文件');
  mkdirSync(dirname(installer), { recursive: true });
  const temporary = mkdtempSync(join(dirname(installer), '.windowstash-pkg-'));
  try {
    const root = join(temporary, 'root'), scripts = join(temporary, 'scripts');
    mkdirSync(root); mkdirSync(scripts);
    run('/usr/bin/ditto', ['--norsrc', '--noextattr', '--noqtn', '--noacl', resolve(app), join(root, macAppName)]);
    for (const name of ['preinstall', 'postinstall', 'processes.sh']) {
      copyFileSync(join(repository, 'scripts/macos-installer', name), join(scripts, name));
      chmodSync(join(scripts, name), 0o755);
    }
    const components = join(temporary, 'components.plist');
    writeFileSync(components, JSON.stringify([{
      RootRelativeBundlePath: macAppName, BundleIsRelocatable: false,
      BundleIsVersionChecked: false, BundleHasStrictIdentifier: true, BundleOverwriteAction: 'upgrade',
    }]), 'utf8');
    run('/usr/bin/plutil', ['-convert', 'xml1', components]);
    run('/usr/bin/pkgbuild', ['--root', root, '--component-plist', components, '--identifier', macPackageId,
      '--version', version, '--install-location', '/Applications', '--ownership', 'recommended', '--scripts', scripts, join(temporary, 'Companion.pkg')]);
    const distribution = join(temporary, 'Distribution');
    writeFileSync(distribution, `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>WindowStash Companion</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <volume-check><allowed-os-versions><os-version min="12.0"/></allowed-os-versions></volume-check>
  <choices-outline><line choice="companion"/></choices-outline>
  <choice id="companion" visible="false"><pkg-ref id="${macPackageId}"/></choice>
  <pkg-ref id="${macPackageId}" version="${version}" onConclusion="none">Companion.pkg</pkg-ref>
</installer-gui-script>
`, 'utf8');
    const product = join(temporary, 'product.pkg');
    run('/usr/bin/productbuild', ['--distribution', distribution, '--package-path', temporary, product]);
    expandMacPackage(product, join(temporary, 'verified'), version);
    renameSync(product, installer);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return installer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = JSON.parse(readFileSync(join(repository, 'companion/package.json'), 'utf8')).version;
  const app = resolve(process.argv[2] ?? join(repository, 'companion/src-tauri/target/release/bundle/macos', macAppName));
  const installer = resolve(process.argv[3] ?? join(repository, 'companion/src-tauri/target/release/bundle/pkg', macInstallerName(version)));
  console.log(buildMacPackage(app, installer, version));
}
