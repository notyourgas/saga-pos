import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, lstatSync, statfsSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_RESERVE_BYTES = 256 * 1024 * 1024;
const DEFAULT_RESERVE_INODES = 1_024;
const DEFAULT_MAX_PIXELS = 40_000_000;

export class ReceiptEvidenceStorageError extends Error {
  constructor(code, statusCode = 500) {
    super(code);
    this.name = "ReceiptEvidenceStorageError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Replaceable storage contract. S3-compatible storage only needs to implement
// put/open/delete/stat with the same arguments and verified metadata result.
export class FilesystemReceiptEvidenceStorage {
  constructor({
    root,
    maxBytes = 10 * 1024 * 1024,
    reserveBytes = DEFAULT_RESERVE_BYTES,
    reserveInodes = DEFAULT_RESERVE_INODES,
    maxConcurrentWrites = 4,
    maxPixels = DEFAULT_MAX_PIXELS,
    idFactory = randomUUID,
  } = {}) {
    if (typeof root !== "string" || !root.trim()) throw failure("receipt_evidence_storage_root_required");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 25 * 1024 * 1024) throw failure("receipt_evidence_storage_limit_invalid");
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < maxBytes || reserveBytes > Number.MAX_SAFE_INTEGER) throw failure("receipt_evidence_storage_reserve_invalid");
    if (!Number.isSafeInteger(reserveInodes) || reserveInodes < 16 || reserveInodes > 1_000_000) throw failure("receipt_evidence_storage_reserve_invalid");
    if (!Number.isSafeInteger(maxConcurrentWrites) || maxConcurrentWrites < 1 || maxConcurrentWrites > 32) throw failure("receipt_evidence_storage_concurrency_invalid");
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1_000_000 || maxPixels > 100_000_000) throw failure("receipt_evidence_storage_pixel_limit_invalid");
    if (typeof idFactory !== "function") throw failure("receipt_evidence_storage_id_factory_invalid");
    this.root = resolve(root);
    this.maxBytes = maxBytes;
    this.reserveBytes = reserveBytes;
    this.reserveInodes = reserveInodes;
    this.maxConcurrentWrites = maxConcurrentWrites;
    this.maxPixels = maxPixels;
    this.idFactory = idFactory;
    this.activeWrites = 0;
    this.reservedBytes = 0;
    this.initialization = null;
    this.probePassed = false;
  }

  async initialize() {
    if (!this.initialization) this.initialization = this.#initializeOnce();
    try { return await this.initialization; }
    catch (error) { this.initialization = null; throw error; }
  }

  async put({ objectKey, body, contentLength, contentType, expectedChecksum, width, height } = {}) {
    const key = validObjectKey(objectKey);
    const declaredLength = positiveInteger(contentLength, "receipt_evidence_content_length_invalid");
    if (declaredLength > this.maxBytes) throw failure("receipt_evidence_too_large", 413);
    if (!CONTENT_TYPES.has(contentType)) throw failure("receipt_evidence_content_type_unsupported", 415);
    const checksum = validChecksum(expectedChecksum);
    const declaredWidth = positiveInteger(width, "receipt_evidence_width_invalid");
    const declaredHeight = positiveInteger(height, "receipt_evidence_height_invalid");
    validatePixels(declaredWidth, declaredHeight, this.maxPixels);
    await this.initialize();
    const releaseAdmission = this.#admit(declaredLength);

    const target = this.#target(key);
    let temporary;
    let handle;
    try {
      await this.#ensureParent(dirname(target));
      temporary = `${target}.upload-${this.idFactory()}`;
      handle = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let total = 0;
      for await (const chunkValue of chunks(body)) {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        total += chunk.length;
        if (total > this.maxBytes || total > declaredLength) throw failure("receipt_evidence_too_large", 413);
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      if (total !== declaredLength) throw failure("receipt_evidence_content_length_mismatch", 422);
      const binary = await readFile(temporary);
      if (key.startsWith("attendance/") && contentType === "image/jpeg" && jpegContainsExif(binary)) throw failure("attendance_evidence_exif_forbidden", 422);
      const metadata = imageMetadata(binary, this.maxPixels);
      if (metadata.contentType !== contentType) throw failure("receipt_evidence_mime_mismatch", 415);
      if (metadata.width !== declaredWidth || metadata.height !== declaredHeight) throw failure("receipt_evidence_dimension_mismatch", 422);
      const actualChecksum = hash.digest("hex");
      if (!constantEqual(actualChecksum, checksum)) throw failure("receipt_evidence_checksum_mismatch", 422);
      try { await link(temporary, target); }
      catch (error) {
        if (error?.code === "EEXIST") {
          const existing = await this.stat({ objectKey: key });
          if (existing.byteSize !== total || existing.checksum !== actualChecksum || existing.contentType !== metadata.contentType
            || existing.width !== metadata.width || existing.height !== metadata.height) throw failure("receipt_evidence_object_exists", 409);
          await rm(temporary, { force: true });
          return Object.freeze({ ...existing, idempotentReplay: true });
        }
        throw error;
      }
      await rm(temporary);
      return Object.freeze({ objectKey: key, contentType: metadata.contentType, byteSize: total, checksum: actualChecksum, width: metadata.width, height: metadata.height });
    } catch (error) {
      try { await handle?.close(); } catch {}
      if (temporary) await rm(temporary, { force: true });
      throw error;
    } finally {
      releaseAdmission();
    }
  }

  async open({ objectKey } = {}) {
    const target = await this.#existingTarget(validObjectKey(objectKey));
    return createReadStream(target, { flags: "r" });
  }

  async stat({ objectKey } = {}) {
    const key = validObjectKey(objectKey);
    const target = await this.#existingTarget(key);
    const file = await lstat(target);
    if (!file.isFile() || file.isSymbolicLink() || file.size > this.maxBytes) throw failure("receipt_evidence_object_unsafe");
    const buffer = await readFile(target);
    const metadata = imageMetadata(buffer, this.maxPixels);
    return { objectKey: key, byteSize: buffer.length, checksum: createHash("sha256").update(buffer).digest("hex"), ...metadata };
  }

  async verify({ objectKey, expectedChecksum, expectedByteSize, expectedContentType, expectedWidth, expectedHeight } = {}) {
    const actual = await this.stat({ objectKey });
    if (expectedChecksum !== undefined && !constantEqual(actual.checksum, validChecksum(expectedChecksum))) throw failure("receipt_evidence_integrity_mismatch", 503);
    if (expectedByteSize !== undefined && actual.byteSize !== positiveInteger(expectedByteSize, "receipt_evidence_content_length_invalid")) throw failure("receipt_evidence_integrity_mismatch", 503);
    if (expectedContentType !== undefined && actual.contentType !== expectedContentType) throw failure("receipt_evidence_integrity_mismatch", 503);
    if (expectedWidth !== undefined && actual.width !== positiveInteger(expectedWidth, "receipt_evidence_width_invalid")) throw failure("receipt_evidence_integrity_mismatch", 503);
    if (expectedHeight !== undefined && actual.height !== positiveInteger(expectedHeight, "receipt_evidence_height_invalid")) throw failure("receipt_evidence_integrity_mismatch", 503);
    return Object.freeze(actual);
  }

  health() {
    try {
      const stat = lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !this.probePassed) throw failure("receipt_evidence_storage_root_unsafe");
      const capacity = filesystemCapacity(this.root);
      const ready = capacity.availableBytes - this.reservedBytes >= this.reserveBytes
        && capacity.availableInodes >= this.reserveInodes;
      return Object.freeze({
        ready,
        provider: "FILESYSTEM_VPS",
        objectStorageMigrationReady: false,
        capacity: Object.freeze({
          availableBytes: capacity.availableBytes,
          availableInodes: capacity.availableInodes,
          reserveBytes: this.reserveBytes,
          reserveInodes: this.reserveInodes,
          activeWrites: this.activeWrites,
          maxConcurrentWrites: this.maxConcurrentWrites,
        }),
      });
    } catch {
      return Object.freeze({ ready: false, provider: "FILESYSTEM_VPS", objectStorageMigrationReady: false });
    }
  }

  async delete({ objectKey } = {}) {
    const key = validObjectKey(objectKey);
    const target = this.#target(key);
    try {
      const file = await lstat(target);
      if (!file.isFile() || file.isSymbolicLink()) throw failure("receipt_evidence_object_unsafe");
      await rm(target);
      return { deleted: true };
    } catch (error) {
      if (error?.code === "ENOENT") return { deleted: false };
      throw error;
    }
  }

  #target(key) {
    const target = resolve(this.root, ...key.split("/"));
    const rel = relative(this.root, target);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(target) !== target) throw failure("receipt_evidence_object_key_invalid");
    return target;
  }

  async #ensureParent(parent) {
    const rel = relative(this.root, parent);
    let cursor = this.root;
    for (const part of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      try {
        const entry = await lstat(cursor);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure("receipt_evidence_storage_path_unsafe");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(cursor, { mode: 0o700 });
      }
    }
  }

  async #existingTarget(key) {
    await this.initialize();
    const target = this.#target(key);
    const parent = dirname(target);
    const canonicalParent = await realpath(parent).catch(() => null);
    if (!canonicalParent || !samePath(canonicalParent, parent)) throw failure("receipt_evidence_object_missing", 404);
    const file = await lstat(target).catch(() => null);
    if (!file) throw failure("receipt_evidence_object_missing", 404);
    if (!file.isFile() || file.isSymbolicLink()) throw failure("receipt_evidence_object_unsafe");
    return target;
  }

  async #initializeOnce() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("receipt_evidence_storage_root_unsafe");
    const canonical = await realpath(this.root);
    // Pin every subsequent lookup to the canonical root. Windows may expand an
    // 8.3 path here; lstat above still rejects a symlink at the configured leaf.
    this.root = canonical;
    const probe = join(this.root, `.storage-probe-${this.idFactory()}`);
    let handle;
    try {
      const nonce = Buffer.from(this.idFactory(), "utf8");
      handle = await open(probe, "wx", 0o600);
      await handle.write(nonce);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (!(await readFile(probe)).equals(nonce)) throw failure("receipt_evidence_storage_probe_failed");
      await rm(probe);
      this.probePassed = true;
    } catch (error) {
      try { await handle?.close(); } catch {}
      await rm(probe, { force: true }).catch(() => {});
      this.probePassed = false;
      throw error?.code?.startsWith?.("receipt_evidence_") ? error : failure("receipt_evidence_storage_probe_failed");
    }
    const health = this.health();
    if (!health.ready) throw failure("receipt_evidence_storage_capacity_exhausted", 507);
    return { ready: true, provider: "filesystem", root: this.root, maxBytes: this.maxBytes, capacity: health.capacity };
  }

  #admit(byteSize) {
    const capacity = filesystemCapacity(this.root);
    if (this.activeWrites >= this.maxConcurrentWrites) throw failure("receipt_evidence_storage_busy", 503);
    if (capacity.availableBytes - this.reservedBytes - byteSize < this.reserveBytes || capacity.availableInodes - this.activeWrites < this.reserveInodes) {
      throw failure("receipt_evidence_storage_capacity_exhausted", 507);
    }
    this.activeWrites += 1;
    this.reservedBytes += byteSize;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeWrites -= 1;
      this.reservedBytes -= byteSize;
    };
  }
}

