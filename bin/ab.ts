#!/usr/bin/env bun
/** Published `ab` entry: unconditional production wiring, with no watcher or
 * dev-state branch. The repo-local hot entry lives separately in ab-dev.ts. */
import { runBinary } from '../src/cli/binary'

process.exit(await runBinary(process.argv.slice(2)))
