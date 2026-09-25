/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'node:test';
import { create } from 'tar';
import { copilotPlatforms, ensureCopilotPlatformPackage, getCopilotExcludeFilter, getCopilotRuntimePrebuildFiles, getCopilotRuntimeVersion, getMxcExcludeFilter } from '../copilot.ts';

/**
 * Builds a fake `@github/copilot-win32-x64@1.0.73` tarball on disk and returns
 * its path plus the `sha512-...` integrity of its bytes, so a test can pin that
 * integrity in a lockfile the build verifies against.
 */
function createPinnedCopilotWin32Tarball(dir: string): { tarball: string; integrity: string } {
	const stage = fs.mkdtempSync(path.join(dir, 'pkg-'));
	const packageRoot = path.join(stage, 'package');
	fs.mkdirSync(path.join(packageRoot, 'prebuilds', 'win32-x64'), { recursive: true });
	fs.mkdirSync(path.join(packageRoot, 'tgrep', 'bin', 'win32-x64'), { recursive: true });
	fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version: '1.0.73' }));
	fs.writeFileSync(path.join(packageRoot, 'prebuilds', 'win32-x64', 'runtime.node'), 'EXT-NATIVE-1.0.73');
	fs.writeFileSync(path.join(packageRoot, 'tgrep', 'bin', 'win32-x64', 'tgrep.exe'), 'EXT-TGREP-1.0.73');
	const tarball = path.join(stage, 'copilot-win32-x64.tgz');
	create({ file: tarball, cwd: stage, gzip: true, sync: true }, ['package']);
	const integrity = 'sha512-' + createHash('sha512').update(fs.readFileSync(tarball)).digest('base64');
	return { tarball, integrity };
}