export function receiptEvidenceObjectKey({ organizationId, outletId, receiptId, evidenceId, extension } = {}) {
  const ext = extensionFor(extension);
  return `${uuid(organizationId)}/${uuid(outletId)}/${uuid(receiptId)}/${uuid(evidenceId)}.${ext}`;
}

function validObjectKey(value) {
  if (typeof value !== "string" || value.length < 10 || value.length > 300 || value.startsWith("/") || value.includes("\\")
    || value.split("/").some((part) => !part || part === "." || part === ".." || !/^[a-zA-Z0-9._-]+$/.test(part))) {
    throw failure("receipt_evidence_object_key_invalid");
  }
  return value;
}

function extensionFor(value) {
  const text = String(value ?? "").toLowerCase().replace(/^\./, "");
  if (!["jpg", "jpeg", "png", "webp"].includes(text)) throw failure("receipt_evidence_extension_invalid");
  return text === "jpeg" ? "jpg" : text;
}

function imageMetadata(binary, maxPixels = DEFAULT_MAX_PIXELS) {
  if (binary.length >= 24 && binary.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return pngMetadata(binary, maxPixels);
  }
  if (binary.length >= 12 && binary.subarray(0, 4).toString("ascii") === "RIFF" && binary.subarray(8, 12).toString("ascii") === "WEBP") {
    if (binary.readUInt32LE(4) + 8 !== binary.length) throw failure("receipt_evidence_binary_unsupported", 415);
    let webpOffset = 12;
    while (webpOffset + 8 <= binary.length) {
      const type = binary.subarray(webpOffset, webpOffset + 4).toString("ascii");
      const length = binary.readUInt32LE(webpOffset + 4);
      const end = webpOffset + 8 + length + (length % 2);
      if (end > binary.length) throw failure("receipt_evidence_binary_unsupported", 415);
      if (type === "EXIF" || type === "XMP ") throw failure("receipt_evidence_privacy_metadata_unsupported", 415);
      webpOffset = end;
    }
    if (webpOffset !== binary.length) throw failure("receipt_evidence_binary_unsupported", 415);
    const chunk = binary.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && binary.length >= 30) return dimensions("image/webp", 1 + binary.readUIntLE(24, 3), 1 + binary.readUIntLE(27, 3), maxPixels);
    if (chunk === "VP8 " && binary.length >= 30 && binary[23] === 0x9d && binary[24] === 0x01 && binary[25] === 0x2a) {
      return dimensions("image/webp", binary.readUInt16LE(26) & 0x3fff, binary.readUInt16LE(28) & 0x3fff, maxPixels);
    }
    if (chunk === "VP8L" && binary.length >= 25 && binary[20] === 0x2f) {
      const bits = binary.readUInt32LE(21);
      return dimensions("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, maxPixels);
    }
    throw failure("receipt_evidence_binary_unsupported", 415);
  }
  if (binary.length >= 4 && binary[0] === 0xff && binary[1] === 0xd8) {
    if (binary.at(-2) !== 0xff || binary.at(-1) !== 0xd9) throw failure("receipt_evidence_binary_unsupported", 415);
    let offset = 2;
    while (offset + 8 < binary.length) {
      if (binary[offset] !== 0xff) { offset += 1; continue; }
      const marker = binary[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = binary.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > binary.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        const width = binary.readUInt16BE(offset + 7);
        const height = binary.readUInt16BE(offset + 5);
        const orientation = jpegOrientation(binary);
        if (jpegHasSensitiveMetadata(binary)) throw failure("receipt_evidence_privacy_metadata_unsupported", 415);
        return [5, 6, 7, 8].includes(orientation) ? dimensions("image/jpeg", height, width, maxPixels) : dimensions("image/jpeg", width, height, maxPixels);
      }
      offset += 2 + length;
    }
    throw failure("receipt_evidence_binary_unsupported", 415);
  }
  throw failure("receipt_evidence_binary_unsupported", 415);
}

