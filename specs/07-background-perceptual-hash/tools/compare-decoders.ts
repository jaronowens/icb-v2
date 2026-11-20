// Compares image-hash's perceptual hashes with the app's sharp + blockhash pipeline, with and without a resize.
// Needs image-hash, which the app no longer depends on: `npm install --no-save image-hash` first if it's missing.
//
// Usage (from the repo root):
//   npx tsx specs/background-perceptual-hash/tools/compare-decoders.ts <imageDir> [--pairs] [--golden] [--resize=512]
//
//   A = image-hash, imageHash(file, 16, true)
//   B = sharp, full size, then blockhash
//   C = sharp, resized so the longest side is --resize (default 512), then blockhash
//
//   --pairs   also print pairwise distances under A, B and C. For duplicates-test, also checks the
//             near-match ground truth (specs/near-match-duplicates/spec.md).
//   --golden  print A for every file as a TypeScript object, for test/fixtures/goldenHashes.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { imageHash } from 'image-hash';
import blockhash from '../../../service/blockHash';
import { decodeRGBA } from '../../../service/perceptualHashWorker';
import { HASH_BITS, PERCEPTUAL_TYPES } from '../../../service/perceptualHashSettings';

const args = process.argv.slice(2);
const dir = args.find(arg => !arg.startsWith('--'));
const showPairs = args.includes('--pairs');
const golden = args.includes('--golden');
const resize = Number(args.find(arg => arg.startsWith('--resize='))?.split('=')[1] ?? 512);
if (!dir) {
    console.error('Usage: compare-decoders.ts <imageDir> [--pairs] [--golden] [--resize=512]');
    process.exit(1);
}

/* Alternate sets in duplicates-test, by file number. Every pair inside a set is an alternate pair. */
const ALTERNATE_SETS: number[][] = [
    [1, 39], [2, 29], [3, 22], [4, 7], [5, 9, 24], [6, 23, 36], [10, 11, 31],
    [12, 32], [15, 30], [17, 28], [18, 38], [19, 26], [27, 35],
];

const hamming = (a: string, b: string): number => {
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
        let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (x) { distance += x & 1; x >>= 1; }
    }
    return distance;
};

type Result = { file: string, A?: string, B?: string, C?: string, timeA: number, decodeB: number, hashB: number, decodeC: number, hashC: number, error?: string };

/* Times decode and blockhash separately, so the main-thread cost of blockhash is visible. */
const sharpHash = async (buffer: Buffer, size: number | null) => {
    let start = performance.now();
    const pixels = await decodeRGBA(buffer, size);
    const decode = performance.now() - start;
    start = performance.now();
    const hash = blockhash(pixels, HASH_BITS, 2);
    return { hash, decode, hashTime: performance.now() - start };
};

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const max = (values: number[]) => values.length ? Math.max(...values) : NaN;
const fmt = (n: number, digits = 1) => Number.isNaN(n) ? '-' : n.toFixed(digits);

