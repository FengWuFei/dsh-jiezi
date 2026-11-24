// `.jz` icon and description validation (034 plan §4.5).
//
// Both validators work on the exact bytes the archive holds: the format claim
// in a name or manifest is never trusted.

import { Buffer } from 'node:buffer';
import { crc32, inflateSync } from 'node:zlib';
import { JZ_LIMITS, jzError } from './jz.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICON_DIMENSION = 1024;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * Validates a v1 icon: PNG, exactly 1024×1024, 8-bit RGB or RGBA, sRGB, no
 * animation, every chunk structurally valid with a matching CRC, and no bytes
 * after `IEND`.
 *
 * The image data is always decoded, even when no color-space chunk is present:
 * a PNG is only safe to accept when its IDAT stream inflates to exactly the
 * declared scanline bytes and every row starts with a valid filter byte. The
 * optional `sRGB` chunk is a separate format requirement (plan §4.5), never a
 * precondition for validating the pixels.
 */
export function validateIcon(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 12) {
    throw jzError('JZ_BAD_ICON', 'icon is not a PNG file');
  }
  if (buffer.length > JZ_LIMITS.icon) {
    throw jzError('JZ_LIMIT_EXCEEDED', `icon exceeds ${JZ_LIMITS.icon} bytes`);
  }
  if (Buffer.compare(buffer.subarray(0, 8), PNG_SIGNATURE) !== 0) {
    throw jzError('JZ_BAD_ICON', 'icon has no PNG signature');
  }
  const chunks = [];
  let offset = 8;
  let header = null;
  let seenEnd = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw jzError('JZ_BAD_ICON', 'icon has a truncated chunk');
    const length = buffer.readUInt32BE(offset);
    if (length > MAX_CHUNK_BYTES || offset + 12 + length > buffer.length) {
      throw jzError('JZ_BAD_ICON', 'icon chunk length is out of range');
    }
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const storedCrc = buffer.readUInt32BE(offset + 8 + length);
    if ((crc32(buffer.subarray(offset + 4, offset + 8 + length)) >>> 0) !== storedCrc) {
      throw jzError('JZ_BAD_ICON', `icon chunk ${type} has an invalid CRC`);
    }
    if (header === null && type !== 'IHDR') throw jzError('JZ_BAD_ICON', 'icon must begin with IHDR');
    switch (type) {
      case 'IHDR': {
        if (header !== null) throw jzError('JZ_BAD_ICON', 'icon has more than one IHDR');
        if (length !== 13) throw jzError('JZ_BAD_ICON', 'icon IHDR must be 13 bytes');
        header = {
          width: data.readUInt32BE(0),
          height: data.readUInt32BE(4),
          bitDepth: data.readUInt8(8),
          colorType: data.readUInt8(9),
          compression: data.readUInt8(10),
          filter: data.readUInt8(11),
          interlace: data.readUInt8(12),
        };
        break;
      }
      case 'IEND':
        if (length !== 0) throw jzError('JZ_BAD_ICON', 'icon IEND must be empty');
        if (offset + 12 !== buffer.length) {
          throw jzError('JZ_BAD_ICON', 'icon has bytes after IEND');
        }
        seenEnd = true;
        offset = buffer.length;
        break;
      default:
        // Every other chunk (IHDR is handled above) is kept so the image
        // data and color-space requirements are checked after the scan.
        // Ancillary chunks are tolerated but must have passed CRC/length.
        chunks.push({ type, data });
        break;
    }
    if (seenEnd) break;
    offset += 12 + length;
  }
  if (header === null) throw jzError('JZ_BAD_ICON', 'icon has no IHDR');
  if (!seenEnd) throw jzError('JZ_BAD_ICON', 'icon has no IEND or has bytes after it');
  if (chunks.some((chunk) => chunk.type === 'acTL' || chunk.type === 'fcTL' || chunk.type === 'fdAT')) {
    throw jzError('JZ_BAD_ICON', 'animated PNG icons are not allowed');
  }
  if (header.width !== ICON_DIMENSION || header.height !== ICON_DIMENSION) {
    throw jzError('JZ_BAD_ICON', `icon must be ${ICON_DIMENSION}×${ICON_DIMENSION}, got ${header.width}×${header.height}`);
  }
  if (header.bitDepth !== 8) throw jzError('JZ_BAD_ICON', 'icon must use 8-bit channels');
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw jzError('JZ_BAD_ICON', 'icon must be RGB or RGBA');
  }
  if (header.compression !== 0 || header.filter !== 0) {
    throw jzError('JZ_BAD_ICON', 'icon uses an unsupported PNG compression or filter method');
  }
  if (header.interlace !== 0) throw jzError('JZ_BAD_ICON', 'interlaced PNG icons are not allowed');
  const colorSpace = chunks.filter((chunk) => chunk.type === 'sRGB');
  if (colorSpace.length === 0) throw jzError('JZ_BAD_ICON', 'icon must declare an sRGB color space');
  if (colorSpace.length > 1) throw jzError('JZ_BAD_ICON', 'icon has more than one sRGB chunk');
  // The sRGB chunk body is one rendering-intent byte, 0 through 3, and the
  // chunk must precede the image data (the Swift reader enforces both).
  if (colorSpace[0].data.length !== 1 || colorSpace[0].data[0] > 3) {
    throw jzError('JZ_BAD_ICON', 'icon sRGB chunk is invalid');
  }
  if (!colorSpacePrecedesImageData(chunks)) {
    throw jzError('JZ_BAD_ICON', 'icon sRGB chunk must come before the image data');
  }
  const imageData = imageDataOf(chunks);
  decodeScanlines(imageData, header);
  return {
    width: header.width,
    height: header.height,
    colorType: header.colorType,
    hasAlpha: header.colorType === 6,
    srgb: true,
  };
}

