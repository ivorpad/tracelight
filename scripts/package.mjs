// Native parser/compiler binaries make the package specific to its build platform.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let platform = process.platform;
if (platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) platform = 'alpine';
const target = `${platform}-${process.arch}`;
if (!['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'linux-arm64', 'linux-x64', 'alpine-arm64', 'alpine-x64'].includes(target)) throw Error(`Unsupported package target ${target}`);
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const filename = `tracelight-${version}-${target}.vsix`;
if (process.argv.includes('--name')) console.log(filename);
else {
  execFileSync(process.execPath, ['esbuild.mjs', '--production'], { stdio: 'inherit' });
  execFileSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--no-dependencies', '--target', target, '--out', filename], { stdio: 'inherit' });
}
