import * as assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp, tagFixtures, tagsQuery } from '../helpers';
import { FIXTURE_TAGS } from '../fixtures/tags';

const sorted = (values: string[]) => [...values].sort();
const ALL_FIXTURE_TAGS = sorted([...new Set(Object.values(FIXTURE_TAGS).flat())]);
/* The percent-encoded path for a tag, as a client would build it. */
const tagPath = (name: string) => `/tags/${encodeURIComponent(name)}`;

/* A fresh, synced app with every fixture tagged. Each describe gets its own, so tests that change tags don't leak. */
const createTaggedApp = async () => {
    const { app, db } = await createTestApp();
    await tagFixtures(app);
    return { app, db };
};

const entryNamed = async (app, name: string) => {
    const res = await request(app).get('/media').expect(200);
    const entry = res.body.find(entry => entry.name === name);
    assert.ok(entry, `${name} is in GET /media`);
    return entry;
};

describe('tags on GET /media', () => {
    let app, db;
    before(async () => { ({ app, db } = await createTaggedApp()); });
    after(async () => { await db.close(); });

    it('returns each entry\'s tags as a sorted array', async () => {
        const res = await request(app).get('/media').expect(200);
        for (const entry of res.body) {
            assert.deepEqual(entry.tags, sorted(FIXTURE_TAGS[entry.name]), entry.name);
        }
    });

    it('returns the same tags from GET /media/:id', async () => {
        const entry = await entryNamed(app, 'image-variant-1.jpg');
        const res = await request(app).get(`/media/${entry.id}`).expect(200);
        assert.deepEqual(res.body.tags, ['elf', 'high-resolution', 'meta:variant', 'sfw']);
    });

    it('returns [] for media with no tags', async () => {
        const { app: untagged, db: untaggedDb } = await createTestApp();
        try {
            const res = await request(untagged).get('/media').expect(200);
            assert.ok(res.body.every(entry => Array.isArray(entry.tags) && entry.tags.length === 0));
        } finally {
            await untaggedDb.close();
        }
    });
});

describe('GET /tags', () => {
    let app, db;
    before(async () => { ({ app, db } = await createTaggedApp()); });
    after(async () => { await db.close(); });

    it('lists every tag, sorted', async () => {
        await request(app).get('/tags').expect(200, ALL_FIXTURE_TAGS);
    });

    it('counts each Media row once, so duplicate files count as one', async () => {
        // scene-a, scene-a-small, checker-b, not-an-image and transparent-corner; scene-a-copy shares scene-a's row
        await request(app).get('/tags/claude').expect(200, { name: 'claude', count: 5 });
    });

    it('finds tags with namespaces, spaces and parentheses', async () => {
        await request(app).get(tagPath('series:genshin impact')).expect(200, { name: 'series:genshin impact', count: 1 });
        await request(app).get(tagPath('mina (deadlock)')).expect(200, { name: 'mina (deadlock)', count: 1 });
        await request(app).get(tagPath('meta:variant')).expect(200, { name: 'meta:variant', count: 3 });
    });

    it('normalizes the name it looks up', async () => {
        await request(app).get(tagPath('  ELF ')).expect(200, { name: 'elf', count: 3 });
    });

    it('answers 404 for a tag that doesn\'t exist', async () => {
        const res = await request(app).get('/tags/no-such-tag').expect(404).expect('Content-Type', /json/);
        assert.match(res.body.error, /no-such-tag/);
    });
});

describe('POST /tags/:tagName', () => {
    let app, db;
    before(async () => { ({ app, db } = await createTaggedApp()); });
    after(async () => { await db.close(); });

    it('creates a tag with no media and answers 201 with a link to it', async () => {
        const res = await request(app).post(tagPath('Brand New')).expect(201).expect('Location', tagPath('brand new'));
        assert.deepEqual(res.body, { name: 'brand new', url: tagPath('brand new') });
        await request(app).get(res.body.url).expect(200, { name: 'brand new', count: 0 });
    });

    it('answers 200 with a link to the existing tag for a duplicate, and adds nothing', async () => {
        const before = (await request(app).get('/tags').expect(200)).body;
        const res = await request(app).post('/tags/ELF').expect(200).expect('Location', '/tags/elf');
        assert.deepEqual(res.body, { name: 'elf', url: '/tags/elf' });
        await request(app).get('/tags').expect(200, before);
        await request(app).get('/tags/elf').expect(200, { name: 'elf', count: 3 });
    });

    it('answers 400 for a name that is only whitespace', async () => {
        await request(app).post(tagPath('   ')).expect(400);
    });
});

