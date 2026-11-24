// Strict `.jz` ZIP container writer and reader (034 plan §4.3).
//
// The v1 format is deliberately narrower than ZIP: five allowlisted regular
// files, stored or raw DEFLATE, no comments, no extra fields, no data
// descriptors, no ZIP64, no multi-disk and no trailing bytes. A generic ZIP
// library would accept containers this format must refuse, so both directions
// are implemented here against the spec directly.

import { Buffer } from 'node:buffer';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { JZ_LIMITS, entryLimit, jzError } from './jz.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT_SCAN = 64 * 1024;
/** 1980-01-01 00:00:00 in MS-DOS date/time form. */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;
const FILE_MODE = 0o100644;
const VERSION_MADE_BY = 0x031e; // Unix (3) + ZIP 3.0 (30)
const VERSION_NEEDED = 0x0014; // ZIP 2.0
const UTF8_FLAG = 0x0800;

/**
 * Writes a canonical container. Entries are sorted by their UTF-8 path bytes,
 * deflated at level 9, stamped with a fixed timestamp and regular-file mode so
 * two writers of the same inputs agree byte-for-byte.
 * @param {Array<{name: string, data: Buffer}>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const prepared = entries
    .map((entry) => ({
      name: Buffer.from(entry.name, 'utf8'),
      data: entry.data,
      crc: crc32(entry.data) >>> 0,
      compressed: deflateRawSync(entry.data, { level: 9 }),
    }))
    .sort((left, right) => Buffer.compare(left.name, right.name));

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of prepared) {
    const local = Buffer.alloc(LOCAL_SIZE);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, entry.name, entry.compressed);

    const header = Buffer.alloc(CENTRAL_SIZE);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30); // extra length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, entry.name);

    offset += local.length + entry.name.length + entry.compressed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(EOCD_SIZE);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // central directory disk
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, directory, end]);
}

/**
 * Reads and validates a container, returning its entries. Every rule that can
 * refuse a package runs before a caller sees bytes; the declared uncompressed
 * size is never pre-allocated.
 * @param {Buffer} buffer
 * @returns {Array<{name: string, data: Buffer, method: number}>}
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) throw jzError('JZ_BAD_ARCHIVE', 'package is not a buffer');
  if (buffer.length < EOCD_SIZE) throw jzError('JZ_BAD_ARCHIVE', 'package is too short to be a ZIP archive');
  if (buffer.length > JZ_LIMITS.package) {
    throw jzError('JZ_LIMIT_EXCEEDED', `package exceeds ${JZ_LIMITS.package} bytes`);
  }

  const eocdOffset = findEndOfCentralDirectory(buffer);
  const end = readEocd(buffer, eocdOffset);
  const directoryEnd = eocdOffset + EOCD_SIZE;
  if (directoryEnd !== buffer.length) {
    throw jzError('JZ_BAD_ARCHIVE', 'trailing bytes after the ZIP end record');
  }
  if (end.centralOffset + end.centralSize !== eocdOffset) {
    throw jzError('JZ_BAD_ARCHIVE', 'central directory does not end at the ZIP end record');
  }
  if (end.centralOffset > buffer.length || eocdOffset > buffer.length) {
    throw jzError('JZ_BAD_ARCHIVE', 'central directory is out of range');
  }
  if (end.entryCount > JZ_LIMITS.entries) {
    throw jzError('JZ_UNKNOWN_ENTRY', `package has ${end.entryCount} entries; v1 allows at most ${JZ_LIMITS.entries}`);
  }
  if (end.entryCount === 0) throw jzError('JZ_UNKNOWN_ENTRY', 'package has no entries');

  const entries = [];
  const seen = new Set();
  let cursor = end.centralOffset;
  let aggregate = 0;
  for (let index = 0; index < end.entryCount; index += 1) {
    const header = readCentralHeader(buffer, cursor, eocdOffset);
    if (header.nextOffset > eocdOffset) {
      throw jzError('JZ_BAD_ARCHIVE', 'central directory overruns its declared size');
    }
    if (seen.has(header.nameKey)) {
      throw jzError('JZ_UNKNOWN_ENTRY', `duplicate or case-colliding entry: ${header.name}`);
    }
    seen.add(header.nameKey);
    if (entryLimit(header.name) === null) {
      throw jzError('JZ_UNKNOWN_ENTRY', `entry is not part of .jz v1: ${header.name}`);
    }
    const data = readLocalEntry(buffer, header);
    aggregate += data.length;
    if (aggregate > JZ_LIMITS.aggregate) {
      throw jzError('JZ_LIMIT_EXCEEDED', `uncompressed entries exceed ${JZ_LIMITS.aggregate} bytes`);
    }
    entries.push({ name: header.name, data, method: header.method });
    cursor = header.nextOffset;
  }
  if (cursor !== eocdOffset) {
    throw jzError('JZ_BAD_ARCHIVE', 'central directory contains unread records');
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - EOCD_SIZE - MAX_COMMENT_SCAN);
  for (let offset = buffer.length - EOCD_SIZE; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_SIZE + commentLength === buffer.length) return offset;
  }
  throw jzError('JZ_BAD_ARCHIVE', 'no ZIP end record was found');
}

function readEocd(buffer, offset) {
  if (buffer.readUInt16LE(offset + 20) !== 0) {
    throw jzError('JZ_BAD_ARCHIVE', 'archive comments are not allowed');
  }
  const diskNumber = buffer.readUInt16LE(offset + 4);
  const directoryDisk = buffer.readUInt16LE(offset + 6);
  const entriesOnDisk = buffer.readUInt16LE(offset + 8);
  const entryCount = buffer.readUInt16LE(offset + 10);
  if (diskNumber !== 0 || directoryDisk !== 0) {
    throw jzError('JZ_BAD_ARCHIVE', 'multi-disk archives are not allowed');
  }
  if (entriesOnDisk !== entryCount) {
    throw jzError('JZ_BAD_ARCHIVE', 'entry count disagrees between disks');
  }
  if (entryCount === 0xffff) throw jzError('JZ_BAD_ARCHIVE', 'ZIP64 archives are not allowed');
  const centralSize = buffer.readUInt32LE(offset + 12);
  const centralOffset = buffer.readUInt32LE(offset + 16);
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw jzError('JZ_BAD_ARCHIVE', 'ZIP64 archives are not allowed');
  }
  return { entryCount, centralSize, centralOffset };
}

function readCentralHeader(buffer, offset, limit) {
  if (offset + CENTRAL_SIZE > limit) {
    throw jzError('JZ_BAD_ARCHIVE', 'truncated central directory header');
  }
  if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
    throw jzError('JZ_BAD_ARCHIVE', 'invalid central directory signature');
  }
  const madeByPlatform = buffer.readUInt16LE(offset + 4) >> 8;
  const flags = buffer.readUInt16LE(offset + 8);
  const method = buffer.readUInt16LE(offset + 10);
  const crc = buffer.readUInt32LE(offset + 16);
  const compressedSize = buffer.readUInt32LE(offset + 20);
  const uncompressedSize = buffer.readUInt32LE(offset + 24);
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  const diskStart = buffer.readUInt16LE(offset + 34);
  const externalAttributes = buffer.readUInt32LE(offset + 38);
  const localOffset = buffer.readUInt32LE(offset + 42);
  const nameStart = offset + CENTRAL_SIZE;
  const nextOffset = nameStart + nameLength + extraLength + commentLength;
  if (nextOffset > limit) throw jzError('JZ_BAD_ARCHIVE', 'central directory header overruns the directory');

  if (flags & 0x0001) throw jzError('JZ_BAD_ARCHIVE', 'encrypted entries are not allowed');
  if (flags & 0x0008) throw jzError('JZ_BAD_ARCHIVE', 'data descriptors are not allowed');
  if (flags & 0x0040) throw jzError('JZ_BAD_ARCHIVE', 'strong encryption is not allowed');
  if (method !== 0 && method !== 8) {
    throw jzError('JZ_BAD_ARCHIVE', `unsupported compression method ${method}`);
  }
  if (extraLength !== 0) throw jzError('JZ_BAD_ARCHIVE', 'ZIP extra fields are not allowed');
  if (commentLength !== 0) throw jzError('JZ_BAD_ARCHIVE', 'entry comments are not allowed');
  if (diskStart !== 0) throw jzError('JZ_BAD_ARCHIVE', 'multi-disk entries are not allowed');
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
    throw jzError('JZ_BAD_ARCHIVE', 'ZIP64 entries are not allowed');
  }

  // Unix creators carry a file type; anything but a regular file (notably a
  // symlink or a device) is refused. Other creators must still not claim one.
  if (madeByPlatform === 3) {
    const type = (externalAttributes >>> 16) & 0o170000;
    if (type !== 0 && type !== 0o100000) {
      throw jzError('JZ_UNKNOWN_ENTRY', 'archive entry is not a regular file');
    }
  }
  if ((externalAttributes & 0x10) !== 0) {
    throw jzError('JZ_UNKNOWN_ENTRY', 'directory entries are not allowed');
  }

  const rawName = buffer.subarray(nameStart, nameStart + nameLength);
  const name = decodeEntryName(rawName);
  if (localOffset >= limit) throw jzError('JZ_BAD_ARCHIVE', 'entry data is out of range');

  return {
    name,
    nameKey: name.toLowerCase(),
    rawName,
    method,
    crc,
    compressedSize,
    uncompressedSize,
    localOffset,
    nextOffset,
  };
}

function decodeEntryName(raw) {
  const name = raw.toString('utf8');
  if (Buffer.from(name, 'utf8').length !== raw.length) {
    throw jzError('JZ_UNKNOWN_ENTRY', 'entry name is not valid UTF-8');
  }
  if (name.length === 0) throw jzError('JZ_UNKNOWN_ENTRY', 'entry name is empty');
  if (name.includes('\\')) throw jzError('JZ_UNKNOWN_ENTRY', 'entry names must use forward slashes');
  if (name.includes('\0')) throw jzError('JZ_UNKNOWN_ENTRY', 'entry name contains NUL');
  if (name.includes(':')) throw jzError('JZ_UNKNOWN_ENTRY', 'entry name contains a colon');
  if (name.startsWith('/')) throw jzError('JZ_UNKNOWN_ENTRY', 'entry name is absolute');
  const segments = name.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw jzError('JZ_UNKNOWN_ENTRY', 'entry name escapes the archive root');
  }
  return name;
}

function readLocalEntry(buffer, header) {
  const offset = header.localOffset;
  if (offset + LOCAL_SIZE > buffer.length) throw jzError('JZ_BAD_ARCHIVE', 'truncated local header');
  if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw jzError('JZ_BAD_ARCHIVE', 'invalid local header signature');
  }
  const flags = buffer.readUInt16LE(offset + 6);
  const method = buffer.readUInt16LE(offset + 8);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + LOCAL_SIZE + nameLength + extraLength;
  const dataEnd = dataStart + header.compressedSize;
  if (dataEnd > buffer.length) throw jzError('JZ_BAD_ARCHIVE', 'entry data is truncated');

  if (flags & 0x0001) throw jzError('JZ_BAD_ARCHIVE', 'encrypted entries are not allowed');
  if (flags & 0x0008) throw jzError('JZ_BAD_ARCHIVE', 'data descriptors are not allowed');
  if (method !== header.method) throw jzError('JZ_BAD_ARCHIVE', 'local and central methods disagree');
  if (extraLength !== 0) throw jzError('JZ_BAD_ARCHIVE', 'ZIP extra fields are not allowed');
  const localName = buffer.subarray(offset + LOCAL_SIZE, offset + LOCAL_SIZE + nameLength);
  if (Buffer.compare(localName, header.rawName) !== 0) {
    throw jzError('JZ_BAD_ARCHIVE', 'local and central entry names disagree');
  }

  const limit = entryLimit(header.name);
  if (header.uncompressedSize > limit) {
    throw jzError('JZ_LIMIT_EXCEEDED', `${header.name} exceeds ${limit} bytes`);
  }

  let data;
  if (header.method === 0) {
    if (header.compressedSize !== header.uncompressedSize) {
      throw jzError('JZ_BAD_ARCHIVE', 'stored entry sizes disagree');
    }
    data = buffer.subarray(dataStart, dataEnd);
  } else {
    try {
      data = inflateRawSync(buffer.subarray(dataStart, dataEnd), {
        maxOutputLength: Math.max(1, limit),
      });
    } catch (error) {
      // A stream that inflates past its per-entry bound is a bound failure
      // (JZ_LIMIT_EXCEEDED); anything else is corrupt DEFLATE (JZ_BAD_ARCHIVE).
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw jzError('JZ_LIMIT_EXCEEDED', `${header.name} expands beyond ${limit} bytes`);
      }
      throw jzError('JZ_BAD_ARCHIVE', `${header.name} is not valid raw DEFLATE data`);
    }
  }
  if (data.length !== header.uncompressedSize) {
    throw jzError('JZ_BAD_ARCHIVE', `${header.name} does not match its declared size`);
  }
  if ((crc32(data) >>> 0) !== header.crc) {
    throw jzError('JZ_BAD_ARCHIVE', `${header.name} does not match its CRC-32`);
  }
  return data;
}
