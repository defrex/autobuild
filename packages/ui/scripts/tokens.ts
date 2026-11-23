import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tokensCss } from '../src/tokens-css'

const target = join(import.meta.dir, '../src/generated/tokens.css')
await writeFile(target, tokensCss())
console.log(`wrote ${target}`)
