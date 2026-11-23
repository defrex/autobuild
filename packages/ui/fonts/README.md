Self-hosted variable fonts, distributed under the included SIL Open Font Licenses.

- Atkinson Hyperlegible Next: https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegiblenext (Braille Institute; weights 100–900).
- JetBrains Mono: https://github.com/JetBrains/JetBrainsMono/tree/master/fonts/variable (JetBrains; weights 100–800).

These are Latin WOFF2 subsets of the variable TTFs in
`packages/hosted-store-service/app/fonts/` (downloaded 2026-10-24), small
enough to ship inside the bundle so text never reflows when a face arrives.
Regenerate with fonttools:

```sh
U="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2190-2193,U+2212,U+2215,U+2022,U+2026,U+2264-2265"
uvx --from 'fonttools[woff]' pyftsubset <font>.ttf --unicodes="$U" --flavor=woff2 --layout-features='*' --output-file=<font>.latin.woff2
```
