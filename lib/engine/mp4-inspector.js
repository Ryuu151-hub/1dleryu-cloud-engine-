/**
 * 1DLERYU Cloud Engine — MP4 container inspector (pure JS)
 * Extracts structure and basic media metadata without FFmpeg.
 * Does NOT invent quality improvements from metadata alone.
 */

function toU8(input) {
  if (input instanceof Uint8Array) return input;
  if (Buffer.isBuffer(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new Error('Invalid input for inspector');
}

function dvOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

function tagStr(u8, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
}

function parseBoxes(u8, start, end) {
  const boxes = [];
  let pos = start;
  const dv = dvOf(u8);
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos, false);
    const type = tagStr(u8, pos + 4, pos + 8);
    let bodyOffset = pos + 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = Number(dv.getBigUint64(pos + 8, false));
      bodyOffset = pos + 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < 8 || pos + size > end + 8) break; // safety
    boxes.push({ type, start: pos, body: bodyOffset, end: pos + size, size });
    pos += size;
  }
  return boxes;
}

function findChild(u8, parent, type) {
  if (!parent) return null;
  const kids = parseBoxes(u8, parent.body, parent.end);
  return kids.find((x) => x.type === type) || null;
}

function readMvhd(u8, mvhd) {
  if (!mvhd) return null;
  const dv = dvOf(u8);
  const version = u8[mvhd.body];
  let timescale, duration;
  if (version === 1) {
    timescale = dv.getUint32(mvhd.body + 20, false);
    duration = Number(dv.getBigUint64(mvhd.body + 24, false));
  } else {
    timescale = dv.getUint32(mvhd.body + 12, false);
    duration = dv.getUint32(mvhd.body + 16, false);
  }
  return {
    version,
    timescale,
    duration,
    durationMs: timescale ? Math.round((duration / timescale) * 1000) : null,
  };
}

function readTrack(u8, trak) {
  const mdia = findChild(u8, trak, 'mdia');
  const hdlr = mdia && findChild(u8, mdia, 'hdlr');
  let handler = null;
  if (hdlr && hdlr.body + 12 <= hdlr.end) {
    handler = tagStr(u8, hdlr.body + 8, hdlr.body + 12);
  }
  const mdhd = mdia && findChild(u8, mdia, 'mdhd');
  let mediaTimescale = null;
  let mediaDuration = null;
  if (mdhd) {
    const dv = dvOf(u8);
    const v = u8[mdhd.body];
    if (v === 1) {
      mediaTimescale = dv.getUint32(mdhd.body + 20, false);
      mediaDuration = Number(dv.getBigUint64(mdhd.body + 24, false));
    } else {
      mediaTimescale = dv.getUint32(mdhd.body + 12, false);
      mediaDuration = dv.getUint32(mdhd.body + 16, false);
    }
  }

  const minf = mdia && findChild(u8, mdia, 'minf');
  const stbl = minf && findChild(u8, minf, 'stbl');
  const stsd = stbl && findChild(u8, stbl, 'stsd');
  let codec = null;
  let width = null;
  let height = null;
  let sampleRate = null;
  let channels = null;

  if (stsd && stsd.body + 16 <= stsd.end) {
    // first entry starts after version/flags + entry_count
    const entryStart = stsd.body + 8;
    const entryType = tagStr(u8, entryStart + 4, entryStart + 8);
    codec = entryType;
    const dv = dvOf(u8);
    if (handler === 'vide' && entryStart + 32 <= stsd.end) {
      // VisualSampleEntry: width/height at +24/+26 relative to entry
      width = dv.getUint16(entryStart + 24, false);
      height = dv.getUint16(entryStart + 26, false);
    }
    if (handler === 'soun' && entryStart + 28 <= stsd.end) {
      channels = dv.getUint16(entryStart + 16, false);
      // sample rate is fixed16.16 at +24
      sampleRate = dv.getUint32(entryStart + 24, false) >>> 16;
    }
  }

  const stsz = stbl && findChild(u8, stbl, 'stsz');
  let sampleCount = null;
  if (stsz) {
    const dv = dvOf(u8);
    sampleCount = dv.getUint32(stsz.body + 8, false);
  }

  return {
    handler,
    codec,
    width,
    height,
    sampleRate,
    channels,
    mediaTimescale,
    mediaDuration,
    mediaDurationMs:
      mediaTimescale && mediaDuration != null
        ? Math.round((mediaDuration / mediaTimescale) * 1000)
        : null,
    sampleCount,
  };
}

/**
 * Inspect an MP4 buffer. Returns structured metadata.
 */
export function inspectMp4(input) {
  const u8 = toU8(input);
  const top = parseBoxes(u8, 0, u8.byteLength);

  const ftyp = top.find((x) => x.type === 'ftyp');
  const moov = top.find((x) => x.type === 'moov');
  const mdat = top.find((x) => x.type === 'mdat');

  let brands = [];
  if (ftyp && ftyp.body + 8 <= ftyp.end) {
    brands.push(tagStr(u8, ftyp.body, ftyp.body + 4));
    let p = ftyp.body + 8;
    while (p + 4 <= ftyp.end) {
      brands.push(tagStr(u8, p, p + 4));
      p += 4;
    }
  }

  const result = {
    ok: true,
    size: u8.byteLength,
    hasFtyp: !!ftyp,
    hasMoov: !!moov,
    hasMdat: !!mdat,
    brands: brands.filter(Boolean),
    durationMs: null,
    timescale: null,
    tracks: [],
    video: null,
    audio: [],
    warnings: [],
  };

  if (!moov) {
    result.ok = false;
    result.warnings.push('No moov box found — not a valid progressive MP4 or incomplete file.');
    return result;
  }
  if (!mdat) {
    result.warnings.push('No mdat box found — media data may be missing or fragmented.');
  }

  const moovKids = parseBoxes(u8, moov.body, moov.end);
  const mvhd = moovKids.find((x) => x.type === 'mvhd');
  const mv = readMvhd(u8, mvhd);
  if (mv) {
    result.durationMs = mv.durationMs;
    result.timescale = mv.timescale;
  }

  for (const trak of moovKids.filter((x) => x.type === 'trak')) {
    const t = readTrack(u8, trak);
    result.tracks.push(t);
    if (t.handler === 'vide') {
      result.video = {
        codec: t.codec,
        width: t.width,
        height: t.height,
        durationMs: t.mediaDurationMs,
        sampleCount: t.sampleCount,
      };
    } else if (t.handler === 'soun') {
      result.audio.push({
        codec: t.codec,
        sampleRate: t.sampleRate,
        channels: t.channels,
        durationMs: t.mediaDurationMs,
        sampleCount: t.sampleCount,
      });
    }
  }

  if (!result.video) {
    result.warnings.push('No video track detected.');
  }

  return result;
}

export function isValidMp4Structure(input) {
  try {
    const info = inspectMp4(input);
    return info.hasFtyp && info.hasMoov && (info.hasMdat || info.tracks.length > 0);
  } catch {
    return false;
  }
}
