import { describe, expect, test } from 'bun:test'
import { parseLdd } from './ship-git'

describe('parseLdd', () => {
  test('ldd output yields libraries, the loader and missing names', () => {
    expect(
      parseLdd(
        [
          '\tlinux-vdso.so.1 (0x00007ffd)',
          '\tlibz.so.1 => /usr/lib64/libz.so.1 (0x00007f01)',
          '\tlibfoo.so.2 => not found',
          '\t/lib64/ld-linux-x86-64.so.2 (0x00007f02)',
        ].join('\n'),
      ),
    ).toEqual({
      libraries: [{ soname: 'libz.so.1', path: '/usr/lib64/libz.so.1' }],
      loader: '/lib64/ld-linux-x86-64.so.2',
      missing: ['libfoo.so.2'],
    })
  })

  test('Debian prints the loader bare', () => {
    // `ldd /usr/bin/git` on debian:bookworm-slim.
    const output = [
      '\tlinux-vdso.so.1 (0x00007f6fd2af8000)',
      '\tlibpcre2-8.so.0 => /lib/x86_64-linux-gnu/libpcre2-8.so.0 (0x00007f6fd26a3000)',
      '\tlibz.so.1 => /lib/x86_64-linux-gnu/libz.so.1 (0x00007f6fd2684000)',
      '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f6fd24a2000)',
      '\t/lib64/ld-linux-x86-64.so.2 (0x00007f6fd2afa000)',
      '',
    ].join('\n')
    expect(parseLdd(output)).toEqual({
      libraries: [
        { soname: 'libpcre2-8.so.0', path: '/lib/x86_64-linux-gnu/libpcre2-8.so.0' },
        { soname: 'libz.so.1', path: '/lib/x86_64-linux-gnu/libz.so.1' },
        { soname: 'libc.so.6', path: '/lib/x86_64-linux-gnu/libc.so.6' },
      ],
      loader: '/lib64/ld-linux-x86-64.so.2',
      missing: [],
    })
  })

  test('Arch prints the loader in arrow form, and it is not also a library', () => {
    // `ldd /usr/bin/git` on Arch Linux.
    const output = [
      '\tlinux-vdso.so.1 (0x00007f9c8d32f000)',
      '\tlibpcre2-8.so.0 => /usr/lib/libpcre2-8.so.0 (0x00007f9c8d249000)',
      '\tlibz-ng.so.2 => /usr/lib/libz-ng.so.2 (0x00007f9c8d21f000)',
      '\tlibc.so.6 => /usr/lib/libc.so.6 (0x00007f9c8c800000)',
      '\t/lib64/ld-linux-x86-64.so.2 => /usr/lib64/ld-linux-x86-64.so.2 (0x00007f9c8d331000)',
      '',
    ].join('\n')
    const parsed = parseLdd(output)
    expect(parsed).toEqual({
      libraries: [
        { soname: 'libpcre2-8.so.0', path: '/usr/lib/libpcre2-8.so.0' },
        { soname: 'libz-ng.so.2', path: '/usr/lib/libz-ng.so.2' },
        { soname: 'libc.so.6', path: '/usr/lib/libc.so.6' },
      ],
      loader: '/lib64/ld-linux-x86-64.so.2',
      missing: [],
    })
    expect(parsed.libraries.filter((entry) => entry.soname.startsWith('/'))).toEqual([])
  })
})
