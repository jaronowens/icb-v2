/**
 * The tags for each fixture, as listed in README.md. `tagFixtures` (test/helpers) applies them with PUT /media/:id.
 * Files that share a Media row (scene-a.png and its copy) have the same tags, so it doesn't matter which one is the
 * representative. notes.txt is left out: sync skips it, so it never gets a Media row.
 */
const FIXTURE_TAGS: Record<string, string[]> = {
    'scene-a.png': ['claude'],
    'scene-a-copy.png': ['claude'],
    'scene-a-small.png': ['claude'],
    'checker-b.jpg': ['claude'],
    'not-an-image.png': ['claude', 'broken'],
    'transparent-corner.png': ['claude'],
    '__beidou_genshin_impact_drawn_by_packge__26d9f313e83b566da8a9116ec71be5d4.jpg': ['beidou', 'series:genshin impact', '1girl'],
    'Roxanne.webp': ['roxanne', 'potionomics'],
    'amberlyn.jpg': ['original', 'source:pinterest'],
    '2148362390_preview_success-small-flip.gif': ['animated', 'series:helltaker'],
    '1337.jpg': ['series:deadlock', 'mina (deadlock)'],
    'RsniFBN.mp4': ['animated', 'video', 'alyssa liu'],
    'image-variant-1.jpg': ['meta:variant', 'elf', 'sfw', 'high-resolution'],
    'image-variant-2.jpg': ['meta:variant', 'elf', 'nsfw'],
    'image-variant-1-resized.jpg': ['meta:variant', 'elf', 'sfw'],
};

export { FIXTURE_TAGS };