/**
 * The IDAT payloads, requiring at least one and that no other chunk appears
 * between them (the Swift reader enforces the same rule). PNG allows trailing
 * ancillary chunks after IDAT, but v1 does not: the writers here never emit
 * them, and a reader/validator disagreement is worse than the lost chunk.
 */
function imageDataOf(chunks) {
  const imageData = [];
  let imageDataStarted = false;
  for (const chunk of chunks) {
    if (chunk.type === 'IDAT') {
      imageDataStarted = true;
      imageData.push(chunk.data);
      continue;
    }
    if (imageDataStarted) throw jzError('JZ_BAD_ICON', 'icon IDAT chunks are not contiguous');
  }
  if (imageData.length === 0) throw jzError('JZ_BAD_ICON', 'icon has no image data');
  return imageData;
}

/**
 * Decompresses the image data far enough to prove the stream is complete and
 * bounded. 1024×1024 RGB is 3,146,752 scanline bytes and RGBA is 4,195,328, so
 * the bound is the exact expected size rather than the 2 MiB compressed icon
 * cap. A hostile 2 MiB PNG can otherwise claim gigabytes of scanlines.
 */
function decodeScanlines(imageData, header) {
  const channels = header.colorType === 6 ? 4 : 3;
  const rowBytes = 1 + header.width * channels;
  const expected = header.height * rowBytes;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(imageData), { maxOutputLength: expected });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw jzError('JZ_BAD_ICON', 'icon image data is larger than the declared 1024×1024 pixels');
    }
    throw jzError('JZ_BAD_ICON', 'icon image data does not decompress to a complete image');
  }
  if (raw.length !== expected) {
    throw jzError('JZ_BAD_ICON', 'icon image data does not match the declared dimensions');
  }
  for (let row = 0; row < header.height; row += 1) {
    if (raw[row * rowBytes] > 4) {
      throw jzError('JZ_BAD_ICON', `icon row ${row + 1} uses an invalid scanline filter`);
    }
  }
  return raw;
}

/** Whether the single sRGB chunk appears before the first IDAT. */
function colorSpacePrecedesImageData(chunks) {
  for (const chunk of chunks) {
    if (chunk.type === 'sRGB') return true;
    if (chunk.type === 'IDAT') return false;
  }
  return false;
}

