// `.jz` v1 producer/verifier tests. Fixtures live in `jz-fixtures.js` so the
// hardening matrix (signature, CRC, revocation, media, Markdown) can reuse the
// same hand-built packages.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { JZ_ENTRY, JZ_LIMITS } from '../src/jz.js';
import { readZip, writeZip } from '../src/jz-zip.js';
import { readPackage, readPayloadIdentity } from '../src/jz-package.js';
import { validateDescription, validateIcon } from '../src/jz-media.js';
import {
  expectCode,
  keys,
  makeKeyPair,
  mutateManifest,
  nshPayload,
  pack,
  png,
  project,
  tempDir,
  verify,
  withEntry,
  writeCertificate,
} from './jz-fixtures.js';

// ------------------------------------------------------------------- tests

test('a packed package is deterministic in layout and verifies', () => {
  const { result, bytes, key } = pack();
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.deepEqual(readZip(bytes).map((entry) => entry.name), [
    JZ_ENTRY.icon,
    JZ_ENTRY.description,
    JZ_ENTRY.manifest,
    JZ_ENTRY.payload,
    JZ_ENTRY.signature,
  ]);
  const verified = verify(bytes, key);
  assert.equal(verified.manifest.app.id, 'com.jiezi.miniapp.demo');
  assert.equal(verified.manifest.app.build, 1);
  assert.equal(verified.manifest.presentation.summary, 'A demo mini app.');
  assert.equal(verified.manifest.runtime.minRuntime, '0.6.0');
  assert.equal(verified.manifest.presentation.icon, JZ_ENTRY.icon);
  assert.equal(verified.manifest.capabilities.purposes.clipboard, 'Read the clipboard only when you tap copy.');
  assert.equal(verified.trust, 'production');
  assert.equal(verified.packageSha256, result.packageSha256);
  assert.equal(verified.payloadSha256, result.payloadSha256);
  assert.equal(verified.manifestSha256, result.manifestSha256);
  assert.equal(verified.description, '# Demo\n\nHello.\n');
  assert.equal(readPayloadIdentity(verified.payload).build, 1);
});

test('a package without an icon falls back and omits the entry', () => {
  const { bytes, key } = pack({ fixture: project({ withIcon: false }) });
  assert.equal(readZip(bytes).some((entry) => entry.name === JZ_ENTRY.icon), false);
  const verified = verify(bytes, key);
  assert.equal(verified.manifest.presentation.icon, undefined);
  assert.equal(verified.icon, null);
});

test('writing the same entries twice produces identical bytes', () => {
  const entries = [
    { name: 'b.txt', data: Buffer.from('b') },
    { name: 'a.txt', data: Buffer.from('a') },
  ];
  assert.deepEqual(writeZip(entries), writeZip(entries.slice().reverse()));
});

test('the payload identity is read from the NSHP header', () => {
  assert.deepEqual(
    readPayloadIdentity(nshPayload({ id: 'com.x.y', build: 7 })),
    { id: 'com.x.y', name: 'Demo', version: '1.0.0', build: 7 },
  );
});

// ------------------------------------------------------- tampering refusals

test('tampered manifest bytes fail the outer signature', () => {
  const { bytes, key } = pack();
  const tampered = withEntry(bytes, JZ_ENTRY.manifest, (data) => (
    Buffer.from(data.toString('utf8').replace('A demo mini app.', 'Evil app.'))
  ));
  assert.throws(() => verify(tampered, key), expectCode('JZ_BAD_SIGNATURE'));
});