describe('PUT /tags/:tagName', () => {
    let app, db;
    beforeEach(async () => { ({ app, db } = await createTaggedApp()); });
    afterEach(async () => { await db.close(); });

    it('renames a tag, keeping its media', async () => {
        const res = await request(app).put('/tags/sfw').send({ name: 'Safe' }).expect(200);
        assert.deepEqual(res.body, { name: 'safe', url: '/tags/safe' });
        await request(app).get('/tags/sfw').expect(404);
        await request(app).get('/tags/safe').expect(200, { name: 'safe', count: 2 });
        assert.deepEqual((await entryNamed(app, 'image-variant-1-resized.jpg')).tags, ['elf', 'meta:variant', 'safe']);
    });

    it('merges into an existing tag, re-linking its media once', async () => {
        // image-variant-2 has both nsfw and elf
        const res = await request(app).put('/tags/nsfw').send({ name: 'elf' }).expect(200);
        assert.deepEqual(res.body, { name: 'elf', url: '/tags/elf' });
        await request(app).get('/tags/nsfw').expect(404);
        await request(app).get('/tags/elf').expect(200, { name: 'elf', count: 3 });
        assert.deepEqual((await entryNamed(app, 'image-variant-2.jpg')).tags, ['elf', 'meta:variant']);
    });

    it('moves media that didn\'t have the target tag over to it', async () => {
        await request(app).put('/tags/potionomics').send({ name: 'claude' }).expect(200);
        await request(app).get('/tags/claude').expect(200, { name: 'claude', count: 6 });
        assert.deepEqual((await entryNamed(app, 'Roxanne.webp')).tags, ['claude', 'roxanne']);
    });

    it('changes nothing when the new name normalizes to the same one', async () => {
        await request(app).put('/tags/elf').send({ name: ' ELF ' }).expect(200, { name: 'elf', url: '/tags/elf' });
        await request(app).get('/tags/elf').expect(200, { name: 'elf', count: 3 });
    });

    it('answers 404 for a tag that doesn\'t exist', async () => {
        await request(app).put('/tags/no-such-tag').send({ name: 'anything' }).expect(404);
        await request(app).get('/tags/anything').expect(404);
    });

    for (const [label, body] of [['no body', undefined], ['no name', {}], ['a non-string name', { name: 5 }], ['an empty name', { name: '  ' }]]) {
        it(`answers 400 for ${label}`, async () => {
            const res = await request(app).put('/tags/elf').send(body).expect(400).expect('Content-Type', /json/);
            assert.ok(res.body.error);
            await request(app).get('/tags/elf').expect(200);
        });
    }
});

describe('DELETE /tags/:tagName', () => {
    let app, db;
    before(async () => { ({ app, db } = await createTaggedApp()); });
    after(async () => { await db.close(); });

    it('deletes the tag and unlinks its media', async () => {
        await request(app).delete('/tags/broken').expect(204);
        await request(app).get('/tags/broken').expect(404);
        assert.deepEqual((await entryNamed(app, 'not-an-image.png')).tags, ['claude']);
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM Media_Tags WHERE tagID NOT IN (SELECT id FROM Tags)')).n, 0);
    });

    it('answers 404 for a tag that doesn\'t exist', async () => {
        await request(app).delete('/tags/broken').expect(404);
    });
});