function dimensions(contentType, width, height, maxPixels = DEFAULT_MAX_PIXELS) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 20_000 || height > 20_000) {
    throw failure("receipt_evidence_dimension_invalid", 422);
  }
  validatePixels(width, height, maxPixels);
  return { contentType, width, height };
}

function pngMetadata(binary, maxPixels) {
  let offset = 8;
  let width;
  let height;
  let sawIdat = false;
  let sawEnd = false;
  while (offset + 12 <= binary.length) {
    const length = binary.readUInt32BE(offset);
    const type = binary.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (end > binary.length) throw failure("receipt_evidence_binary_unsupported", 415);
    if (offset === 8 && (type !== "IHDR" || length !== 13)) throw failure("receipt_evidence_binary_unsupported", 415);
    if (["eXIf", "tEXt", "zTXt", "iTXt"].includes(type)) throw failure("receipt_evidence_privacy_metadata_unsupported", 415);
    if (type === "IHDR") { width = binary.readUInt32BE(offset + 8); height = binary.readUInt32BE(offset + 12); }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (length !== 0 || end !== binary.length) throw failure("receipt_evidence_binary_unsupported", 415);
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawIdat || !sawEnd) throw failure("receipt_evidence_binary_unsupported", 415);
  return dimensions("image/png", width, height, maxPixels);
}