suite('copilot', () => {
	test('reads the runtime version owned by the SDK', () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-copilot-version-test-'));
		try {
			const sdkDir = path.join(repoRoot, 'node_modules', '@github', 'copilot-sdk');
			fs.mkdirSync(sdkDir, { recursive: true });
			fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ copilotCliVersion: '1.2.3' }));

			assert.strictEqual(getCopilotRuntimeVersion(path.join(repoRoot, 'node_modules')), '1.2.3');
		} finally {
			fs.rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	test('keeps the SDK runtime package include list scoped to the selected platform', () => {
		const files = getCopilotRuntimePrebuildFiles('linux', 'x64');

		assert.deepStrictEqual(files, [
			'node_modules/@github/copilot-sdk-linux-x64/**',
			'!node_modules/@github/copilot-sdk-linux-x64/builtin/**',
			'!node_modules/@github/copilot-sdk-linux-x64/builtin-skills/**',
			'!node_modules/@github/copilot-sdk-linux-x64/clipboard/**',
			'!node_modules/@github/copilot-sdk-linux-x64/foundry-local-sdk/**',
			'!node_modules/@github/copilot-sdk-linux-x64/mxc-bin/**',
			'!node_modules/@github/copilot-sdk-linux-x64/pvrecorder/**',
			'!node_modules/@github/copilot-sdk-linux-x64/webview/**',
			'!node_modules/@github/copilot-sdk-linux-x64/plugins/computer-use/**',
			'!node_modules/@github/copilot-sdk-linux-x64/prebuilds/*/computer.node',
			'!node_modules/@github/copilot-sdk-linux-x64/prebuilds/*/keytar.node',
			'!node_modules/@github/copilot-sdk-linux-x64/prebuilds/*/mediaremote-adapter/**',
		]);
		assertCopilotPlatformPackageIncludes(files, 'node_modules/@github/copilot-sdk-linux-x64', [
			'prebuilds/linux-x64/runtime.node',
			'prebuilds/linux-x64/copilot-runtime',
			'sdk/index.js',
			'definitions/task.agent.yaml',
			'ripgrep/bin/linux-x64/rg',
			'tgrep/bin/linux-x64/tgrep',
		]);
		assertOptionalCopilotNativeDependenciesExcluded(files, 'node_modules/@github/copilot-sdk-linux-x64');
	});

	test('uses the linuxmusl package runtime for alpine builds', () => {
		const files = getCopilotRuntimePrebuildFiles('alpine', 'x64');

		assert.deepStrictEqual(files, [
			'node_modules/@github/copilot-sdk-linuxmusl-x64/**',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/builtin/**',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/builtin-skills/**',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/clipboard/**',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/foundry-local-sdk/**',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/mxc-bin/**',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/pvrecorder/**',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/webview/**',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/plugins/computer-use/**',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/prebuilds/*/computer.node',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/prebuilds/*/keytar.node',
			'!node_modules/@github/copilot-sdk-linuxmusl-x64/prebuilds/*/mediaremote-adapter/**',
		]);
		assertCopilotPlatformPackageIncludes(files, 'node_modules/@github/copilot-sdk-linuxmusl-x64', [
			'prebuilds/linuxmusl-x64/runtime.node',
			'prebuilds/linuxmusl-x64/copilot-runtime',
			'sdk/index.js',
		]);
		assertOptionalCopilotNativeDependenciesExcluded(files, 'node_modules/@github/copilot-sdk-linuxmusl-x64');
	});

	test('uses the .exe package runtime for windows builds', () => {
		assert.deepStrictEqual(getCopilotRuntimePrebuildFiles('win32', 'x64'), [
			'node_modules/@github/copilot-sdk-win32-x64/**',
			'!node_modules/@github/copilot-sdk-win32-x64/builtin/**',
			'!node_modules/@github/copilot-sdk-win32-x64/builtin-skills/**',
			'!node_modules/@github/copilot-sdk-win32-x64/clipboard/**',
			'!node_modules/@github/copilot-sdk-win32-x64/foundry-local-sdk/**',
			'!node_modules/@github/copilot-sdk-win32-x64/mxc-bin/**',
			'!node_modules/@github/copilot-sdk-win32-x64/pvrecorder/**',
			'!node_modules/@github/copilot-sdk-win32-x64/webview/**',
			'!node_modules/@github/copilot-sdk-win32-x64/plugins/computer-use/**',
			'!node_modules/@github/copilot-sdk-win32-x64/prebuilds/*/computer.node',
			'!node_modules/@github/copilot-sdk-win32-x64/prebuilds/*/keytar.node',
			'!node_modules/@github/copilot-sdk-win32-x64/prebuilds/*/mediaremote-adapter/**',
		]);
		assertCopilotPlatformPackageIncludes(getCopilotRuntimePrebuildFiles('win32', 'x64'), 'node_modules/@github/copilot-sdk-win32-x64', [
			'prebuilds/win32-x64/runtime.node',
			'prebuilds/win32-x64/copilot-runtime.exe',
			'sdk/index.js',
		]);
		assertOptionalCopilotNativeDependenciesExcluded(getCopilotRuntimePrebuildFiles('win32', 'x64'), 'node_modules/@github/copilot-sdk-win32-x64');
	});

	test('keeps macOS runtime prebuilds in the selected platform package', () => {
		const files = getCopilotRuntimePrebuildFiles('darwin', 'arm64');

		assertCopilotPlatformPackageIncludes(files, 'node_modules/@github/copilot-sdk-darwin-arm64', [
			'sdk/index.js',
			'prebuilds/darwin-arm64/runtime.node',
			'prebuilds/darwin-arm64/copilot-runtime',
		]);
		assertOptionalCopilotNativeDependenciesExcluded(files, 'node_modules/@github/copilot-sdk-darwin-arm64');
	});

	for (const { platform, arch, packagePlatformArch } of [
		{ platform: 'darwin', arch: 'arm64', packagePlatformArch: 'darwin-arm64' },
		{ platform: 'darwin', arch: 'x64', packagePlatformArch: 'darwin-x64' },
		{ platform: 'linux', arch: 'arm64', packagePlatformArch: 'linux-arm64' },
		{ platform: 'linux', arch: 'x64', packagePlatformArch: 'linux-x64' },
		{ platform: 'alpine', arch: 'arm64', packagePlatformArch: 'linuxmusl-arm64' },
		{ platform: 'alpine', arch: 'x64', packagePlatformArch: 'linuxmusl-x64' },
		{ platform: 'linux', arch: 'alpine', packagePlatformArch: 'linuxmusl-x64' },
		{ platform: 'win32', arch: 'arm64', packagePlatformArch: 'win32-arm64' },
		{ platform: 'win32', arch: 'x64', packagePlatformArch: 'win32-x64' },
	]) {
		test(`keeps the SDK runtime in desktop and remote packages for ${platform}-${arch}`, () => {
			for (const nodeModulesRoot of ['node_modules', 'remote/node_modules']) {
				const sdkPackageDir = `${nodeModulesRoot}/@github/copilot-sdk-${packagePlatformArch}`;
				const executable = `${sdkPackageDir}/prebuilds/${packagePlatformArch}/${platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime'}`;
				const sdk = `${sdkPackageDir}/sdk/index.js`;
				assert.deepStrictEqual({
					runtimeExecutable: matchesGlob(executable, getCopilotRuntimePrebuildFiles(platform, arch, nodeModulesRoot)),
					runtimeSdk: matchesGlob(sdk, getCopilotRuntimePrebuildFiles(platform, arch, nodeModulesRoot)),
					dependenciesExecutable: matchesGlob(executable, getCopilotExcludeFilter(platform, arch)),
					dependenciesSdk: matchesGlob(sdk, getCopilotExcludeFilter(platform, arch)),
					standaloneCli: matchesGlob(`product/${nodeModulesRoot}/@github/copilot-${packagePlatformArch}/copilot`, getCopilotExcludeFilter(platform, arch)),
				}, {
					runtimeExecutable: true,
					runtimeSdk: true,
					dependenciesExecutable: true,
					dependenciesSdk: true,
					standaloneCli: false,
				}, sdkPackageDir);
			}
		});
	}

	test('materializes missing target platform packages from the lockfile', () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-copilot-platform-test-'));
		const nodeModulesRoot = path.join(repoRoot, 'node_modules');
		try {
			fs.mkdirSync(nodeModulesRoot, { recursive: true });
			fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), JSON.stringify({
				packages: {
					'node_modules/@github/copilot-sdk-darwin-x64': {
						version: '1.0.64-1',
					}
				}
			}));

			ensureCopilotPlatformPackage('darwin', 'x64', nodeModulesRoot, {
				packPackage: (packageName, _version, tempDir) => {
					assert.strictEqual(packageName, '@github/copilot-sdk-darwin-x64');
					const packageRoot = path.join(tempDir, 'package');
					fs.mkdirSync(path.join(packageRoot, 'prebuilds', 'darwin-x64'), { recursive: true });
					fs.mkdirSync(path.join(packageRoot, 'sdk'), { recursive: true });
					fs.writeFileSync(path.join(packageRoot, 'sdk', 'index.js'), '');
					fs.writeFileSync(path.join(packageRoot, 'prebuilds', 'darwin-x64', 'copilot-runtime'), '');
					fs.writeFileSync(path.join(packageRoot, 'prebuilds', 'darwin-x64', 'runtime.node'), '');
					const tarball = path.join(tempDir, 'copilot-sdk-darwin-x64.tgz');
					create({ file: tarball, cwd: tempDir, gzip: true, sync: true }, ['package']);
					return tarball;
				}
			});

			assert.deepStrictEqual({
				sdk: fs.existsSync(path.join(nodeModulesRoot, '@github', 'copilot-sdk-darwin-x64', 'sdk', 'index.js')),
				runtime: fs.existsSync(path.join(nodeModulesRoot, '@github', 'copilot-sdk-darwin-x64', 'prebuilds', 'darwin-x64', 'copilot-runtime')),
				native: fs.existsSync(path.join(nodeModulesRoot, '@github', 'copilot-sdk-darwin-x64', 'prebuilds', 'darwin-x64', 'runtime.node')),
			}, {
				sdk: true,
				runtime: true,
				native: true,
			});
		} finally {
			fs.rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	test('rejects a target SDK platform package with missing runtime files', () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-copilot-runtime-test-'));
		const nodeModulesRoot = path.join(repoRoot, 'node_modules');
		try {
			fs.mkdirSync(nodeModulesRoot, { recursive: true });
			fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), JSON.stringify({
				packages: {
					'node_modules/@github/copilot-sdk-darwin-x64': {
						version: '1.0.14',
					}
				}
			}));

			assert.throws(() => ensureCopilotPlatformPackage('darwin', 'x64', nodeModulesRoot, {
				packPackage: (_packageName, _version, tempDir) => {
					const packageRoot = path.join(tempDir, 'package');
					fs.mkdirSync(packageRoot, { recursive: true });
					fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
					const tarball = path.join(tempDir, 'copilot-sdk-darwin-x64.tgz');
					create({ file: tarball, cwd: tempDir, gzip: true, sync: true }, ['package']);
					return tarball;
				}
			}), /is missing SDK runtime files/);
		} finally {
			fs.rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	test('excludes legacy and non-target Copilot platform packages from the dependency stream', () => {
		const files = getCopilotExcludeFilter('linux', 'x64');

		assert.deepStrictEqual({
			standaloneCliRuntime: matchesGlob('product/node_modules/@github/copilot-linux-x64/copilot', files),
			targetSdkEntrypoint: matchesGlob('product/node_modules/@github/copilot-sdk-linux-x64/sdk/index.js', files),
			nonTargetSdkRuntime: matchesGlob('product/node_modules/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime', files),
			nonTargetCliRuntime: matchesGlob('product/node_modules/@github/copilot-darwin-arm64/copilot', files),
		}, {
			standaloneCliRuntime: false,
			targetSdkEntrypoint: true,
			nonTargetSdkRuntime: false,
			nonTargetCliRuntime: false,
		});
	});

	test('strips all copilot platform packages for unsupported armhf builds', () => {
		assert.deepStrictEqual(
			getCopilotExcludeFilter('linux', 'armhf'),
			[
				'**',
				...copilotPlatforms.map(platform => `!**/node_modules/@github/copilot-${platform}/**`),
				...copilotPlatforms.map(platform => `!**/node_modules/@github/copilot-sdk-${platform}/**`),
			]
		);
	});

	test('keeps only the target architecture of @microsoft/mxc-sdk', () => {
		assert.deepStrictEqual(
			getMxcExcludeFilter('x64'),
			[
				'**',
				'!**/node_modules/@microsoft/mxc-sdk/bin/arm64/**',
			]
		);
		assert.deepStrictEqual(
			getMxcExcludeFilter('arm64'),
			[
				'**',
				'!**/node_modules/@microsoft/mxc-sdk/bin/x64/**',
			]
		);
	});

	test('strips every @microsoft/mxc-sdk architecture for unsupported armhf builds', () => {
		assert.deepStrictEqual(
			getMxcExcludeFilter('armhf'),
			[
				'**',
				'!**/node_modules/@microsoft/mxc-sdk/bin/x64/**',
				'!**/node_modules/@microsoft/mxc-sdk/bin/arm64/**',
			]
		);
	});
});

