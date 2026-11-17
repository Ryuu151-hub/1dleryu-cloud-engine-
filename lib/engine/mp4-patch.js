/**
 * 1DLERYU Cloud Engine — MP4 patch module (V7 dual-audio style)
 * Server-side pure JavaScript port of the existing 1dleryu V7 engine.
 * Performs container-level restructuring (dual audio track layout).
 * This is NOT a quality re-encode; it does not change pixel data or bitrate.
 */

function toU8(input) {
  if (input instanceof Uint8Array) return input;
  if (Buffer.isBuffer(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new Error('Invalid input for toU8');
}

function dvOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

function tagStr(u8, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
}

function ascii(str) {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i);
  return arr;
}

function hexToU8(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return arr;
}

function parseBoxes(u8, start, end) {
  const boxes = [];
  let pos = start;
  const dv = dvOf(u8);
  while (pos < end) {
    if (pos + 8 > end) break;
    let size = dv.getUint32(pos, false);
    const type = tagStr(u8, pos + 4, pos + 8);
    let bodyOffset = pos + 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(pos + 8, false));
      bodyOffset = pos + 16;
    } else if (size === 0) {
      size = end - pos;
    }
    boxes.push({ type, start: pos, body: bodyOffset, end: pos + size, size });
    pos += size;
  }
  return boxes;
}

function findChild(u8, parentBox, type) {
  if (!parentBox) return null;
  const kids = parseBoxes(u8, parentBox.body, parentBox.end);
  return kids.find((x) => x.type === type) || null;
}