function jpegHasSensitiveMetadata(binary) {
  let offset = 2;
  while (offset + 4 <= binary.length) {
    if (binary[offset] !== 0xff) { offset += 1; continue; }
    const marker = binary[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = binary.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > binary.length) return true;
    if (marker === 0xe1) {
      const payload = binary.subarray(offset + 4, offset + 2 + length);
      if (payload.subarray(0, 29).toString("ascii").startsWith("http://ns.adobe.com/xap/1.0/")) return true;
      if (payload.subarray(0, 6).toString("ascii") === "Exif\0\0" && exifHasGps(payload)) return true;
    }
    offset += 2 + length;
  }
  return false;
}

function exifHasGps(exif) {
  if (exif.length < 14) return true;
  const tiff = 6;
  const little = exif.subarray(tiff, tiff + 2).toString("ascii") === "II";
  const big = exif.subarray(tiff, tiff + 2).toString("ascii") === "MM";
  if (!little && !big) return true;
  const u16 = (at) => little ? exif.readUInt16LE(at) : exif.readUInt16BE(at);
  const u32 = (at) => little ? exif.readUInt32LE(at) : exif.readUInt32BE(at);
  if (u16(tiff + 2) !== 42) return true;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > exif.length) return true;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > exif.length) return true;
    if (u16(entry) === 0x8825) return true;
  }
  return false;
}

