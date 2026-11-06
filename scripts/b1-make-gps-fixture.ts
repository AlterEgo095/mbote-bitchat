/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  b1-make-gps-fixture — fabrique tests/fixtures/media-gps-sample.jpg
 * ─────────────────────────────────────────────────────────────────────────────
 *  Petit JPEG valide (sharp 4×3) + segment APP1 EXIF assemblé à la main
 *  (TIFF little-endian) contenant : Make, DateTime, et un IFD GPS complet
 *  (GPSVersionID, GPSLatitude/Ref, GPSLongitude/Ref, GPSAltitude/Ref).
 *
 *  C'est la fixture du test « image avec GPS → GPS absent après stripExif »
 *  (directive B1). Rejouable : bun scripts/b1-make-gps-fixture.ts
 *  Vérification intégrée : relit la fixture avec sharp et affiche si l'EXIF
 *  (avec le pointeur GPS 0x8825) est bien présent — le script échoue sinon.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

// ── assemblage TIFF little-endian ───────────────────────────────────────────
type Entry = { tag: number; type: number; count: number; value: number | Uint8Array | bigint };

const TYPE = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 } as const;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

class TiffBuilder {
  private chunks: Buffer[] = [];
  private ifd0Entries: Entry[] = [];
  private gpsEntries: Entry[] = [];
  private dataArea: Buffer[] = [];
  private dataAreaSize = 0;

  addIfd0(e: Entry): void {
    this.ifd0Entries.push(e);
  }
  addGps(e: Entry): void {
    this.gpsEntries.push(e);
  }

  private allocData(bytes: Buffer): number {
    // offsets de la zone de données (relative au début du TIFF, calculée après)
    this.dataArea.push(bytes);
    this.dataAreaSize += bytes.length;
    return -1; // patché après
  }

  build(): Buffer {
    // 1ère passe : tailles
    const ifd0Size = 2 + this.ifd0Entries.length * 12 + 4;
    const gpsIfdOffset = 8 + ifd0Size;
    const gpsSize = 2 + this.gpsEntries.length * 12 + 4;
    const dataStart = gpsIfdOffset + gpsSize;

    // 2e passe : placer les gros champs dans la zone de données, calculer les offsets
    const ifd0Buf = Buffer.alloc(ifd0Size);
    const gpsBuf = Buffer.alloc(gpsSize);
    let dataCursor = dataStart;
    const dataBufs: Buffer[] = [];

    const writeEntry = (buf: Buffer, at: number, e: Entry): void => {
      buf.writeUInt16LE(e.tag, at);
      buf.writeUInt16LE(e.type, at + 2);
      buf.writeUInt32LE(e.count, at + 4);
      const size = TYPE_SIZE[e.type] * e.count;
      if (size <= 4 && e.value instanceof Uint8Array) {
        // inline : copier (pad 0)
        Buffer.from(e.value).copy(buf, at + 8);
      } else if (size <= 4 && typeof e.value === "number") {
        if (e.type === TYPE.SHORT) buf.writeUInt16LE(e.value, at + 8);
        else buf.writeUInt32LE(e.value, at + 8);
      } else if (typeof e.value === "number" && e.value < 0) {
        // valeur négative = offset à patcher (marqueur du builder)
        throw new Error("offset non résolu");
      } else {
        // gros champ : stocker dans la zone de données
        const payload = e.value as Uint8Array;
        const offset = dataCursor;
        dataBufs.push(Buffer.from(payload));
        dataCursor += payload.length;
        if (dataCursor % 2 === 1) {
          dataBufs.push(Buffer.from([0]));
          dataCursor++;
        }
        buf.writeUInt32LE(offset, at + 8);
      }
    };

    // les offsets des pointeurs (GPSInfoIFDPointer) sont connus maintenant
    // layout IFD STRICT : u16 count | n×12 entrées | u32 next-IFD
    ifd0Buf.writeUInt16LE(this.ifd0Entries.length, 0);
    let at = 2;
    for (const e of this.ifd0Entries) {
      if (e.tag === 0x8825) {
        ifd0Buf.writeUInt16LE(e.tag, at);
        ifd0Buf.writeUInt16LE(TYPE.LONG, at + 2);
        ifd0Buf.writeUInt32LE(1, at + 4);
        ifd0Buf.writeUInt32LE(gpsIfdOffset, at + 8);
      } else {
        writeEntry(ifd0Buf, at, e);
      }
      at += 12;
    }
    ifd0Buf.writeUInt32LE(0, at); // next IFD = 0

    gpsBuf.writeUInt16LE(this.gpsEntries.length, 0);
    at = 2;
    for (const e of this.gpsEntries) {
      writeEntry(gpsBuf, at, e);
      at += 12;
    }
    gpsBuf.writeUInt32LE(0, at);

    const header = Buffer.alloc(8);
    header.write("II", 0, "ascii");
    header.writeUInt16LE(42, 2);
    header.writeUInt32LE(8, 4);

    return Buffer.concat([header, ifd0Buf, gpsBuf, ...dataBufs]);
  }
}