(async () => {
    const files = fs.readdirSync(dir)
        .filter(file => PERCEPTUAL_TYPES.includes(path.extname(file).slice(1).toLowerCase()))
        .sort((a, b) => (parseInt(a) - parseInt(b)) || a.localeCompare(b));

    const results: Result[] = [];
    for (const file of files) {
        const filePath = path.join(dir, file);
        const result: Result = { file, timeA: NaN, decodeB: NaN, hashB: NaN, decodeC: NaN, hashC: NaN };
        try {
            let start = performance.now();
            result.A = await imageHash(filePath, HASH_BITS, true);
            result.timeA = performance.now() - start;
        } catch (err) {
            result.error = `image-hash: ${err.message}`;
        }
        try {
            const buffer = fs.readFileSync(filePath);
            const b = await sharpHash(buffer, null);
            const c = await sharpHash(buffer, resize);
            Object.assign(result, { B: b.hash, decodeB: b.decode, hashB: b.hashTime, C: c.hash, decodeC: c.decode, hashC: c.hashTime });
        } catch (err) {
            result.error = `${result.error ? result.error + '; ' : ''}sharp: ${err.message}`;
        }
        results.push(result);
    }

    if (golden) {
        console.log('export const GOLDEN_PHASH16: Record<string, string> = {');
        for (const result of results.filter(result => result.A)) {
            console.log(`    '${result.file}': '${result.A}',`);
        }
        console.log('};');
        return;
    }

    console.log(`${dir}: ${files.length} images, resize C = ${resize}px\n`);
    console.log('file'.padEnd(40), 'd(A,B)', 'd(A,C)', ' A ms', ' B dec', 'B hash', ' C dec', 'C hash');
    for (const r of results) {
        const dAB = r.A && r.B ? String(hamming(r.A, r.B)) : '-';
        const dAC = r.A && r.C ? String(hamming(r.A, r.C)) : '-';
        console.log(
            r.file.slice(0, 40).padEnd(40), dAB.padStart(6), dAC.padStart(6),
            fmt(r.timeA, 0).padStart(5), fmt(r.decodeB, 0).padStart(6), fmt(r.hashB, 0).padStart(6),
            fmt(r.decodeC, 0).padStart(6), fmt(r.hashC, 1).padStart(6),
            r.error ? `  ERROR ${r.error}` : '',
        );
    }

    const both = results.filter(r => r.A && r.B && r.C);
    const dAB = both.map(r => hamming(r.A, r.B));
    const dAC = both.map(r => hamming(r.A, r.C));
    console.log(`\nSummary (${both.length} images hashed by all three):`);
    console.log(`  d(A,B): ${dAB.filter(d => d === 0).length} exact, max ${max(dAB)}, mean ${fmt(mean(dAB), 2)}`);
    console.log(`  d(A,C): ${dAC.filter(d => d === 0).length} exact, max ${max(dAC)}, mean ${fmt(mean(dAC), 2)}`);
    console.log(`  mean ms: A ${fmt(mean(both.map(r => r.timeA)))}, B ${fmt(mean(both.map(r => r.decodeB + r.hashB)))} ` +
        `(blockhash ${fmt(mean(both.map(r => r.hashB)))}), C ${fmt(mean(both.map(r => r.decodeC + r.hashC)))} ` +
        `(blockhash ${fmt(mean(both.map(r => r.hashC)), 2)})`);
    console.log(`  max blockhash ms: B ${fmt(max(both.map(r => r.hashB)))}, C ${fmt(max(both.map(r => r.hashC)), 2)}`);
    const failed = results.filter(r => r.error);
    if (failed.length) {
        console.log(`  ${failed.length} failed: ${failed.map(r => r.file).join(', ')}`);
    }

    if (!showPairs) {
        return;
    }
    const alternate = new Set<string>();
    for (const set of ALTERNATE_SETS) {
        for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) {
            alternate.add(`${Math.min(set[i], set[j])}-${Math.max(set[i], set[j])}`);
        }
    }
    const isGroundTruthFolder = path.basename(path.resolve(dir)) === 'duplicates-test';
    for (const key of ['A', 'B', 'C'] as const) {
        const hashed = both;
        const pairs: { a: string, b: string, d: number, alt: boolean }[] = [];
        for (let i = 0; i < hashed.length; i++) for (let j = i + 1; j < hashed.length; j++) {
            const na = parseInt(hashed[i].file), nb = parseInt(hashed[j].file);
            pairs.push({
                a: hashed[i].file, b: hashed[j].file,
                d: hamming(hashed[i][key], hashed[j][key]),
                alt: alternate.has(`${Math.min(na, nb)}-${Math.max(na, nb)}`),
            });
        }
        pairs.sort((x, y) => x.d - y.d);
        console.log(`\nPipeline ${key}: closest pairs`);
        pairs.filter(p => p.d <= 60).forEach(p => console.log(`  ${p.a.padEnd(20)} ${p.b.padEnd(20)} d=${String(p.d).padStart(3)}${isGroundTruthFolder && p.alt ? '  alternate' : ''}`));
        if (isGroundTruthFolder) {
            const alts = pairs.filter(p => p.alt).map(p => p.d);
            const others = pairs.filter(p => !p.alt).map(p => p.d);
            console.log(`  ground truth: ${alts.length} alternate pairs, ${alts.filter(d => d <= 40).length} within 40, farthest ${max(alts)}; closest other pair ${Math.min(...others)}`);
        } else {
            console.log(`  ${pairs.filter(p => p.d <= 40).length} pairs within 40 of ${pairs.length}`);
        }
    }
})();
