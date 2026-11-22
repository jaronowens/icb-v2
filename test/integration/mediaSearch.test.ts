import * as assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp, tagFixtures } from '../helpers';
import { FIXTURE_TAGS } from '../fixtures/tags';

const enc = (value: unknown): string => encodeURIComponent(JSON.stringify(value));

describe('GET /media search', () => {
    let app, db, all: any[];
    before(async () => {
        ({ app, db } = await createTestApp());
        await tagFixtures(app);
        all = (await request(app).get('/media').expect(200)).body;
    });
    after(async () => { await db.close(); });

    const search = async (qs: string): Promise<any[]> => (await request(app).get(`/media?${qs}`).expect(200)).body;
    const names = (entries: any[]): string[] => entries.map(entry => entry.name);
    const ids = (entries: any[]): number[] => entries.map(entry => entry.id);
    /* ids from the unfiltered list that satisfy a predicate, in the same (id) order. */
    const expected = (predicate: (entry: any) => boolean): number[] => ids(all.filter(predicate));
    const hasTag = (entry: any, tag: string): boolean => entry.tags.includes(tag);
    const namesOf = (idList: number[]): string[] => names(all.filter(entry => idList.includes(entry.id))).sort();

    it('sanity: the fixtures are tagged as in FIXTURE_TAGS', () => {
        for (const entry of all) {
            assert.deepEqual([...entry.tags].sort(), [...FIXTURE_TAGS[entry.name]].sort(), entry.name);
        }
    });

    it('with no parameters returns every mounted node, ordered by id', async () => {
        const body = await search('');
        assert.deepEqual(body, all);
        assert.deepEqual(ids(body), [...ids(body)].sort((a, b) => a - b));
    });

    describe('extension', () => {
        it('returns only png entries, case-insensitively', async () => {
            const want = expected(entry => entry.extension === 'png');
            assert.ok(want.length > 0);
            assert.deepEqual(ids(await search('extension=png')), want);
            assert.deepEqual(ids(await search('extension=PNG')), want);
        });

        it('rejects unsupported extensions', async () => {
            await request(app).get('/media?extension=bmp').expect(400);
            await request(app).get('/media?extension=txt').expect(400);
        });

        it('treats jpg and jpeg as the same, matching both spellings', async () => {
            const want = expected(entry => entry.extension === 'jpg' || entry.extension === 'jpeg');
            const jpg = await search('extension=jpg');
            const jpeg = await search('extension=jpeg');
            assert.deepEqual(ids(jpg), want);
            assert.deepEqual(jpg, jpeg);
            assert.ok(jpg.some(entry => entry.extension === 'jpg'));
            assert.ok(jpg.some(entry => entry.extension === 'jpeg'));
            assert.ok(names(jpg).includes('gradient-c.jpeg'));
            assert.ok(names(jpg).includes('checker-b.jpg'));
            assert.deepEqual(ids(await search('extension=JPEG')), want);
        });
    });

    describe('count', () => {
        it('returns the first n ids of the unfiltered list', async () => {
            assert.deepEqual(ids(await search('count=2')), ids(all).slice(0, 2));
        });

        it('applies after the filters', async () => {
            const elves = expected(entry => hasTag(entry, 'elf'));
            assert.deepEqual(ids(await search(`count=2&tags=${enc(['elf'])}`)), elves.slice(0, 2));
        });

        it('returns everything when count is larger than the result set', async () => {
            assert.deepEqual(await search('count=9999'), all);
        });

        it('rejects invalid counts', async () => {
            for (const bad of ['0', '-1', '1.5', '1e3', 'abc', '', '99999999999999999999']) {
                await request(app).get(`/media?count=${bad}`).expect(400);
            }
        });
    });

    describe('is_video', () => {
        it('true returns only the mp4', async () => {
            assert.deepEqual(names(await search('is_video=true')), ['RsniFBN.mp4']);
        });

        it('false returns everything else', async () => {
            const body = await search('is_video=false');
            assert.deepEqual(ids(body), expected(entry => !entry.is_video));
            assert.ok(!names(body).includes('RsniFBN.mp4'));
        });

        it('rejects other values', async () => {
            await request(app).get('/media?is_video=yes').expect(400);
        });
    });

    describe('hash', () => {
        let known;
        before(() => { known = all.find(entry => entry.name === 'checker-b.jpg'); });

        it('finds a node by its full hash, with or without the prefix, in any case', async () => {
            const full: string = known.imageHash;
            assert.match(full, /^sha256:[0-9a-f]{64}$/);
            const bare = full.slice('sha256:'.length);
            for (const value of [full, bare, bare.toUpperCase(), `sha256:${bare.toUpperCase()}`]) {
                assert.deepEqual(ids(await search(`hash=${value}`)), [known.id], value);
            }
        });

        it('404s for a well-formed hash nothing has', async () => {
            await request(app).get(`/media?hash=${'0'.repeat(64)}`).expect(404);
            await request(app).get(`/media?hash=sha256:${'0'.repeat(64)}`).expect(404);
        });

        it('404s for a hash that is only on an unmounted row', async () => {
            const hash = 'ab'.repeat(32);
            await db.run(`INSERT INTO Media (type, isMounted, imageHash, sourceID) VALUES ('Local', 0, ?, NULL)`, [`sha256:${hash}`]);
            await request(app).get(`/media?hash=${hash}`).expect(404);
        });

        it('400s for malformed hashes', async () => {
            await request(app).get('/media?hash=nothex').expect(400);
            await request(app).get(`/media?hash=${'a'.repeat(63)}`).expect(400);
            await request(app).get(`/media?hash=md5:${'a'.repeat(64)}`).expect(400);
        });

        it('returns [] when the hash exists but another filter rules it out', async () => {
            await request(app).get(`/media?hash=${known.imageHash}&is_video=true`).expect(200, []);
        });
    });

    describe('name', () => {
        it('matches a case-insensitive substring', async () => {
            assert.deepEqual(names(await search('name=roxa')), ['Roxanne.webp']);
            assert.deepEqual(names(await search('name=ROXA')), ['Roxanne.webp']);
        });

        it('treats % as a literal, not a wildcard', async () => {
            assert.deepEqual(await search('name=%25'), []);
        });

        it('treats _ as a literal, not a wildcard', async () => {
            // expected names come from the data: more than one fixture name has an underscore
            assert.deepEqual(names(await search('name=_')), names(all.filter(entry => entry.name.includes('_'))));
            assert.deepEqual(await search('name=__x'), []);
        });
    });

    describe('tags', () => {
        const byTags = async (tags: unknown) => ids(await search(`tags=${enc(tags)}`));

        it('["elf"] returns the three variants', async () => {
            const got = await byTags(['elf']);
            assert.deepEqual(got, expected(entry => hasTag(entry, 'elf')));
            assert.deepEqual(namesOf(got), ['image-variant-1-resized.jpg', 'image-variant-1.jpg', 'image-variant-2.jpg']);
        });

        it('["elf","-nsfw"] excludes the nsfw variant', async () => {
            const got = await byTags(['elf', '-nsfw']);
            assert.deepEqual(got, expected(entry => hasTag(entry, 'elf') && !hasTag(entry, 'nsfw')));
            assert.deepEqual(namesOf(got), ['image-variant-1-resized.jpg', 'image-variant-1.jpg']);
        });

        it('ANDs a tag with an OR group', async () => {
            const got = await byTags(['animated', ['video', 'series:helltaker']]);
            assert.deepEqual(got, expected(entry => hasTag(entry, 'animated') && (hasTag(entry, 'video') || hasTag(entry, 'series:helltaker'))));
            assert.deepEqual(namesOf(got), ['2148362390_preview_success-small-flip.gif', 'RsniFBN.mp4']);
        });

        it('supports negation inside an OR group', async () => {
            const got = await byTags([['sfw', '-elf']]);
            assert.deepEqual(got, expected(entry => hasTag(entry, 'sfw') || !hasTag(entry, 'elf')));
            assert.ok(!namesOf(got).includes('image-variant-2.jpg'));
            assert.ok(namesOf(got).includes('image-variant-1.jpg'));
        });

        it('["-claude"] returns everything not tagged claude', async () => {
            const got = await byTags(['-claude']);
            assert.deepEqual(got, expected(entry => !hasTag(entry, 'claude')));
            assert.ok(got.length > 0 && got.length < all.length);
        });

        it('a positive term for a missing tag matches nothing', async () => {
            assert.deepEqual(await byTags(['does-not-exist']), []);
        });

        it('a negated term for a missing tag excludes nothing', async () => {
            assert.deepEqual(await byTags(['-does-not-exist']), ids(all));
        });

        it('[] adds no filter', async () => {
            assert.deepEqual(await byTags([]), ids(all));
        });

        it('normalizes tag terms like stored tags', async () => {
            assert.deepEqual(await byTags([' ELF ']), expected(entry => hasTag(entry, 'elf')));
        });

        it('400s for malformed tags', async () => {
            const bad: string[] = [
                'not json', '{"a":1}', '[1]', '[[]]', '[["a",["b"]]]', '["-"]', '["- "]', '["--x"]', '[null]', '"elf"',
                JSON.stringify(Array.from({ length: 101 }, (_, i) => `t${i}`)),
            ];
            for (const value of bad) {
                await request(app).get(`/media?tags=${encodeURIComponent(value)}`).expect(400);
            }
            await request(app).get('/media?tags[]=a').expect(400);
        });

        it('accepts exactly 100 terms', async () => {
            const tags = Array.from({ length: 100 }, (_, i) => `-t${i}`);
            assert.deepEqual(await byTags(tags), ids(all));
        });
    });

    describe('combined and invalid parameters', () => {
        it('requires every filter to match', async () => {
            const got = await search(`tags=${enc(['elf'])}&extension=jpg`);
            assert.deepEqual(ids(got), expected(entry => hasTag(entry, 'elf') && entry.extension === 'jpg'));
            assert.ok(got.length > 0);
            assert.deepEqual(await search(`tags=${enc(['elf'])}&extension=png`), []);
            assert.deepEqual(names(await search(`tags=${enc(['claude'])}&extension=jpeg&name=gradient`)), ['gradient-c.jpeg']);
        });

        it('400s for unknown parameters', async () => {
            await request(app).get('/media?foo=1').expect(400);
            await request(app).get('/media?extention=jpg').expect(400);
        });

        it('400s for repeated or array/object parameters', async () => {
            await request(app).get('/media?extension=png&extension=jpg').expect(400);
            await request(app).get('/media?name[]=x').expect(400);
            await request(app).get('/media?name[a]=x').expect(400);
        });

        it('400s for empty values', async () => {
            await request(app).get('/media?name=').expect(400);
            await request(app).get('/media?extension=').expect(400);
        });
    });
});