function assertCopilotPlatformPackageIncludes(patterns: string[], packageDir: string, relativeFiles: string[]): void {
	assert(patterns.includes(`${packageDir}/**`));
	for (const relativeFile of relativeFiles) {
		assert(matchesGlob(`${packageDir}/${relativeFile}`, patterns), relativeFile);
	}
}

function assertOptionalCopilotNativeDependenciesExcluded(patterns: string[], packageDir: string): void {
	for (const dir of ['clipboard', 'foundry-local-sdk', 'mxc-bin', 'pvrecorder', 'webview']) {
		assert(patterns.includes(`!${packageDir}/${dir}/**`), dir);
		assert(!matchesGlob(`${packageDir}/${dir}/index.js`, patterns), dir);
	}
	assert(patterns.includes(`!${packageDir}/plugins/computer-use/**`), 'plugins/computer-use');
	assert(!matchesGlob(`${packageDir}/plugins/computer-use/computer-use-mcp.exe`, patterns), 'plugins/computer-use-mcp.exe');
	assert(!matchesGlob(`${packageDir}/plugins/computer-use/CopilotComputerUse.exe`, patterns), 'plugins/CopilotComputerUse.exe');
	assert(!matchesGlob(`${packageDir}/plugins/computer-use/Copilot Computer Use.app/Contents/MacOS/Copilot Computer Use`, patterns), 'plugins/Copilot Computer Use.app');
	assert(patterns.includes(`!${packageDir}/prebuilds/*/computer.node`), 'computer.node');
	assert(!matchesGlob(`${packageDir}/prebuilds/linux-x64/computer.node`, patterns), 'computer.node');
	assert(patterns.includes(`!${packageDir}/prebuilds/*/keytar.node`), 'keytar.node');
	assert(!matchesGlob(`${packageDir}/prebuilds/linux-x64/keytar.node`, patterns), 'keytar.node');
	assert(patterns.includes(`!${packageDir}/prebuilds/*/mediaremote-adapter/**`), 'mediaremote-adapter');
	assert(!matchesGlob(`${packageDir}/prebuilds/darwin-arm64/mediaremote-adapter/MediaRemoteAdapter.framework/MediaRemoteAdapter`, patterns), 'mediaremote-adapter');
}

function matchesGlob(file: string, patterns: string[]): boolean {
	let included = false;
	for (const pattern of patterns) {
		const isExclude = pattern.startsWith('!');
		const glob = isExclude ? pattern.slice(1) : pattern;
		if (matchesPattern(file, glob)) {
			included = !isExclude;
		}
	}
	return included;
}

function matchesPattern(file: string, pattern: string): boolean {
	if (pattern.endsWith('/**') && !pattern.slice(0, -3).includes('*')) {
		return file.startsWith(pattern.slice(0, -2));
	}

	if (pattern.includes('*')) {
		const regex = new RegExp(`^${pattern.split('**').map(part => part.split('*').map(escapeRegExp).join('[^/]+')).join('.*')}$`);
		return regex.test(file);
	}

	return file === pattern;
}

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
