import * as assert from 'node:assert/strict';
import { previewURL, thumbnailRelativePath, THUMBNAIL_SIZE } from '../../service/thumbnailSettings';

const HEX = 'ab' + 'cd'.repeat(31);
const HASH = `sha256:${HEX}`;
const URL = 'http://localhost:3000/pics/file';

describe('thumbnailRelativePath', () => {
    it('uses the first two hex characters as the folder', () => {
        assert.equal(thumbnailRelativePath(HEX, 900), `ab/${HEX}-900.webp`);
        assert.equal(thumbnailRelativePath('0f' + '1'.repeat(62), 450), `0f/0f${'1'.repeat(62)}-450.webp`);
    });
});

describe('previewURL', () => {
    for (const extension of ['jpg', 'jpeg', 'png', 'webp']) {
        it(`gives the thumbnail form for ${extension}`, () => {
            assert.equal(
                previewURL(`${URL}.${extension}`, HASH, extension),
                `http://localhost:3000/thumbnails/ab/${HEX}-${THUMBNAIL_SIZE}.webp`
            );
        });
    }

    for (const extension of ['gif', 'mp4', 'webm']) {
        it(`gives imageURL for ${extension}`, () => {
            assert.equal(previewURL(`${URL}.${extension}`, HASH, extension), `${URL}.${extension}`);
        });
    }

    it('gives imageURL for a hash that is not sha256', () => {
        assert.equal(previewURL(`${URL}.png`, `phash16:${'0f'.repeat(32)}`, 'png'), `${URL}.png`);
        assert.equal(previewURL(`${URL}.png`, '', 'png'), `${URL}.png`);
        assert.equal(previewURL(`${URL}.png`, null, 'png'), `${URL}.png`);
    });

    it('gives null for unmounted media', () => {
        assert.equal(previewURL(null, HASH, 'png'), null);
        assert.equal(previewURL(null, null, null), null);
    });
});