describe('PUT /media/:id', () => {
    let app, db;
    beforeEach(async () => { ({ app, db } = await createTaggedApp()); });
    afterEach(async () => { await db.close(); });

    const put = (id: number | string, query: string) => request(app).put(`/media/${id}?${query}`);

    it('replaces the tags, creating new ones, and answers like GET /media/:id', async () => {
        const entry = await entryNamed(app, 'image-variant-1.jpg');
        const res = await put(entry.id, tagsQuery(['elf', 'sfw', 'pointy ears'])).expect(200);
        assert.deepEqual(res.body, (await request(app).get(`/media/${entry.id}`).expect(200)).body);
        assert.deepEqual(res.body.tags, ['elf', 'pointy ears', 'sfw']);
        await request(app).get(tagPath('pointy ears')).expect(200, { name: 'pointy ears', count: 1 });
        // removing the link leaves the tag itself, still used by other media
        await request(app).get('/tags/high-resolution').expect(200, { name: 'high-resolution', count: 0 });
        await request(app).get(tagPath('meta:variant')).expect(200, { name: 'meta:variant', count: 2 });
    });

    it('removes every tag for []', async () => {
        const entry = await entryNamed(app, 'Roxanne.webp');
        const res = await put(entry.id, tagsQuery([])).expect(200);
        assert.deepEqual(res.body.tags, []);
    });

    it('normalizes and de-duplicates the tags', async () => {
        const entry = await entryNamed(app, 'checker-b.jpg');
        const res = await put(entry.id, tagsQuery(['Elf', 'elf ', '  Two   Words '])).expect(200);
        assert.deepEqual(res.body.tags, ['elf', 'two words']);
    });

    it('accepts the encoding from the Hydrus docs, including escaped unicode', async () => {
        const entry = await entryNamed(app, 'checker-b.jpg');
        // ["character:space bounty hunter", "creator:青い桜"], JSON-encoded with \u escapes, then URL-encoded
        const query = 'tags=%5B%22character%3Aspace%20bounty%20hunter%22%2C%20%22creator%3A%5Cu9752%5Cu3044%5Cu685c%22%5D';
        const res = await put(entry.id, query).expect(200);
        assert.deepEqual(res.body.tags, ['character:space bounty hunter', 'creator:青い桜']);
    });

    it('tags unmounted media', async () => {
        const { lastID } = await db.run(`INSERT INTO Media (type, isMounted, imageHash, sourceID) VALUES ('Local', 0, 'sha256:gone', NULL)`);
        const res = await put(lastID, tagsQuery(['kept'])).expect(200);
        assert.deepEqual([res.body.isMounted, res.body.tags], [false, ['kept']]);
    });

    for (const [label, query] of [
        ['no tags parameter', 'other=1'],
        ['tags that aren\'t JSON', 'tags=notjson'],
        ['a JSON object', `tags=${encodeURIComponent('{"a":1}')}`],
        ['a JSON string', `tags=${encodeURIComponent('"elf"')}`],
        ['a non-string in the array', `tags=${encodeURIComponent('["elf",1]')}`],
        ['an empty tag', tagsQuery(['elf', '   '])],
        ['tags[]=', 'tags[]=elf'],
        ['tags given twice', 'tags=%5B%5D&tags=%5B%5D'],
    ]) {
        it(`answers 400 for ${label}, and changes nothing`, async () => {
            const entry = await entryNamed(app, 'Roxanne.webp');
            const res = await put(entry.id, query).expect(400).expect('Content-Type', /json/);
            assert.ok(res.body.error);
            assert.deepEqual((await entryNamed(app, 'Roxanne.webp')).tags, ['potionomics', 'roxanne']);
        });
    }

    it('answers 404 for media that doesn\'t exist, and creates no tags', async () => {
        const res = await put(9999, tagsQuery(['orphan-tag'])).expect(404);
        assert.match(res.body.error, /9999/);
        await request(app).get('/tags/orphan-tag').expect(404);
    });

    it('answers 400 for an invalid id', async () => {
        await put('abc', tagsQuery(['elf'])).expect(400);
    });
});

describe('/tags while the database is starting', () => {
    it('answers 503', async () => {
        const { app, db } = await createTestApp({ directories: [], ready: new Promise(() => {}) });
        try {
            await request(app).get('/tags').expect(503);
        } finally {
            await db.close();
        }
    });
});
