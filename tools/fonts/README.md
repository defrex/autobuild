# Dashboard capture fallback fonts

These deterministic, monochrome fallback subsets are used only by the repository's dashboard evidence renderer. They keep the scripted CJK and emoji samples readable without loading host-system fonts.

The TTF files were converted losslessly with `woff2_decompress` from these Fontsource 5.3.0 variable-font subsets:

- `noto-sans-jp-{113,117,118}.ttf` from `@fontsource-variable/noto-sans-jp`
- `noto-emoji-{0,6,8}.ttf` from `@fontsource-variable/noto-emoji`

Only the Fontsource subset blocks that contain the fixed scenario's samples are included. Each variable block is instantiated at weight 400 and given a block-specific internal family name so resvg can fall through the complete family list instead of treating same-named subset files as one face. The original SIL Open Font License notices are checked in alongside the fonts.
