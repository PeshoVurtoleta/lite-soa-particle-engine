import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The two codepoints the source law exempts: U+00D7 (multiplication sign) and
// U+00B5 (micro sign). Everything else must be plain ASCII.
const ALLOWED = new Set([0x00d7, 0x00b5]);

/** The exact set of files that reach a consumer: package.json files[] + package.json. */
function shippedFiles() {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const files = Array.isArray(pkg.files) ? pkg.files.slice() : [];
    files.push('package.json');
    return files;
}

/** Return every offending codepoint in `text` as { line, col, code }. */
function scan(text) {
    const bad = [];
    let line = 1;
    let col = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (ch === '\n') { line++; col = 0; continue; }
        col++;
        if (code > 0x7f && !ALLOWED.has(code)) {
            bad.push({ line, col, code });
        }
    }
    return bad;
}

test('every shipped file is ASCII-only (except U+00D7 and U+00B5)', () => {
    for (const rel of shippedFiles()) {
        const text = readFileSync(join(ROOT, rel), 'utf8');
        const bad = scan(text);
        assert.equal(
            bad.length,
            0,
            bad.length === 0
                ? ''
                : rel + ' has non-ASCII bytes: ' +
                  bad.map((b) => 'L' + b.line + ':C' + b.col + ' U+' +
                      b.code.toString(16).toUpperCase().padStart(4, '0')).join(', '),
        );
    }
});
