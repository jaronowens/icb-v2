import * as assert from 'node:assert/strict';
import { parseTagQuery, parseMediaSearch } from '../../util/queryParams';

const HEX = 'ab'.repeat(32);

const is400 = (err: any) => {
    assert.equal(err.status, 400);
    return true;
};

describe('parseTagQuery', () => {
    it('turns a bare string into a group of one', () => {
        assert.deepEqual(parseTagQuery('["elf"]'), [[{ name: 'elf', negated: false }]]);
    });

    it('keeps the AND of items and the OR inside groups', () => {
        assert.deepEqual(parseTagQuery('["a",["b","-c"]]'), [
            [{ name: 'a', negated: false }],
            [{ name: 'b', negated: false }, { name: 'c', negated: true }],
        ]);
    });

    it('negates inside an OR group', () => {
        assert.deepEqual(parseTagQuery('[["sfw","-elf"]]'), [[
            { name: 'sfw', negated: false }, { name: 'elf', negated: true },
        ]]);
    });

    it('trims, normalizes and lowercases terms', () => {
        assert.deepEqual(parseTagQuery('["  - Series:  Helltaker "]'), [[{ name: 'series: helltaker', negated: true }]]);
    });

    it('returns an empty query for []', () => {
        assert.deepEqual(parseTagQuery('[]'), []);
    });

    it('accepts exactly 100 terms', () => {
        const terms = Array.from({ length: 100 }, (_, i) => `t${i}`);
        assert.equal(parseTagQuery(JSON.stringify(terms)).length, 100);
    });

    const malformed: [string, unknown][] = [
        ['not a string', ['a']],
        ['invalid JSON', 'not json'],
        ['an object', '{"a":1}'],
        ['a string at the top level', '"a"'],
        ['a number item', '[1]'],
        ['a null item', '[null]'],
        ['an empty group', '[[]]'],
        ['a nested array in a group', '[["a",["b"]]]'],
        ['a non-string in a group', '[["a",1]]'],
        ['a lone dash', '["-"]'],
        ['a dash and a space', '["- "]'],
        ['an empty string', '[""]'],
        ['a double dash', '["--x"]'],
        ['a double dash in a group', '[["a","--x"]]'],
        ['101 terms', JSON.stringify(Array.from({ length: 101 }, (_, i) => `t${i}`))],
        ['101 terms across groups', JSON.stringify([Array.from({ length: 60 }, (_, i) => `a${i}`), Array.from({ length: 41 }, (_, i) => `b${i}`)])],
    ];
    for (const [label, raw] of malformed) {
        it(`400s on ${label}`, () => {
            assert.throws(() => parseTagQuery(raw), is400);
        });
    }
});

