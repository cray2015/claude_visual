// SPDX-License-Identifier: Apache-2.0
'use strict';

// Minimal multipart/form-data parser over a fully-buffered request body.
// Hand-rolled to keep this project at zero dependencies: the only client is the
// upload page served from the same process, on the LAN, behind a shared token.

function parseHeaders(raw) {
  const out = {};
  for (const line of raw.split('\r\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// Pulls name / filename out of a Content-Disposition value.
function parseDisposition(value) {
  const out = { name: null, filename: null };
  if (!value) return out;
  for (const attr of ['name', 'filename']) {
    // RFC 5987 form first (filename*=UTF-8''foo.jpg), then the plain quoted form.
    const ext = new RegExp(attr + "\\*=([^']*)'[^']*'([^;]+)", 'i').exec(value);
    if (ext) {
      try {
        out[attr] = decodeURIComponent(ext[2]);
        continue;
      } catch { /* fall through to the plain form */ }
    }
    const plain = new RegExp(attr + '="([^"]*)"', 'i').exec(value)
      || new RegExp(attr + '=([^;]+)', 'i').exec(value);
    if (plain) out[attr] = plain[1].trim();
  }
  return out;
}

function boundaryFrom(contentType) {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return m ? (m[1] || m[2]).trim() : null;
}

// Returns [{ name, filename, contentType, data }]
function parse(buffer, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary);

  let pos = buffer.indexOf(delim);
  if (pos === -1) return parts;
  pos += delim.length;

  while (pos < buffer.length) {
    // A boundary is followed either by "--" (final) or CRLF then part headers.
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;

    const headerEnd = buffer.indexOf('\r\n\r\n', pos, 'latin1');
    if (headerEnd === -1) break;
    const headers = parseHeaders(buffer.toString('latin1', pos, headerEnd));
    const bodyStart = headerEnd + 4;

    const next = buffer.indexOf(delim, bodyStart);
    if (next === -1) break;

    // The CRLF immediately before a boundary belongs to the delimiter, not the body.
    let bodyEnd = next;
    if (buffer[bodyEnd - 2] === 0x0d && buffer[bodyEnd - 1] === 0x0a) bodyEnd -= 2;

    const disp = parseDisposition(headers['content-disposition']);
    parts.push({
      name: disp.name,
      filename: disp.filename,
      contentType: headers['content-type'] || null,
      data: buffer.subarray(bodyStart, bodyEnd),
    });

    pos = next + delim.length;
  }

  return parts;
}

module.exports = { parse, boundaryFrom };
