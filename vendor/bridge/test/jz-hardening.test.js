// Exact-code negative matrix for the `.jz` producer/verifier (034 plan A.8).
//
// Every test here must fail when its check is disabled: each one asserts the
// exact `JZ_*` refusal (or the accepted positive) for a check that the review
// could previously remove while the suite stayed green.
import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';

import {
  JZ_ENTRY,
  JZ_LIMITS,
  JZ_SENSITIVE_CAPABILITIES,
} from '../src/jz.js';
import { readZip, writeZip } from '../src/jz-zip.js';
import { declaredCapabilityIDs } from '../src/jz-manifest.js';
import { packPackage, readPackage, verifyPackageFile } from '../src/jz-package.js';
import { validateDescription, validateIcon } from '../src/jz-media.js';
import {
  craftedZip,
  deflate,
  expectCode,
  flipBase64Byte,
  keyId,
  keys,
  makeKeyPair,
  nshPayload,
  pack,
  png,
  pngChunk,
  project,
  resignPackage,
  signedRevocations,
  tempDir,
  verify,
  withEntry,
  writeCertificate,
} from './jz-fixtures.js';

// ------------------------------------------------------ signature / trust

test('a flipped manifest signature is refused with JZ_BAD_SIGNATURE', () => {
  const { bytes, key } = pack();
  const tampered = withEntry(bytes, JZ_ENTRY.signature, (data) => {
    const envelope = JSON.parse(data.toString('utf8'));
    envelope.signature = flipBase64Byte(envelope.signature);
    return Buffer.from(JSON.stringify(envelope));
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_BAD_SIGNATURE'));
});

test('a flipped certificate signature is refused with JZ_UNTRUSTED', () => {
  const { bytes, key } = pack();
  const tampered = withEntry(bytes, JZ_ENTRY.signature, (data) => {
    const envelope = JSON.parse(data.toString('utf8'));
    envelope.certificate.signature = flipBase64Byte(envelope.certificate.signature);
    return Buffer.from(JSON.stringify(envelope));
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_UNTRUSTED'));
});

test('a certificate signed by an unknown root is refused with JZ_UNTRUSTED', () => {
  const { bytes, key } = pack();
  const tampered = withEntry(bytes, JZ_ENTRY.signature, (data) => {
    const envelope = JSON.parse(data.toString('utf8'));
    envelope.certificate.signer = keyId(makeKeyPair().pub);
    return Buffer.from(JSON.stringify(envelope));
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_UNTRUSTED'));
});

test('a flipped envelope context is refused with JZ_BAD_SIGNATURE', () => {
  const { bytes, key } = pack();
  const tampered = withEntry(bytes, JZ_ENTRY.signature, (data) => {
    const envelope = JSON.parse(data.toString('utf8'));
    envelope.context = 'nsh.package.v1';
    return Buffer.from(JSON.stringify(envelope));
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_BAD_SIGNATURE'));
});

test('a certificate whose signing time is outside its window is refused at build', () => {
  const key = keys();
  const now = Math.floor(Date.now() / 1000);
  writeCertificate(key.dir, key.root, key.release.pub, { notBefore: now - 7200, notAfter: now - 3600 });
  assert.throws(
    () => pack({ key, createdAt: new Date(now * 1000) }),
    expectCode('JZ_UNTRUSTED'),
  );
});

test('D4: a package signed inside its certificate window still verifies after notAfter', () => {
  const key = keys();
  const now = Math.floor(Date.now() / 1000);
  // The certificate expired an hour ago; the signing time is inside it.
  writeCertificate(key.dir, key.root, key.release.pub, { notBefore: now - 7200, notAfter: now - 3600 });
  const { bytes } = pack({ key, createdAt: new Date((now - 5400) * 1000) });
  const verified = verify(bytes, key);
  assert.equal(verified.manifest.app.id, 'com.jiezi.miniapp.demo');
  assert.ok(verified.manifest.createdAt.getTime() < Date.now());
});

// ------------------------------------------------------ revocation (D5)

function verifyWithRevocations(bytes, key, revocations) {
  return readPackage(bytes, {
    roots: [key.root.pub.toString('base64')],
    route: 'user-file-import',
    revocations,
  });
}

test('a valid revocation list with no entries leaves the package accepted', () => {
  const { bytes, key } = pack();
  const revocations = signedRevocations(key.root);
  assert.equal(verifyWithRevocations(bytes, key, revocations).manifest.app.build, 1);
  assert.equal(verify(bytes, key, { revocations: null }).trust, 'production');
});

test('a revoked release key is refused with JZ_UNTRUSTED', () => {
  const { bytes, key } = pack();
  const revocations = signedRevocations(key.root, { keys: [keyId(key.release.pub)] });
  assert.throws(() => verifyWithRevocations(bytes, key, revocations), expectCode('JZ_UNTRUSTED'));
});

test('a revoked package digest is refused with JZ_UNTRUSTED', () => {
  const { result, bytes, key } = pack();
  assert.throws(
    () => verifyWithRevocations(bytes, key, signedRevocations(key.root, { packages: [result.packageSha256] })),
    expectCode('JZ_UNTRUSTED'),
  );
});

test('a revocation signed by any configured root applies, including the development root', () => {
  const { bytes, key } = pack();
  const production = [makeKeyPair().pub.toString('base64')];
  const development = [key.root.pub.toString('base64')];
  const revocations = signedRevocations(key.root, { keys: [keyId(key.release.pub)] });
  // The package itself is signed under the development root here; the
  // revocation list is too, and must still be applied (production ∪ dev).
  assert.throws(
    () => readPackage(bytes, { roots: production, developmentRoots: development, route: 'paired-developer', revocations }),
    expectCode('JZ_UNTRUSTED'),
  );
  assert.equal(
    readPackage(bytes, { roots: production, developmentRoots: development, route: 'paired-developer' }).trust,
    'development',
  );
});

test('a revoked payload digest is refused with JZ_UNTRUSTED', () => {
  const { result, bytes, key } = pack();
  assert.throws(
    () => verifyWithRevocations(bytes, key, signedRevocations(key.root, { packages: [result.payloadSha256] })),
    expectCode('JZ_UNTRUSTED'),
  );
});

test('supplied revocation data is fail-closed with JZ_UNTRUSTED', () => {
  const { bytes, key } = pack();
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    'not JSON': '{not json',
    'not an object': '[]',
    'unknown envelope field': signedRevocations(key.root, { envelopeFields: { extra: 1 } }),
    'signed by an untrusted root': signedRevocations(makeKeyPair()),
    'stale signature': signedRevocations(key.root, { sign: false }),
    'unknown format': signedRevocations(key.root, { format: 2 }),
    'negative sequence': signedRevocations(key.root, {
      bodyText: JSON.stringify({ format: 1, sequence: -1, issuedAt: now, keys: [], packages: [] }),
    }),
    'non-string key': signedRevocations(key.root, {
      bodyText: JSON.stringify({ format: 1, sequence: 1, issuedAt: now, keys: [7], packages: [] }),
    }),
    'unknown body field': signedRevocations(key.root, {
      bodyText: JSON.stringify({ format: 1, sequence: 1, issuedAt: now, keys: [], packages: [], extra: true }),
    }),
    'body not JSON': signedRevocations(key.root, { bodyText: 'not json' }),
  };
  for (const [what, revocations] of Object.entries(cases)) {
    assert.throws(
      () => verifyWithRevocations(bytes, key, revocations),
      (error) => {
        try {
          expectCode('JZ_UNTRUSTED')(error);
        } catch (failure) {
          throw new Error(`${what}: ${failure.message}`);
        }
        return true;
      },
      what,
    );
    assert.equal(verify(bytes, key).manifest.app.build, 1, 'no revocation data means no check');
  }
});

// ------------------------------------------------------ archive integrity

test('a CRC mismatch is refused with JZ_BAD_ARCHIVE', () => {
  const corrupt = craftedZip([{
    name: JZ_ENTRY.description,
    data: Buffer.from('# hi\n'),
    crc: 0xdeadbeef,
  }]);
  assert.throws(() => readZip(corrupt), expectCode('JZ_BAD_ARCHIVE'));
});

test('corrupt DEFLATE is refused with JZ_BAD_ARCHIVE', () => {
  const corrupt = craftedZip([{
    name: JZ_ENTRY.description,
    method: 8,
    data: Buffer.from([1, 2, 3]),
    compressed: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    declaredSize: 3,
  }]);
  assert.throws(() => readZip(corrupt), expectCode('JZ_BAD_ARCHIVE'));
});

test('a stored entry whose sizes disagree is refused with JZ_BAD_ARCHIVE', () => {
  const corrupt = craftedZip([{
    name: JZ_ENTRY.description,
    data: Buffer.from('abc'),
    declaredSize: 5,
  }]);
  assert.throws(() => readZip(corrupt), expectCode('JZ_BAD_ARCHIVE'));
});

test('an entry that inflates past its bound is refused with JZ_LIMIT_EXCEEDED', () => {
  const overBound = craftedZip([{
    name: JZ_ENTRY.description,
    method: 8,
    data: Buffer.alloc(0),
    compressed: deflate(Buffer.alloc(JZ_LIMITS.description + 1)),
    declaredSize: JZ_LIMITS.description,
  }]);
  assert.throws(() => readZip(overBound), expectCode('JZ_LIMIT_EXCEEDED'));
});

test('more than five entries is refused with JZ_UNKNOWN_ENTRY', () => {
  const entries = [
    { name: JZ_ENTRY.manifest, data: Buffer.from('{}') },
    { name: JZ_ENTRY.payload, data: Buffer.from('x') },
    { name: JZ_ENTRY.description, data: Buffer.from('x') },
    { name: JZ_ENTRY.signature, data: Buffer.from('{}') },
    { name: JZ_ENTRY.icon, data: Buffer.from('x') },
    { name: JZ_ENTRY.manifest, data: Buffer.from('{}') },
  ];
  assert.throws(() => readZip(craftedZip(entries)), expectCode('JZ_UNKNOWN_ENTRY'));
});

test('a required entry missing from the archive is JZ_UNKNOWN_ENTRY', () => {
  const { bytes, key } = pack();
  const entries = readZip(bytes)
    .filter((entry) => entry.name !== JZ_ENTRY.payload)
    .map((entry) => ({ name: entry.name, data: entry.data }));
  assert.throws(() => verify(writeZip(entries), key), expectCode('JZ_UNKNOWN_ENTRY'));
});

test('a manifest-listed file absent from the archive is JZ_BAD_MANIFEST', () => {
  const { bytes, key } = pack({ fixture: project({ withIcon: false }) });
  const tampered = resignPackage(bytes, key, {
    mutateManifest: (manifest) => {
      manifest.presentation.icon = JZ_ENTRY.icon;
      manifest.files.push({ path: JZ_ENTRY.icon, byteSize: 16, sha256: '0'.repeat(64) });
      manifest.files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    },
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_BAD_MANIFEST'));
});

// ------------------------------------------------------ identity pre-flight

test('payload identity that differs from the manifest is JZ_PAYLOAD_MISMATCH', () => {
  const { bytes, key } = pack();
  for (const payload of [
    nshPayload({ build: 9 }),
    nshPayload({ name: 'Other' }),
    nshPayload({ version: '9.9.9' }),
    nshPayload({ id: 'com.jiezi.miniapp.other' }),
  ]) {
    const tampered = resignPackage(bytes, key, { replaceEntries: { [JZ_ENTRY.payload]: payload } });
    assert.throws(() => verify(tampered, key), expectCode('JZ_PAYLOAD_MISMATCH'));
  }
});

// ------------------------------------------------------ producer validation

test('the producer refuses a manifest the reader would refuse (D8)', () => {
  const cases = {
    'uppercase app id': project({ id: 'com.jiezi.Comapp' }),
    'non-semver minRuntime': null,
    'over-long name': project({ name: 'N'.repeat(121) }),
    'lone surrogate in name': project({ name: 'Demo\ud800' }),
    'over-long version': project({ version: '1'.repeat(33) }),
    'control character in name': project({ name: 'De\u0085mo' }),
  };
  for (const [what, fixture] of Object.entries(cases)) {
    if (fixture === null) {
      const valid = project();
      assert.throws(
        () => pack({ fixture: valid, minRuntime: 'foo' }),
        expectCode('JZ_BAD_MANIFEST'),
        what,
      );
      continue;
    }
    assert.throws(() => pack({ fixture }), expectCode('JZ_BAD_MANIFEST'), what);
  }
});

test('the producer validates capability declaration shapes before signing', () => {
  for (const capabilities of [
    { network: 'all' },
    { host: [1, 2] },
    { clipboard: 1 },
    { clipboard: null },
  ]) {
    const fixture = project({ capabilities, purposes: {} });
    assert.throws(() => pack({ fixture }), expectCode('JZ_BAD_MANIFEST'));
  }
});

test('the producer rejects a reader-invalid manifest before it signs', () => {
  // Remove the signing material: if a bad manifest ever reaches the signing
  // step it fails with JZ_BAD_SIGNATURE instead. Every case below must fail
  // earlier, at the reader-rule pre-validation (034 plan D8).
  const key = keys();
  rmSync(join(key.dir, 'release.secret'));
  rmSync(join(key.dir, 'release.cert'));
  const cases = [
    project({ id: 'com.jiezi.Comapp' }),
    project({ name: 'N'.repeat(121) }),
    project({ name: 'Demo\ud800' }),
    project({ version: '1'.repeat(33) }),
    project({ capabilities: { network: 'all' }, purposes: {} }),
  ];
  assert.throws(
    () => pack({ key, fixture: project(), minRuntime: 'foo' }),
    expectCode('JZ_BAD_MANIFEST'),
    'minRuntime',
  );
  for (const fixture of cases) {
    assert.throws(() => pack({ key, fixture }), expectCode('JZ_BAD_MANIFEST'));
  }
  // Sanity: a valid manifest does reach signing and fails there.
  assert.throws(() => pack({ key, fixture: project() }), expectCode('JZ_BAD_SIGNATURE'));
});

test('the producer read-back is fail-closed and deletes the artifact', () => {
  const key = keys();
  const fixture = project();
  const artifactDir = tempDir('jz-readback-');
  rmSync(join(key.dir, 'root.pub'));
  assert.throws(
    () => packPackage({
      projectDir: fixture.dir,
      payloadPath: fixture.payloadPath,
      releaseId: 'rel_aaaaaaaaaaaaaaaa_1',
      buildNumber: 1,
      minRuntime: '0.6.0',
      keyDir: key.dir,
      artifactDir,
    }),
    expectCode('JZ_UNTRUSTED'),
  );
  assert.deepEqual(readdirSync(artifactDir), [], 'a refused package leaves no artifact or temp file');
});

// ------------------------------------------------------ manifest strictness

test('capability declaration shapes follow the NSH forms (D1, host:true)', () => {
  assert.deepEqual([...declaredCapabilityIDs({})], []);
  assert.deepEqual([...declaredCapabilityIDs({ host: true })], ['host']);
  assert.deepEqual([...declaredCapabilityIDs({ host: ['storage.file.*'] })], ['host']);
  assert.deepEqual([...declaredCapabilityIDs({ openUrl: { schemes: ['https'] } })], ['openUrl']);
  assert.deepEqual([...declaredCapabilityIDs({ clipboard: false, share: true })], ['share']);
  for (const bad of [null, [], 'x', { network: 'all' }, { host: [1] }, { clipboard: 0 }]) {
    assert.throws(() => declaredCapabilityIDs(bad), expectCode('JZ_BAD_MANIFEST'), JSON.stringify(bad));
  }
});

test('a host:true package builds, verifies and needs no purpose', () => {
  const fixture = project({
    capabilities: { host: true, openUrl: { schemes: ['https'] } },
    purposes: {},
  });
  const { result, bytes, key } = pack({ fixture });
  assert.deepEqual(result.capabilities, { host: true, openUrl: { schemes: ['https'] } });
  const verified = verify(bytes, key);
  assert.deepEqual(verified.manifest.capabilities.declaration, { host: true, openUrl: { schemes: ['https'] } });
  assert.deepEqual(verified.manifest.capabilities.purposes, {});
});

test('the sensitive capability list is exactly the NSH consent-relevant subset', () => {
  assert.deepEqual([...JZ_SENSITIVE_CAPABILITIES], ['clipboard', 'picker', 'share', 'speech', 'notifications']);
});

test('purpose refusal codes follow D6', () => {
  const { bytes, key } = pack();
  const cases = [
    ['missing sensitive purpose', { mutate: (manifest) => { manifest.capabilities.purposes = {}; } }, 'JZ_MISSING_PURPOSE'],
    ['empty purpose', { mutate: (manifest) => { manifest.capabilities.purposes.clipboard = '  '; } }, 'JZ_BAD_MANIFEST'],
    ['non-string purpose', { mutate: (manifest) => { manifest.capabilities.purposes.clipboard = 42; } }, 'JZ_BAD_MANIFEST'],
    ['over-long purpose', { mutate: (manifest) => { manifest.capabilities.purposes.clipboard = 'x'.repeat(241); } }, 'JZ_BAD_MANIFEST'],
    ['control character in purpose', { mutate: (manifest) => { manifest.capabilities.purposes.clipboard = 'Read\u0085clipboard'; } }, 'JZ_BAD_MANIFEST'],
    ['undeclared purpose', { mutate: (manifest) => {
      manifest.capabilities.declaration = {};
      manifest.capabilities.purposes = { clipboard: 'Read the clipboard.' };
    } }, 'JZ_UNKNOWN_PURPOSE'],
    ['purpose for false declaration', { mutate: (manifest) => { manifest.capabilities.declaration = { clipboard: false }; } }, 'JZ_UNKNOWN_PURPOSE'],
    ['purposes not an object', { mutate: (manifest) => { manifest.capabilities.purposes = []; } }, 'JZ_BAD_MANIFEST'],
  ];
  for (const [what, { mutate }, code] of cases) {
    assert.throws(() => verify(resignPackage(bytes, key, { mutateManifest: mutate }), key), expectCode(code), what);
  }
});

test('the reader refuses invalid critical, icon and identity fields with JZ_BAD_MANIFEST', () => {
  const { bytes, key } = pack();
  const cases = [
    ['critical null', (manifest) => { manifest.critical = null; }],
    ['critical string', (manifest) => { manifest.critical = 'x'; }],
    ['critical number element', (manifest) => { manifest.critical = [1]; }],
    ['icon null', (manifest) => { manifest.presentation.icon = null; }],
    ['icon wrong path', (manifest) => { manifest.presentation.icon = 'assets/other.png'; }],
    ['version control character', (manifest) => { manifest.app.version = '1.0.0\u0000'; }],
    ['version over 32 scalars', (manifest) => { manifest.app.version = '1'.repeat(33); }],
    ['build zero', (manifest) => { manifest.app.build = 0; }],
    ['build fractional', (manifest) => { manifest.app.build = 1.5; }],
    ['name C1 control', (manifest) => { manifest.app.name = 'De\u009Fmo'; }],
    ['summary blank', (manifest) => { manifest.presentation.summary = '   '; }],
    ['summary C1 control', (manifest) => { manifest.presentation.summary = 'A\u0085B'; }],
    ['summary over 120 scalars', (manifest) => { manifest.presentation.summary = 's'.repeat(121); }],
    ['minRuntime short', (manifest) => { manifest.runtime.minRuntime = '1.0'; }],
    ['minRuntime non-ASCII digits', (manifest) => { manifest.runtime.minRuntime = '１.０.０'; }],
    ['unsorted files', (manifest) => { manifest.files.reverse(); }],
    ['file list missing description', (manifest) => {
      manifest.files = manifest.files.filter((file) => file.path !== JZ_ENTRY.description);
    }],
  ];
  for (const [what, mutate] of cases) {
    assert.throws(
      () => verify(resignPackage(bytes, key, { mutateManifest: mutate }), key),
      expectCode('JZ_BAD_MANIFEST'),
      what,
    );
  }
});

test('a summary is accepted only when it is non-empty after trimming', () => {
  const { bytes, key } = pack();
  const padded = resignPackage(bytes, key, {
    mutateManifest: (manifest) => { manifest.presentation.summary = '  Padded summary  '; },
  });
  assert.equal(verify(padded, key).manifest.presentation.summary, 'Padded summary');
});

// ------------------------------------------------------ icon rules (D2)

test('icon structure rules refuse APNG, chunks after IEND and a non-first IHDR', () => {
  const animated = png({ extraChunks: [pngChunk('acTL', Buffer.alloc(8))] });
  assert.throws(() => validateIcon(animated), expectCode('JZ_BAD_ICON'));
  const trailingIdat = png({ trailing: pngChunk('IDAT', Buffer.from([1, 2, 3])) });
  assert.throws(() => validateIcon(trailingIdat), expectCode('JZ_BAD_ICON'));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const noHeader = Buffer.concat([signature, pngChunk('sRGB', Buffer.from([0])), pngChunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => validateIcon(noHeader), expectCode('JZ_BAD_ICON'));
});

test('an icon without exactly one valid sRGB chunk is refused with JZ_BAD_ICON', () => {
  assert.doesNotThrow(() => validateIcon(png()));
  assert.throws(() => validateIcon(png({ srgb: false })), expectCode('JZ_BAD_ICON'));
  assert.throws(() => validateIcon(png({ srgb: false, iccp: true })), expectCode('JZ_BAD_ICON'));
  assert.throws(() => validateIcon(png({ duplicateSrgb: true })), expectCode('JZ_BAD_ICON'));
  assert.throws(
    () => validateIcon(png({ srgb: false, extraChunks: [pngChunk('sRGB', Buffer.from([4]))] })),
    expectCode('JZ_BAD_ICON'),
    'rendering intent must be 0..3',
  );
});

test('the sRGB chunk must precede IDAT and IDAT chunks must stay last (Swift parity)', () => {
  const valid = png();
  const signature = valid.subarray(0, 8);
  const ihdr = valid.subarray(8, 8 + 25); // IHDR: 8+13+4
  const srgb = valid.subarray(8 + 25, 8 + 25 + 13); // sRGB: 8+1+4
  const rest = valid.subarray(8 + 25 + 13);
  const iend = rest.subarray(rest.length - 12);
  const body = rest.subarray(0, rest.length - 12);
  const lateSrgb = Buffer.concat([signature, ihdr, body, srgb, iend]);
  assert.throws(() => validateIcon(lateSrgb), expectCode('JZ_BAD_ICON'));
  const lateText = Buffer.concat([signature, ihdr, srgb, body, pngChunk('tEXt', Buffer.from('k\0v')), iend]);
  assert.throws(() => validateIcon(lateText), expectCode('JZ_BAD_ICON'));
});

test('the image data is validated even when no color-space chunk is present', () => {
  // The sRGB chunk is optional to the PNG structure but required by v1, so
  // these two cases pin which rule refuses an sRGB-less icon with broken
  // image data (either way: JZ_BAD_ICON).
  assert.throws(() => validateIcon(png({ srgb: false, idat: Buffer.from('not zlib') })), expectCode('JZ_BAD_ICON'));
  assert.throws(() => validateIcon(png({ srgb: false, noIdat: true })), expectCode('JZ_BAD_ICON'));

  // With sRGB present a broken image must still fail: the scanline check is
  // never skipped because the optional chunk happens to be there.
  assert.throws(() => validateIcon(png({ noIdat: true })), expectCode('JZ_BAD_ICON'));
  assert.throws(() => validateIcon(png({ idat: Buffer.alloc(0) })), expectCode('JZ_BAD_ICON'));
  assert.throws(() => validateIcon(png({ idat: Buffer.from('not zlib data') })), expectCode('JZ_BAD_ICON'));
});

test('an image whose scanlines do not match the declared size is refused', () => {
  const expected = 1024 * (1 + 1024 * 3);
  assert.throws(() => validateIcon(png({ raw: Buffer.alloc(expected - 1) })), expectCode('JZ_BAD_ICON'));
  assert.throws(() => validateIcon(png({ raw: Buffer.alloc(expected + 1) })), expectCode('JZ_BAD_ICON'));
});

test('an invalid scanline filter byte is refused', () => {
  const raw = Buffer.alloc(1024 * (1 + 1024 * 3));
  raw[0] = 5;
  assert.throws(() => validateIcon(png({ raw })), expectCode('JZ_BAD_ICON'));
});

test('non-contiguous IDAT chunks are refused', () => {
  const raw = Buffer.alloc(1024 * (1 + 1024 * 3));
  const stream = deflateSync(raw);
  const middle = Math.floor(stream.length / 2);
  assert.doesNotThrow(() => validateIcon(png({ idatParts: [stream.subarray(0, middle), stream.subarray(middle)] })));
  assert.throws(
    () => validateIcon(png({
      idatParts: [stream.subarray(0, middle), stream.subarray(middle)],
      betweenIdat: [pngChunk('tEXt', Buffer.from('k\0v'))],
    })),
    expectCode('JZ_BAD_ICON'),
  );
});

test('the producer and the reader both refuse a no-sRGB icon', () => {
  const badIcon = png({ srgb: false });
  assert.throws(() => pack({ fixture: project({ icon: badIcon }) }), expectCode('JZ_BAD_ICON'));
  const { bytes, key } = pack();
  const tampered = resignPackage(bytes, key, { replaceEntries: { [JZ_ENTRY.icon]: badIcon } });
  assert.throws(() => verify(tampered, key), expectCode('JZ_BAD_ICON'));
});

test('a valid RGBA icon decodes (the scanline bound is the declared size, not 2 MiB)', () => {
  assert.doesNotThrow(() => validateIcon(png({ colorType: 6 })));
});

// ------------------------------------------------------ Markdown rules (D3)

test('the restricted Markdown allows explicit https links, code and prose colons', () => {
  for (const good of [
    '# Title\n\n[a link](https://example.com/path?q=1)\n',
    'Use `https://example.com` in code.\n',
    '```\nhttps://example.com\nuser@example.com\n[ref]: https://example.com\n```\n',
    'Note: see the docs above.\n',
    '**Note:** This is fine.\n',
    '_Note:_ This is fine too.\n',
    'Text with `code: span` and `user@example.com` inside it.\n',
    'Fenced with info\n\n```js\nconst url = "https://example.com";\n```\n',
    '\n',
  ]) {
    assert.doesNotThrow(() => validateDescription(Buffer.from(good)), good);
  }
});

test('the restricted Markdown refuses bare URLs, e-mails and reference links', () => {
  for (const bad of [
    'Visit https://example.com now\n',
    'Visit http://example.com now\n',
    'Download ftp://files.example.com/x\n',
    'Custom foo:bar scheme\n',
    'a:1\n',
    'Run javascript:alert(1) here\n',
    'data:text/html,hi\n',
    'Write mailto:user@example.com\n',
    'Contact user@example.com please\n',
    '[docs][ref]\n\n[ref]: https://example.com\n',
    '[ref]: https://example.com\n',
    '[x](https://)\n',
    '[x](https://example.com/a b)\n',
    '[x](https://example.com/a`b)\n',
    '[x](https://exa<mple.com)\n',
    '```\nhttps://example.com\n',
    // An unmatched backtick is literal text, not a code span: the URL after it
    // is still prose and would still autolink (the Swift reader agrees).
    '` https://example.com\n',
  ]) {
    assert.throws(() => validateDescription(Buffer.from(bad)), expectCode('JZ_BAD_DESCRIPTION'), bad);
  }
});

test('the producer and the reader both refuse a description with a bare URL', () => {
  assert.throws(
    () => pack({ fixture: project({ about: 'Visit https://example.com now\n' }) }),
    expectCode('JZ_BAD_DESCRIPTION'),
  );
  const { bytes, key } = pack();
  const tampered = resignPackage(bytes, key, {
    replaceEntries: { [JZ_ENTRY.description]: Buffer.from('Visit https://example.com now\n') },
  });
  assert.throws(() => verify(tampered, key), expectCode('JZ_BAD_DESCRIPTION'));
});

// ------------------------------------------------------ bounded file read

test('verifyPackageFile reads a bounded file without writing anything', () => {
  const { result, key } = pack();
  const directory = tempDir('jz-verify-file-');
  const path = join(directory, 'sample.jz');
  writeFileSync(path, readFileSync(result.packagePath));
  const verified = verifyPackageFile(path, { roots: [key.root.pub.toString('base64')] });
  assert.equal(verified.manifest.app.build, 1);
  assert.deepEqual(readdirSync(directory), ['sample.jz'], 'verification must not leave temp files');
});

test('verifyPackageFile refuses an oversized file before reading it', () => {
  const directory = tempDir('jz-verify-large-');
  const path = join(directory, 'large.jz');
  const fd = openSync(path, 'w');
  try {
    ftruncateSync(fd, JZ_LIMITS.package + 1);
  } finally {
    closeSync(fd);
  }
  assert.throws(() => verifyPackageFile(path), expectCode('JZ_LIMIT_EXCEEDED'));
});

test('verifyPackageFile refuses a directory path', () => {
  const directory = tempDir('jz-verify-dir-');
  assert.throws(() => verifyPackageFile(directory), expectCode('JZ_BAD_ARCHIVE'));
});