describe('parseMediaSearch', () => {
    it('returns an empty search for no parameters', () => {
        assert.deepEqual(parseMediaSearch({}), {});
    });

    it('omits tags for []', () => {
        assert.deepEqual(parseMediaSearch({ tags: '[]' }), {});
    });

    it('parses every parameter together', () => {
        assert.deepEqual(
            parseMediaSearch({ name: 'roxa', extension: 'png', is_video: 'false', hash: HEX, tags: '["elf"]', count: '5' }),
            {
                name: 'roxa',
                extensions: ['png'],
                isVideo: false,
                hash: `sha256:${HEX}`,
                tags: [[{ name: 'elf', negated: false }]],
                count: 5,
            }
        );
    });

    describe('unknown and malformed parameters', () => {
        it('400s on an unknown parameter, naming it', () => {
            assert.throws(() => parseMediaSearch({ extention: 'jpg' }), (err: any) => {
                assert.equal(err.status, 400);
                assert.match(err.message, /extention/);
                return true;
            });
        });

        const shapes: [string, Record<string, unknown>][] = [
            ['a repeated parameter', { extension: ['jpg', 'png'] }],
            ['the array form', { name: ['x'] }],
            ['the object form', { name: { a: 'x' } }],
            ['an empty string', { name: '' }],
            ['an empty tags string', { tags: '' }],
        ];
        for (const [label, query] of shapes) {
            it(`400s on ${label}`, () => {
                assert.throws(() => parseMediaSearch(query), is400);
            });
        }
    });

    describe('name', () => {
        it('passes the string through unchanged', () => {
            assert.deepEqual(parseMediaSearch({ name: 'Rox_%a' }), { name: 'Rox_%a' });
        });
    });

    describe('extension', () => {
        it('lowercases', () => {
            assert.deepEqual(parseMediaSearch({ extension: 'PNG' }), { extensions: ['png'] });
        });
        it('expands jpg to both names', () => {
            assert.deepEqual(parseMediaSearch({ extension: 'jpg' }), { extensions: ['jpg', 'jpeg'] });
        });
        it('expands jpeg to both names', () => {
            assert.deepEqual(parseMediaSearch({ extension: 'JPEG' }), { extensions: ['jpg', 'jpeg'] });
        });
        it('expands png to just png', () => {
            assert.deepEqual(parseMediaSearch({ extension: 'png' }), { extensions: ['png'] });
        });
        for (const bad of ['bmp', 'txt', '.png']) {
            it(`400s on ${bad}`, () => {
                assert.throws(() => parseMediaSearch({ extension: bad }), is400);
            });
        }
    });

    describe('is_video', () => {
        it('accepts true and false', () => {
            assert.deepEqual(parseMediaSearch({ is_video: 'true' }), { isVideo: true });
            assert.deepEqual(parseMediaSearch({ is_video: 'false' }), { isVideo: false });
        });
        for (const bad of ['yes', '1', 'TRUE', 'True']) {
            it(`400s on ${bad}`, () => {
                assert.throws(() => parseMediaSearch({ is_video: bad }), is400);
            });
        }
    });

    describe('hash', () => {
        it('normalizes a prefixed hash', () => {
            assert.deepEqual(parseMediaSearch({ hash: `sha256:${HEX}` }), { hash: `sha256:${HEX}` });
        });
        it('adds the prefix to a bare hash', () => {
            assert.deepEqual(parseMediaSearch({ hash: HEX }), { hash: `sha256:${HEX}` });
        });
        it('lowercases an uppercase hash', () => {
            assert.deepEqual(parseMediaSearch({ hash: HEX.toUpperCase() }), { hash: `sha256:${HEX}` });
            assert.deepEqual(parseMediaSearch({ hash: `SHA256:${HEX.toUpperCase()}` }), { hash: `sha256:${HEX}` });
        });
        const bad: [string, string][] = [
            ['not hex', 'nothex'],
            ['too short', 'ab'.repeat(31)],
            ['too long', 'ab'.repeat(33)],
            ['non-hex characters', 'zz'.repeat(32)],
            ['another prefix', `phash16:${HEX}`],
            ['an empty digest', 'sha256:'],
        ];
        for (const [label, hash] of bad) {
            it(`400s on ${label}`, () => {
                assert.throws(() => parseMediaSearch({ hash }), is400);
            });
        }
    });

    describe('tags', () => {
        it('parses the tag query', () => {
            assert.deepEqual(parseMediaSearch({ tags: '["a",["b","-c"]]' }).tags?.length, 2);
        });
        it('400s on malformed tags', () => {
            assert.throws(() => parseMediaSearch({ tags: 'not json' }), is400);
            assert.throws(() => parseMediaSearch({ tags: '["--x"]' }), is400);
        });
    });

    describe('count', () => {
        it('accepts positive integers', () => {
            assert.deepEqual(parseMediaSearch({ count: '1' }), { count: 1 });
            assert.deepEqual(parseMediaSearch({ count: '250' }), { count: 250 });
            assert.deepEqual(parseMediaSearch({ count: String(Number.MAX_SAFE_INTEGER) }), { count: Number.MAX_SAFE_INTEGER });
        });
        for (const bad of ['0', '-1', '1.5', '1e3', 'abc', '01', '+1', ' 1', String(Number.MAX_SAFE_INTEGER) + '0', '9007199254740992']) {
            it(`400s on ${JSON.stringify(bad)}`, () => {
                assert.throws(() => parseMediaSearch({ count: bad }), (err: any) => {
                    assert.equal(err.status, 400);
                    assert.match(err.message, /count/);
                    return true;
                });
            });
        }
    });
});