function concatU8(arrs) {
  let len = 0;
  for (const a of arrs) len += a.byteLength;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

function u16(val) {
  const arr = new Uint8Array(2);
  dvOf(arr).setUint16(0, val, false);
  return arr;
}

function u32(val) {
  const arr = new Uint8Array(4);
  dvOf(arr).setUint32(0, val, false);
  return arr;
}

function i32(val) {
  const arr = new Uint8Array(4);
  dvOf(arr).setInt32(0, val, false);
  return arr;
}

function u64(val) {
  const arr = new Uint8Array(8);
  dvOf(arr).setBigUint64(0, BigInt(val), false);
  return arr;
}

function box(type, ...children) {
  const body = concatU8(children);
  const head = new Uint8Array(8);
  const dv = dvOf(head);
  dv.setUint32(0, 8 + body.byteLength, false);
  head.set(ascii(type), 4);
  return concatU8([head, body]);
}

function fullBox(type, version, flags, ...children) {
  const head = new Uint8Array(4);
  head[0] = version;
  head[1] = (flags >> 16) & 0xff;
  head[2] = (flags >> 8) & 0xff;
  head[3] = flags & 0xff;
  return box(type, head, ...children);
}

function readSampleTableOffsets(u8, stbl, mdatBodyStart) {
  const stco = findChild(u8, stbl, 'stco');
  const co64 = findChild(u8, stbl, 'co64');
  const stsz = findChild(u8, stbl, 'stsz');
  if (!stsz) return [];

  const dv = dvOf(u8);
  const szCount = dv.getUint32(stsz.body + 8, false);
  const defSize = dv.getUint32(stsz.body + 4, false);
  const sizes = [];
  if (defSize === 0) {
    for (let i = 0; i < szCount; i++) sizes.push(dv.getUint32(stsz.body + 12 + i * 4, false));
  } else {
    for (let i = 0; i < szCount; i++) sizes.push(defSize);
  }

  const chunkOffsets = [];
  if (stco) {
    const coCount = dv.getUint32(stco.body + 4, false);
    for (let i = 0; i < coCount; i++) chunkOffsets.push(dv.getUint32(stco.body + 8 + i * 4, false));
  } else if (co64) {
    const coCount = dv.getUint32(co64.body + 4, false);
    for (let i = 0; i < coCount; i++)
      chunkOffsets.push(Number(dv.getBigUint64(co64.body + 8 + i * 8, false)));
  }

  const stsc = findChild(u8, stbl, 'stsc');
  const scCount = dv.getUint32(stsc.body + 4, false);
  const scEntries = [];
  for (let i = 0; i < scCount; i++) {
    scEntries.push({
      first: dv.getUint32(stsc.body + 8 + i * 12, false),
      samples: dv.getUint32(stsc.body + 12 + i * 12, false),
    });
  }

  let sampleIdx = 0;
  const out = [];
  for (let i = 0; i < chunkOffsets.length; i++) {
    const chunkNumber = i + 1;
    let samplesInChunk = 1;
    for (let j = scEntries.length - 1; j >= 0; j--) {
      if (chunkNumber >= scEntries[j].first) {
        samplesInChunk = scEntries[j].samples;
        break;
      }
    }
    let currentOffset = chunkOffsets[i];
    for (let s = 0; s < samplesInChunk; s++) {
      if (sampleIdx >= sizes.length) break;
      out.push({
        relOff: currentOffset - mdatBodyStart,
        size: sizes[sampleIdx],
      });
      currentOffset += sizes[sampleIdx];
      sampleIdx++;
    }
  }
  return out;
}

function buildMp4aEntry(trackId, esdsHex, maxBr, avgBr) {
  const head = new Uint8Array(28);
  const dv = dvOf(head);
  dv.setUint32(0, 0, false);
  dv.setUint16(4, 0, false);
  dv.setUint16(6, 1, false);
  dv.setUint32(8, 0, false);
  dv.setUint32(12, 0, false);
  dv.setUint16(16, 2, false);
  dv.setUint16(18, 16, false);
  dv.setUint16(20, 0, false);
  dv.setUint16(22, 0, false);
  dv.setUint32(24, 48000 << 16, false);

  const decConfig = hexToU8(esdsHex);
  const esdsBody = concatU8([
    u32(0),
    new Uint8Array([
      0x03,
      23 + decConfig.byteLength,
      0x00,
      trackId,
      0x00,
      0x04,
      15 + decConfig.byteLength,
      0x40,
      0x15,
      0x00,
      0x00,
      0x00,
      (maxBr >> 24) & 0xff,
      (maxBr >> 16) & 0xff,
      (maxBr >> 8) & 0xff,
      maxBr & 0xff,
      (avgBr >> 24) & 0xff,
      (avgBr >> 16) & 0xff,
      (avgBr >> 8) & 0xff,
      avgBr & 0xff,
      0x05,
      decConfig.byteLength,
    ]),
    decConfig,
    new Uint8Array([0x06, 0x01, 0x02]),
  ]);
  const esds = box('esds', esdsBody);
  const btrt = box('btrt', u32(131072), u32(maxBr), u32(avgBr));
  return box('mp4a', head, esds, btrt);
}

/**
 * Core patch — dual-audio V7 style container rebuild.
 * @param {Uint8Array|Buffer|ArrayBuffer} encodedInput
 * @param {object} [opts]
 * @returns {Uint8Array}
 */
export function patch(encodedInput, opts = {}) {
  const encodedU8 = toU8(encodedInput);
  const dv = dvOf(encodedU8);
  const top = parseBoxes(encodedU8, 0, encodedU8.byteLength);
  const moov = top.find((x) => x.type === 'moov');
  const mdat = top.find((x) => x.type === 'mdat');
  if (!moov || !mdat) {
    throw new Error('Invalid MP4 container (moov/mdat missing).');
  }

  const mdatOrigBody = encodedU8.subarray(mdat.body, mdat.end);
  const moovKids = parseBoxes(encodedU8, moov.body, moov.end);
  const mvhdOrig = moovKids.find((x) => x.type === 'mvhd');
  if (!mvhdOrig) throw new Error('mvhd box not found.');

  const oldMvhdV = encodedU8[mvhdOrig.body];
  const oldMvhdTs =
    oldMvhdV === 0
      ? dv.getUint32(mvhdOrig.body + 12, false)
      : dv.getUint32(mvhdOrig.body + 20, false);

  let videTrak = null;
  let sounTrak = null;
  for (const trak of moovKids.filter((x) => x.type === 'trak')) {
    const mdia = findChild(encodedU8, trak, 'mdia');
    const hdlr = mdia && findChild(encodedU8, mdia, 'hdlr');
    if (!hdlr || hdlr.body + 12 > hdlr.end) continue;
    const sub = tagStr(encodedU8, hdlr.body + 8, hdlr.body + 12);
    if (sub === 'vide' && !videTrak) videTrak = trak;
    if (sub === 'soun' && !sounTrak) sounTrak = trak;
  }

  if (!videTrak) throw new Error('No video track found.');
  if (!sounTrak) throw new Error('No audio track found — V7 dual-audio patch requires audio.');

  // --- Video track copy (adjusted offsets later) ---
  const videMdia = findChild(encodedU8, videTrak, 'mdia');
  const videMinf = findChild(encodedU8, videMdia, 'minf');
  const videStbl = findChild(encodedU8, videMinf, 'stbl');
  const mdatBodyStart = mdat.body;
  const vSamples = readSampleTableOffsets(encodedU8, videStbl, mdatBodyStart);
  const vOrigChunkRelOffs = vSamples.map((s) => s.relOff);

  // Simplified: keep original video trak bytes and only fix stco later
  // For robustness we rebuild audio tracks fully (V7 style) and reuse video structure.

  // Extract original audio samples
  const sounMdia = findChild(encodedU8, sounTrak, 'mdia');
  const sounMinf = findChild(encodedU8, sounMdia, 'minf');
  const sounStbl = findChild(encodedU8, sounMinf, 'stbl');
  const audioSamples = readSampleTableOffsets(encodedU8, sounStbl, mdatBodyStart);
  if (!audioSamples.length) throw new Error('No audio samples found.');

  // Default AAC decoder config (common for 48k stereo) — used when rebuilding dual tracks
  const defaultEsds =
    opts.esdsHex ||
    '1210'; // minimal; real builds may inject fuller config from source
  const maxBr = opts.maxBitrate || 128000;
  const avgBr = opts.avgBitrate || 96000;

  const totalAudioFrames = audioSamples.length;
  // Estimate duration from original timescale
  const audioDurMs = (() => {
    const mdhd = findChild(encodedU8, sounMdia, 'mdhd');
    if (!mdhd) return Math.round((totalAudioFrames * 1024 * 1000) / 48000);
    const v = encodedU8[mdhd.body];
    const ts =
      v === 1
        ? dv.getUint32(mdhd.body + 20, false)
        : dv.getUint32(mdhd.body + 12, false);
    const dur =
      v === 1
        ? Number(dv.getBigUint64(mdhd.body + 24, false))
        : dv.getUint32(mdhd.body + 16, false);
    return ts ? Math.round((dur / ts) * 1000) : Math.round((totalAudioFrames * 1024 * 1000) / 48000);
  })();

  const identityMatrix = new Uint8Array([
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x40, 0x00, 0x00, 0x00,
  ]);

  // Build dual audio tracks
  function buildAudioTrak(trackId, dualStsd) {
    const tkhd = fullBox(
      'tkhd',
      0,
      0x3,
      u32(0),
      u32(0),
      u32(trackId),
      u32(0),
      u32(Math.round(audioDurMs)),
      u32(0),
      u32(0),
      u16(0),
      u16(0),
      u16(0x0100),
      u16(0),
      identityMatrix,
      u32(0),
      u32(0)
    );

    const elst = fullBox('elst', 0, 0, u32(1), u32(Math.round(audioDurMs)), i32(0), u16(1), u16(0));
    const edts = box('edts', elst);

    const mdhd = fullBox(
      'mdhd',
      0,
      0,
      u32(0),
      u32(0),
      u32(48000),
      u32(Math.round((audioDurMs * 48000) / 1000)),
      u16(0x55c4),
      u16(0)
    );
    const hdlr = fullBox(
      'hdlr',
      0,
      0,
      u32(0),
      ascii('soun'),
      u32(0),
      u32(0),
      u32(0),
      ascii('SoundHandler\0')
    );
    const smhd = fullBox('smhd', 0, 0, u16(0), u16(0));
    const dref = fullBox('dref', 0, 0, u32(1), box('url ', u32(1)));
    const dinf = box('dinf', dref);

    const entry1 = buildMp4aEntry(trackId, defaultEsds, maxBr, avgBr);
    const stsd = dualStsd
      ? fullBox('stsd', 0, 0, u32(2), entry1, buildMp4aEntry(trackId + 10, defaultEsds, maxBr, avgBr))
      : fullBox('stsd', 0, 0, u32(1), entry1);

    const stts = fullBox('stts', 0, 0, u32(1), u32(totalAudioFrames), u32(1024));
    const stsc =
      dualStsd && totalAudioFrames > 8
        ? fullBox(
            'stsc',
            0,
            0,
            u32(2),
            u32(1),
            u32(1),
            u32(1),
            u32(totalAudioFrames - 7),
            u32(1),
            u32(2)
          )
        : fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));

    const szBuf = new Uint8Array(totalAudioFrames * 4);
    const szDv = dvOf(szBuf);
    for (let i = 0; i < totalAudioFrames; i++) szDv.setUint32(i * 4, audioSamples[i].size, false);
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(totalAudioFrames), szBuf);
    const stco = fullBox('stco', 0, 0, u32(totalAudioFrames), new Uint8Array(totalAudioFrames * 4));
    const sgpd = fullBox('sgpd', 1, 0, ascii('roll'), u32(2), u32(1), new Uint8Array([0xff, 0xff]));
    const sbgp = fullBox('sbgp', 0, 0, ascii('roll'), u32(1), u32(totalAudioFrames), u32(1));

    const stbl = box('stbl', stsd, stts, stsc, stsz, stco, sgpd, sbgp);
    const minf = box('minf', smhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    return box('trak', tkhd, edts, mdia);
  }

  // Rebuild video trak with corrected stco placeholders
  // For stability we copy the original video trak and only rewrite chunk offsets after layout.
  const videTrakOut = encodedU8.subarray(videTrak.start, videTrak.end);

  const audioTrak1 = buildAudioTrak(2, true);
  const audioTrak2 = buildAudioTrak(3, false);

  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(1000),
    u32(audioDurMs),
    u32(0x00010000),
    u16(0x0100),
    new Uint8Array(10),
    identityMatrix,
    new Uint8Array(24),
    u32(4)
  );

  const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isomiso2avc1mp41'));
  const outMoov = box('moov', mvhd, videTrakOut, audioTrak1, audioTrak2);
  const freeBox = box('free');
  const mdatFullBody = mdatOrigBody;
  const mdatHdr = concatU8([u32(8 + mdatFullBody.byteLength), ascii('mdat')]);
  const mdatBodyFileOffset = ftyp.byteLength + outMoov.byteLength + freeBox.byteLength + 8;

  const moovDv = dvOf(outMoov);
  const traksOut = parseBoxes(outMoov, 8, outMoov.byteLength).filter((x) => x.type === 'trak');

  // Fix video stco
  {
    const stbl = findChild(
      outMoov,
      findChild(outMoov, findChild(outMoov, traksOut[0], 'mdia'), 'minf'),
      'stbl'
    );
    const stco = findChild(outMoov, stbl, 'stco');
    const co64 = findChild(outMoov, stbl, 'co64');
    if (stco) {
      const count = Math.min(vOrigChunkRelOffs.length, (stco.end - (stco.body + 8)) / 4);
      for (let i = 0; i < count; i++) {
        moovDv.setUint32(stco.body + 8 + i * 4, (mdatBodyFileOffset + vOrigChunkRelOffs[i]) >>> 0, false);
      }
    } else if (co64) {
      const count = Math.min(vOrigChunkRelOffs.length, (co64.end - (co64.body + 8)) / 8);
      for (let i = 0; i < count; i++) {
        moovDv.setBigUint64(
          co64.body + 8 + i * 8,
          BigInt(mdatBodyFileOffset + vOrigChunkRelOffs[i]),
          false
        );
      }
    }
  }

  // Fix audio stco for both new tracks
  for (const ati of [1, 2]) {
    const stbl = findChild(
      outMoov,
      findChild(outMoov, findChild(outMoov, traksOut[ati], 'mdia'), 'minf'),
      'stbl'
    );
    const stco = findChild(outMoov, stbl, 'stco');
    if (!stco) continue;
    for (let i = 0; i < totalAudioFrames; i++) {
      moovDv.setUint32(
        stco.body + 8 + i * 4,
        (mdatBodyFileOffset + audioSamples[i].relOff) >>> 0,
        false
      );
    }
  }

  return concatU8([ftyp, outMoov, freeBox, mdatHdr, mdatFullBody]);
}

export const PATCH_VERSION = 7;
export const PATCH_MODE = 'v7-dual-audio';
export const PATCH_NAME = 'V7Patch';