/** `https://` with a non-empty host and no whitespace, `<`, `>`, quotes or backtick. */
const ALLOWED_LINK = /^https:\/\/[^\s<>"'`]+$/;

function isAllowedLink(target) {
  if (!ALLOWED_LINK.test(target)) return false;
  const host = target.slice('https://'.length).split('/')[0];
  return host.length > 0;
}

/**
 * Neutralizes text a generator writes into one-line Markdown so a
 * user-supplied name can never introduce raw HTML, a code span, a link, a
 * reference link, a bare scheme URL or an e-mail autolink (034 plan A.11).
 * Characters that open active Markdown/HTML are dropped to spaces; `:` and
 * `@` are replaced with safe text even though backslash-escaping would keep
 * them, because the validators are context-free and would still see the
 * scheme/e-mail shapes. The result still reads as the name.
 */
export function neutralizedMarkdownText(value) {
  const stripped = String(value)
    .replace(/[\\`*_{}[\]<>!#|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.replaceAll(':', '：').replaceAll('@', ' at ') || 'mini app';
}

/**
 * Masks explicit links (`[text](target)`, already validated) with spaces so
 * the bare-link scan below cannot mistake their destination for an automatic
 * link. The replacement preserves length.
 */
function maskLinks(line) {
  return line.replace(/\[[^\]]*\]\([^)]*\)/g, (match) => ' '.repeat(match.length));
}

/**
 * Masks inline code spans (a run of N backticks up to a matching run of N
 * backticks) with spaces so Markdown that only *documents* autolinks stays
 * valid. An unbalanced backtick run is literal text, not an open code span.
 */
function maskInlineCode(line) {
  let output = '';
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '`') {
      output += line[index];
      index += 1;
      continue;
    }
    let openRun = 1;
    while (line[index + openRun] === '`') openRun += 1;
    let search = index + openRun;
    let close = -1;
    while (search < line.length) {
      if (line[search] === '`') {
        let closeRun = 1;
        while (line[search + closeRun] === '`') closeRun += 1;
        if (closeRun === openRun) {
          close = search + closeRun;
          break;
        }
        search += closeRun;
      } else {
        search += 1;
      }
    }
    if (close === -1) {
      // An unmatched run is literal text (matching the Swift reader): it
      // opens no code span, so a URL after it is still prose and still
      // autolinks.
      output += line.slice(index, index + openRun);
      index += openRun;
      continue;
    }
    output += ' '.repeat(close - index);
    index = close;
  }
  return output;
}

const RAW_HTML = /<[A-Za-z!/?]/;
const EMBEDDED_IMAGE = /!\[[^\]]*\]\(/;
const REFERENCE_DEFINITION = /^\[[^\]]+\]:/;
const REFERENCE_LINK = /\[[^\]]*\]\[[^\]]*\]/;
const BARE_LINK = /[A-Za-z][A-Za-z0-9+.-]*:[^\s*_]/;
const BARE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Validates the restricted-Markdown description: UTF-8, LF line endings, no
 * BOM, no control characters, no raw HTML or embedded content, and only
 * explicit `https://host/path` links (034 plan §4.5, D3).
 *
 * The predicate is shared with the Swift reader (`JZMedia.swift`):
 * - fenced-code lines are those whose trimmed text starts with ```, and they
 *   are skipped entirely;
 * - raw HTML, embedded images and explicit link destinations are checked on
 *   the raw non-fenced line;
 * - reference definitions, reference-style links, bare scheme URLs and bare
 *   e-mail addresses are checked after inline code and explicit links are
 *   masked, so documented syntax inside code stays valid.
 */
export function validateDescription(buffer) {
  if (!Buffer.isBuffer(buffer)) throw jzError('JZ_BAD_DESCRIPTION', 'description is not a buffer');
  if (buffer.length > JZ_LIMITS.description) {
    throw jzError('JZ_LIMIT_EXCEEDED', `description exceeds ${JZ_LIMITS.description} bytes`);
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw jzError('JZ_BAD_DESCRIPTION', 'description must not begin with a byte-order mark');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw jzError('JZ_BAD_DESCRIPTION', 'description is not valid UTF-8');
  }
  if (text.includes('\r')) throw jzError('JZ_BAD_DESCRIPTION', 'description must use LF line endings');
  if (text.includes('\u0000')) throw jzError('JZ_BAD_DESCRIPTION', 'description contains NUL');
  let fenced = false;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    checkInlineMarkdown(line, index + 1);
  }
  if (fenced) throw jzError('JZ_BAD_DESCRIPTION', 'description has an unterminated code fence');
  return text;
}

/** One Markdown line outside fenced code. */
function checkInlineMarkdown(line, lineNumber) {
  // Rules 1-3 scan the raw line (matching the Swift reader).
  if (RAW_HTML.test(line)) {
    throw jzError('JZ_BAD_DESCRIPTION', `line ${lineNumber} contains raw HTML`);
  }
  if (EMBEDDED_IMAGE.test(line)) {
    throw jzError('JZ_BAD_DESCRIPTION', `line ${lineNumber} embeds an image`);
  }
  for (const match of line.matchAll(/\[[^\]]*\]\(([^)]*)\)/g)) {
    const target = match[1].trim();
    if (!isAllowedLink(target)) {
      throw jzError('JZ_BAD_DESCRIPTION', `line ${lineNumber} links to a non-https target`);
    }
  }
  // Rules 4-7 run with inline code and explicit links masked.
  const masked = maskLinks(maskInlineCode(line));
  if (REFERENCE_DEFINITION.test(masked.trimStart())) {
    throw jzError('JZ_BAD_DESCRIPTION', `line ${lineNumber} defines a link reference`);
  }
  if (REFERENCE_LINK.test(masked)) {
    throw jzError('JZ_BAD_DESCRIPTION', `line ${lineNumber} uses a reference-style link`);
  }
  if (BARE_LINK.test(masked)) {
    throw jzError('JZ_BAD_DESCRIPTION', `line ${lineNumber} contains an automatic link`);
  }
  if (BARE_EMAIL.test(masked)) {
    throw jzError('JZ_BAD_DESCRIPTION', `line ${lineNumber} contains a bare e-mail address`);
  }
}
