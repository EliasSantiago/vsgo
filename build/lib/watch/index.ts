/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

hardenAgainstVanishedFiles();

const watch = process.platform === 'win32' ? require('./watch-win32.ts').default : require('vscode-gulp-watch');

/**
 * Stops a file that disappears mid-event from killing the whole watch task.
 *
 * `vscode-gulp-watch` reads every changed file through `vinyl-file`, and does it
 * with no rejection handler:
 *
 *     vinyl.read(filepath, fileOptions).then(file => write(event, null, file));
 *
 * Anything that saves atomically — most editors, including VS Code with
 * `files.atomicSave` — writes `foo.ts.tmp.<pid>.<hash>` and renames it into
 * place. The watcher sees the create, waits out `readDelay`, then stats a path
 * that is already gone. Nothing catches the resulting ENOENT, so it surfaces as
 * an unhandled rejection and takes the gulp task down with it. The failure is
 * quiet in the worst way: the watch is dead, `out/` stops changing, and edits go
 * on compiling into nothing until somebody thinks to check.
 *
 * The file no longer exists, so there is nothing to rebuild from it and dropping
 * the event is the correct outcome. Returning a promise that never settles
 * leaves the library's `then` unreached; nothing holds a reference to it
 * afterwards, so it is collected like any other unreachable value. Every other
 * error is rethrown, keeping real failures as loud as they were.
 */
function hardenAgainstVanishedFiles(): void {
	const vinylFile = require('vinyl-file');
	const read = vinylFile.read;
	vinylFile.read = function (this: unknown, ...args: any[]): Promise<unknown> {
		return read.apply(this, args).catch((err: NodeJS.ErrnoException) => {
			if (err?.code === 'ENOENT') {
				return new Promise(() => { });
			}
			throw err;
		});
	};
}

export default function (...args: any[]): ReturnType<typeof watch> {
	return watch.apply(null, args);
}