test('tampered payload bytes fail the manifest hash', () => {
  const { bytes, key } = pack();
  const tampered = withEntry(bytes, JZ_ENTRY.payload, (data) => {
    const copy = Buffer.from(data);
    copy[copy.length - 1] ^= 0xff;
    return copy;
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_HASH_MISMATCH'));
});

test('tampered icon bytes fail the manifest hash', () => {
  const { bytes, key } = pack();
  const tampered = withEntry(bytes, JZ_ENTRY.icon, (data) => {
    const copy = Buffer.from(data);
    copy[copy.length - 30] ^= 0x01;
    return copy;
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_HASH_MISMATCH'));
});

test('an untrusted root is refused', () => {
  const { bytes } = pack();
  assert.throws(
    () => verify(bytes, { root: makeKeyPair() }),
    expectCode('JZ_UNTRUSTED'),
  );
});

test('a certificate outside its validity window is refused when signing', () => {
  const key = keys();
  const past = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  writeCertificate(key.dir, key.root, key.release.pub, {
    notBefore: Math.floor(past.getTime() / 1000) - 60,
    notAfter: Math.floor(past.getTime() / 1000) + 60,
  });
  assert.throws(
    () => pack({ key, createdAt: new Date() }),
    expectCode('JZ_UNTRUSTED'),
  );
});

test('a certificate that does not cover the app id is refused', () => {
  const key = keys();
  writeCertificate(key.dir, key.root, key.release.pub, {
    notBefore: Math.floor(Date.now() / 1000) - 3600,
    notAfter: Math.floor(Date.now() / 1000) + 3600,
    apps: ['com.other.*'],
  });
  assert.throws(() => pack({ key }), expectCode('JZ_UNTRUSTED'));
});

test('an unknown critical field is refused', () => {
  const { bytes, key } = pack();
  const tampered = mutateManifest(bytes, (manifest) => {
    manifest.critical = ['presentation.rating'];
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_CRITICAL_FIELD'));
});

test('an unsupported format version is refused', () => {
  const { bytes, key } = pack();
  const tampered = mutateManifest(bytes, (manifest) => {
    manifest.formatVersion = 2;
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_UNSUPPORTED_FORMAT'));
});

test('a signature envelope with an unknown field is refused', () => {
  const { bytes, key } = pack();
  const tampered = withEntry(bytes, JZ_ENTRY.signature, (data) => {
    const envelope = JSON.parse(data.toString('utf8'));
    envelope.extra = 'nope';
    return Buffer.from(JSON.stringify(envelope));
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_BAD_SIGNATURE'));
});

test('a package carrying an undeclared icon entry is refused', () => {
  const { bytes, key } = pack({ fixture: project({ withIcon: false }) });
  const entries = readZip(bytes).map((entry) => ({ name: entry.name, data: entry.data }));
  entries.push({ name: JZ_ENTRY.icon, data: png() });
  assert.throws(() => verify(writeZip(entries), key), expectCode('JZ_UNKNOWN_ENTRY'));
});

// --------------------------------------------------------- purpose refusals

test('a sensitive capability without a purpose is refused at build', () => {
  const fixture = project({ capabilities: { clipboard: true }, purposes: {} });
  assert.throws(() => pack({ fixture }), expectCode('JZ_MISSING_PURPOSE'));
});

test('a purpose naming an undeclared capability is refused', () => {
  const fixture = project({ capabilities: {}, purposes: { camera: 'Take pictures.' } });
  assert.throws(() => pack({ fixture }), expectCode('JZ_UNKNOWN_PURPOSE'));
});

test('an empty summary is refused', () => {
  const fixture = project({ summary: '   ' });
  assert.throws(() => pack({ fixture }), expectCode('JZ_BAD_MANIFEST'));
});

test('a payload whose identity differs from nsh.json is refused at build', () => {
  const fixture = project();
  writeFileSync(fixture.payloadPath, nshPayload({ build: 9 }));
  assert.throws(() => pack({ fixture }), expectCode('JZ_PAYLOAD_MISMATCH'));
});

// ------------------------------------------------------------- media rules

test('the icon rules reject wrong sizes, bit depth and trailing bytes', () => {
  assert.doesNotThrow(() => validateIcon(png()));
  assert.doesNotThrow(() => validateIcon(png({ colorType: 6 })));
  assert.throws(() => validateIcon(png({ width: 512, height: 512 })), expectCode('JZ_BAD_ICON'));
  assert.throws(() => validateIcon(png({ bitDepth: 16 })), expectCode('JZ_BAD_ICON'));
  assert.throws(() => validateIcon(Buffer.concat([png(), Buffer.from([0])])), expectCode('JZ_BAD_ICON'));
  const corrupt = Buffer.from(png());
  corrupt[40] ^= 0xff;
  assert.throws(() => validateIcon(corrupt), expectCode('JZ_BAD_ICON'));
});

test('the description rules allow the v1 subset and reject active content', () => {
  assert.doesNotThrow(() => validateDescription(Buffer.from(
    '# Title\n\n- a\n- b\n\n`code`\n\n[site](https://example.com)\n',
  )));
  for (const bad of [
    'Hello <script>x</script>\n',
    '![img](https://example.com/a.png)\n',
    '[x](http://example.com)\n',
    '[x](data:text/html,hi)\n',
    'a\r\nb\r\n',
    '<https://auto.link>\n',
  ]) {
    assert.throws(() => validateDescription(Buffer.from(bad)), expectCode('JZ_BAD_DESCRIPTION'), bad);
  }
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# hi\n')]);
  assert.throws(() => validateDescription(bom), expectCode('JZ_BAD_DESCRIPTION'));
});

// ------------------------------------------------------------- archive rules

test('the archive reader refuses traversal, duplicates and unknown entries', () => {
  const { bytes } = pack();
  const entries = readZip(bytes).map((entry) => ({ name: entry.name, data: entry.data }));

  const traversal = entries.map((entry) => (
    entry.name === JZ_ENTRY.description ? { name: '../about.md', data: entry.data } : entry
  ));
  assert.throws(() => readZip(writeZip(traversal)), expectCode('JZ_UNKNOWN_ENTRY'));

  const absolute = entries.map((entry) => (
    entry.name === JZ_ENTRY.description ? { name: '/about.md', data: entry.data } : entry
  ));
  assert.throws(() => readZip(writeZip(absolute)), expectCode('JZ_UNKNOWN_ENTRY'));

  const backslash = entries.map((entry) => (
    entry.name === JZ_ENTRY.description ? { name: 'docs\\about.md', data: entry.data } : entry
  ));
  assert.throws(() => readZip(writeZip(backslash)), expectCode('JZ_UNKNOWN_ENTRY'));

  assert.throws(() => readZip(writeZip([...entries, { name: 'notes.txt', data: Buffer.from('x') }])), expectCode('JZ_UNKNOWN_ENTRY'));
  assert.throws(
    () => readZip(writeZip([...entries, { name: JZ_ENTRY.description, data: Buffer.from('x') }])),
    expectCode('JZ_UNKNOWN_ENTRY'),
  );
  assert.throws(
    () => readZip(writeZip([...entries, { name: JZ_ENTRY.icon.toUpperCase(), data: png() }])),
    expectCode('JZ_UNKNOWN_ENTRY'),
  );
});

test('the archive reader refuses trailing bytes, encryption and ZIP64 markers', () => {
  const { bytes } = pack();
  assert.throws(() => readZip(Buffer.concat([bytes, Buffer.from([0])])), expectCode('JZ_BAD_ARCHIVE'));

  const encrypted = Buffer.from(bytes);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 0x1, 6);
  assert.throws(() => readZip(encrypted), expectCode('JZ_BAD_ARCHIVE'));

  const zip64 = Buffer.from(bytes);
  const eocd = zip64.length - 22;
  zip64.writeUInt16LE(0xffff, eocd + 8);
  zip64.writeUInt16LE(0xffff, eocd + 10);
  assert.throws(() => readZip(zip64), expectCode('JZ_BAD_ARCHIVE'));

  const comment = Buffer.from(bytes);
  const eocdOffset = comment.length - 22;
  comment.writeUInt16LE(1, eocdOffset + 20);
  assert.throws(() => readZip(comment), expectCode('JZ_BAD_ARCHIVE'));
});

test('the archive reader enforces per-entry bounds', () => {
  const tooBig = writeZip([{ name: JZ_ENTRY.description, data: Buffer.alloc(JZ_LIMITS.description + 1) }]);
  assert.throws(() => readZip(tooBig), expectCode('JZ_LIMIT_EXCEEDED'));
});

// ----------------------------------------------------------- route policy

test('a development-root package is refused for file import and accepted paired', () => {
  const { bytes, key } = pack();
  const developmentRoots = [key.root.pub.toString('base64')];
  const productionRoots = [makeKeyPair().pub.toString('base64')];
  // A development signer that is also listed as a production root is a
  // production package; the route cannot downgrade it.
  assert.equal(
    readPackage(bytes, { roots: developmentRoots, route: 'user-file-import' }).trust,
    'production',
  );
  // A production root does not vouch for a package only the development root
  // signed: file import must say so explicitly rather than install it.
  assert.throws(
    () => readPackage(bytes, { roots: productionRoots, developmentRoots, route: 'user-file-import' }),
    expectCode('JZ_DEVELOPMENT_IMPORT'),
  );
  // The same bytes through the paired developer route verify as development.
  assert.equal(
    readPackage(bytes, { roots: productionRoots, developmentRoots, route: 'paired-developer' }).trust,
    'development',
  );
  // With no development root configured at all, the same bytes are simply
  // untrusted rather than misreported as a development package.
  assert.throws(
    () => readPackage(bytes, { roots: productionRoots, route: 'user-file-import' }),
    expectCode('JZ_UNTRUSTED'),
  );
});

test('a production root is accepted on both routes', () => {
  const { bytes, key } = pack();
  const root = key.root.pub.toString('base64');
  assert.equal(readPackage(bytes, { roots: [root], route: 'user-file-import' }).trust, 'production');
  assert.equal(readPackage(bytes, { roots: [root], route: 'paired-developer' }).trust, 'production');
});


test('an existing project without presentation files gets valid defaults', async () => {
  const { ensurePresentationMetadata } = await import('../src/build.js');
  const dir = tempDir('jz-existing-');
  writeFileSync(join(dir, 'nsh.json'), JSON.stringify({
    name: 'Legacy App', id: 'com.jiezi.miniapp.legacy', version: '1.0.0', build: 1,
  }));
  const presentation = ensurePresentationMetadata(
    dir,
    { name: 'Legacy App', id: 'com.jiezi.miniapp.legacy' },
    'legacy',
  );
  assert.deepEqual(presentation, { created: ['jiezi.json', 'docs/about.md'], synthesizedPurposes: [] });
  const jiezi = JSON.parse(readFileSync(join(dir, 'jiezi.json'), 'utf8'));
  assert.equal(jiezi.schemaVersion, 1);
  assert.equal(jiezi.summary, 'Legacy App');
  assert.match(readFileSync(join(dir, 'docs', 'about.md'), 'utf8'), /# Legacy App/);

  // A second build never overwrites authored files.
  writeFileSync(join(dir, 'jiezi.json'), JSON.stringify({ schemaVersion: 1, summary: 'Authored' }));
  const again = ensurePresentationMetadata(dir, { name: 'Legacy App' }, 'legacy');
  assert.deepEqual(again, { created: [], synthesizedPurposes: [] });
  assert.equal(JSON.parse(readFileSync(join(dir, 'jiezi.json'), 'utf8')).summary, 'Authored');
});

test('the legacy migration synthesizes a purpose only for a declared sensitive capability', async () => {
  const { ensurePresentationMetadata } = await import('../src/build.js');
  const dir = tempDir('jz-migrate-');
  writeFileSync(join(dir, 'nsh.json'), JSON.stringify({
    name: 'Migrated',
    id: 'com.jiezi.miniapp.migrated',
    version: '1.0.0',
    build: 1,
    capabilities: { host: true, clipboard: true, camera: true },
  }));
  const presentation = ensurePresentationMetadata(
    dir,
    { name: 'Migrated', id: 'com.jiezi.miniapp.migrated', capabilities: { host: true, clipboard: true, camera: true } },
    'migrated',
  );
  // `host` and `camera` are declarations, but only `clipboard` is sensitive in
  // NSH 0.6.0 (D1), so only it gets synthesized purpose text.
  assert.deepEqual(presentation.synthesizedPurposes, ['clipboard']);
  const jiezi = JSON.parse(readFileSync(join(dir, 'jiezi.json'), 'utf8'));
  assert.deepEqual(Object.keys(jiezi.capabilityPurposes), ['clipboard']);
  assert.match(jiezi.capabilityPurposes.clipboard, /clipboard/);
});


test('the migration keeps a legacy project with a sensitive declaration buildable', async () => {
  const { ensurePresentationMetadata } = await import('../src/build.js');
  const fixture = project({ capabilities: { clipboard: true } });
  rmSync(join(fixture.dir, 'jiezi.json'));
  rmSync(join(fixture.dir, 'docs'), { recursive: true });
  const presentation = ensurePresentationMetadata(
    fixture.dir,
    { name: 'Demo', id: 'com.jiezi.miniapp.demo', capabilities: { clipboard: true } },
    'demo',
  );
  assert.deepEqual(presentation.created, ['jiezi.json', 'docs/about.md']);
  assert.deepEqual(presentation.synthesizedPurposes, ['clipboard']);
  const { result } = pack({ fixture });
  const jiezi = JSON.parse(readFileSync(join(fixture.dir, 'jiezi.json'), 'utf8'));
  assert.deepEqual(Object.keys(jiezi.capabilityPurposes), ['clipboard']);
  assert.equal(result.capabilities.clipboard, true);
});

test('an authored jiezi.json missing a required purpose is a build error', async () => {
  const { ensurePresentationMetadata } = await import('../src/build.js');
  // The fixture writes an authored jiezi.json, so the migration must not
  // synthesize anything and the build must refuse the missing purpose.
  const fixture = project({ capabilities: { clipboard: true }, purposes: {} });
  const presentation = ensurePresentationMetadata(
    fixture.dir,
    { name: 'Demo', id: 'com.jiezi.miniapp.demo', capabilities: { clipboard: true } },
    'demo',
  );
  assert.deepEqual(presentation.synthesizedPurposes, []);
  assert.throws(() => pack({ fixture }), expectCode('JZ_MISSING_PURPOSE'));
});