const ascii = (s: string): Uint8Array => Buffer.from(s + "\0", "ascii");

function rational(num: number, den: number): Uint8Array {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(num, 0);
  b.writeUInt32LE(den, 4);
  return b;
}

function rationals(...pairs: Array<[number, number]>): Uint8Array {
  return Buffer.concat(pairs.map(([n, d]) => rational(n, d)));
}

function buildExifTiff(): Buffer {
  const b = new TiffBuilder();
  // IFD0 : entrées TRIÉES par tag (exigence TIFF stricte — les parsers
  // libvips/sharp refusent sinon) :
  //   Make 0x010F < Orientation 0x0112 < DateTime 0x0132 < GPS 0x8825
  b.addIfd0({ tag: 0x010f, type: TYPE.ASCII, count: 9, value: ascii("Mbotefix") });
  b.addIfd0({ tag: 0x0112, type: TYPE.SHORT, count: 1, value: 6 }); // rotation 90° CW
  b.addIfd0({ tag: 0x0132, type: TYPE.ASCII, count: 20, value: ascii("2026:01:01 12:00:00") });
  b.addIfd0({ tag: 0x8825, type: TYPE.LONG, count: 1, value: 0 }); // pointeur (patché)
  // GPS IFD
  b.addGps({ tag: 0x0000, type: TYPE.BYTE, count: 4, value: new Uint8Array([2, 3, 0, 0]) });
  b.addGps({ tag: 0x0001, type: TYPE.ASCII, count: 2, value: ascii("N") });
  b.addGps({ tag: 0x0002, type: TYPE.RATIONAL, count: 3, value: rationals([4, 1], [30, 1], [1500, 100]) });
  b.addGps({ tag: 0x0003, type: TYPE.ASCII, count: 2, value: ascii("E") });
  b.addGps({ tag: 0x0004, type: TYPE.RATIONAL, count: 3, value: rationals([15, 1], [18, 1], [0, 1]) });
  b.addGps({ tag: 0x0005, type: TYPE.BYTE, count: 1, value: new Uint8Array([0]) });
  b.addGps({ tag: 0x0006, type: TYPE.RATIONAL, count: 1, value: rational(300, 1) });
  return b.build();
}

// ── assemblage JPEG : SOI + APP1(Exif) + JPEG sharp ─────────────────────────
async function main(): Promise<void> {
  const base = await sharp({
    create: { width: 4, height: 3, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();

  const tiff = buildExifTiff();
  const app1Payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const app1 = Buffer.alloc(4 + app1Payload.length);
  app1.writeUInt16LE(0xe1ff, 0); // marker FFE1 (little-endian sur le disque)
  app1.writeUInt16BE(app1Payload.length + 2, 2); // length BE (spec JPEG)
  Buffer.from([0xff, 0xe1]).copy(app1, 0);
  app1Payload.copy(app1, 4);

  const soi = base.subarray(0, 2); // FFD8
  const rest = base.subarray(2);
  const jpeg = Buffer.concat([soi, app1, rest]);

  mkdirSync(join(process.cwd(), "tests", "fixtures"), { recursive: true });
  const out = join(process.cwd(), "tests", "fixtures", "media-gps-sample.jpg");
  writeFileSync(out, jpeg);

  // ── vérification : sharp voit-il l'EXIF (+ pointeur GPS) ? ──
  const meta = await sharp(jpeg).metadata();
  const exif = meta.exif;
  const hasExif = exif !== undefined && exif.length > 0;
  const hasGpsPointer = hasExif && Buffer.from(exif).includes(Buffer.from([0x25, 0x88])); // u16LE 0x8825
  console.log(JSON.stringify({
    out,
    bytes: jpeg.length,
    hasExif,
    hasGpsPointer,
    orientation: meta.orientation ?? null,
    format: meta.format,
    width: meta.width,
    height: meta.height,
  }));
  if (!hasExif || !hasGpsPointer || meta.orientation !== 6) {
    console.error("FAIL — l'EXIF/GPS/orientation n'est pas lisible par sharp");
    process.exit(1);
  }
  console.log("OK — fixture GPS prête");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
