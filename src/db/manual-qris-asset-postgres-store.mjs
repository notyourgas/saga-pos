import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

export class ManualQrisAssetPostgresStore {
  constructor({ db, clock = () => new Date() } = {}) {
    if (!db?.query || !db?.transaction) throw new Error("manual_qris_asset_db_required");
    this.db = db;
    this.clock = clock;
  }

  async load({ organizationId, outletId }) {
    assertScope(organizationId, outletId);
    const row = (await this.db.query(`select png_bytes,sha256,revision,updated_at
      from sagaops.manual_qris_assets where organization_id=$1 and outlet_id=$2`, [organizationId, outletId])).rows[0];
    return row ? {
      bytes: Buffer.from(row.png_bytes), sha256: row.sha256,
      revision: Number(row.revision), updatedAt: new Date(row.updated_at).toISOString(),
    } : null;
  }

  async replace({ organizationId, outletId, pngBytes, expectedRevision, actorReference }) {
    assertScope(organizationId, outletId);
    const bytes = Buffer.from(pngBytes ?? []);
    if (!validPngStructure(bytes)) throw assetError("manual_qris_png_invalid", 422);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width < 64 || height < 64 || width > 2048 || height > 2048) throw assetError("manual_qris_png_dimensions_invalid", 422);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw assetError("manual_qris_asset_revision_invalid", 422);
    if (!String(actorReference ?? "").trim() || String(actorReference).length > 120) throw assetError("manual_qris_actor_invalid", 422);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const updatedAt = this.clock().toISOString();
    return this.db.transaction(async (tx) => {
      const current = (await tx.query(`select revision from sagaops.manual_qris_assets
        where organization_id=$1 and outlet_id=$2 for update`, [organizationId, outletId])).rows[0];
      if (Number(current?.revision ?? 0) !== expectedRevision) throw assetError("manual_qris_asset_conflict", 409);
      const revision = expectedRevision + 1;
      if (current) await tx.query(`update sagaops.manual_qris_assets set png_bytes=$3,sha256=$4,revision=$5,updated_at=$6,actor_reference=$7
        where organization_id=$1 and outlet_id=$2`, [organizationId, outletId, bytes, sha256, revision, updatedAt, actorReference]);
      else await tx.query(`insert into sagaops.manual_qris_assets
        (organization_id,outlet_id,png_bytes,sha256,revision,updated_at,actor_reference)
        values ($1,$2,$3,$4,$5,$6,$7)`, [organizationId, outletId, bytes, sha256, revision, updatedAt, actorReference]);
      await tx.query(`insert into sagaops.pos_audit_events
        (organization_id,outlet_id,actor_reference,event_type,aggregate_type,payload_redacted)
        values ($1,$2,$3,'payment.manual_qris.asset_replaced','manual_qris_asset',$4::jsonb)`,
      [organizationId, outletId, actorReference, JSON.stringify({ revision, sha256 })]);
      return { revision, sha256, updatedAt, checkoutEnabled: false };
    });
  }
}

function assertScope(organizationId, outletId) {
  if (!UUID.test(String(organizationId)) || !UUID.test(String(outletId))) throw assetError("manual_qris_asset_scope_invalid", 422);
}
function assetError(code, statusCode) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }

function validPngStructure(bytes) {
  if (bytes.length < 57 || bytes.length > 256 * 1024 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return false;
  let offset = 8, hasImageData = false, ended = false, chunks = 0;
  while (offset + 12 <= bytes.length && chunks++ < 1024) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (chunks === 1 && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND" && length !== 0) return false;
    const crcExpected = bytes.readUInt32BE(offset + 8 + length);
    if (pngCrc(bytes.subarray(offset + 4, offset + 8 + length)) !== crcExpected) return false;
    offset += length + 12;
    if (type === "IEND") { ended = true; break; }
  }
  return ended && hasImageData && offset === bytes.length;
}

function pngCrc(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