function validatePixels(width, height, maxPixels) {
  if (width * height > maxPixels) throw failure("receipt_evidence_pixel_limit_exceeded", 422);
}

function filesystemCapacity(root) {
  const value = statfsSync(root);
  const availableBytes = Number(value.bavail) * Number(value.bsize);
  // Node reports zero inode counters for filesystems such as NTFS that do not
  // expose POSIX inode accounting. Treat that value as unavailable on Windows,
  // while retaining a real zero as exhaustion on Linux production hosts.
  const reportedInodes = Number(value.ffree);
  const availableInodes = process.platform === "win32" && reportedInodes === 0 ? Number.MAX_SAFE_INTEGER : reportedInodes;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 || !Number.isSafeInteger(availableInodes) || availableInodes < 0) {
    throw failure("receipt_evidence_storage_capacity_unavailable");
  }
  return { availableBytes, availableInodes };
}

function jpegOrientation(binary) {
  let offset = 2;
  while (offset + 10 < binary.length && binary[offset] === 0xff) {
    const marker = binary[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = binary.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > binary.length) break;
    if (marker === 0xe1 && length >= 16 && binary.subarray(offset + 4, offset + 10).toString("ascii") === "Exif\0\0") {
      const tiff = offset + 10;
      const little = binary.subarray(tiff, tiff + 2).toString("ascii") === "II";
      const big = binary.subarray(tiff, tiff + 2).toString("ascii") === "MM";
      if (!little && !big) return 1;
      const u16 = (at) => little ? binary.readUInt16LE(at) : binary.readUInt16BE(at);
      const u32 = (at) => little ? binary.readUInt32LE(at) : binary.readUInt32BE(at);
      if (u16(tiff + 2) !== 42) return 1;
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > binary.length) return 1;
      const count = u16(ifd);
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > binary.length) return 1;
        if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) >= 1) return u16(entry + 8);
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

function jpegContainsExif(binary) {
  if (binary.length < 12 || binary[0] !== 0xff || binary[1] !== 0xd8) return false;
  let offset=2;
  while(offset+10<binary.length&&binary[offset]===0xff){const marker=binary[offset+1];if(marker===0xda||marker===0xd9)break;const length=binary.readUInt16BE(offset+2);if(length<2||offset+2+length>binary.length)break;if(marker===0xe1&&binary.subarray(offset+4,offset+10).toString("ascii")==="Exif\0\0")return true;offset+=2+length;}
  return false;
}

async function* chunks(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) { yield body; return; }
  if (!body || typeof body[Symbol.asyncIterator] !== "function") throw failure("receipt_evidence_binary_required");
  for await (const chunk of body) yield chunk;
}

function validChecksum(value) {
  if (typeof value !== "string" || !SHA256.test(value)) throw failure("receipt_evidence_checksum_invalid");
  return value;
}

function constantEqual(left, right) {
  const a = Buffer.from(left, "ascii");
  const b = Buffer.from(right, "ascii");
  return a.length === b.length && timingSafeEqual(a, b);
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw failure(code);
  return number;
}

function uuid(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw failure("receipt_evidence_scope_invalid");
  return value.toLowerCase();
}

function failure(code, statusCode = 500) {
  return new ReceiptEvidenceStorageError(code, statusCode);
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
