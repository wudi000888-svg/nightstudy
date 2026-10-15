import type { FastifyReply, FastifyRequest } from 'fastify';

/** Call only after file identity, digest and MIME have been verified, even for 304. */
export function sendVerifiedAudio(
  req: FastifyRequest,
  reply: FastifyReply,
  bytes: Buffer,
  entry: { fileSha256: string; mimeType: string },
) {
  const etag = `"${entry.fileSha256}"`;
  reply
    .type(entry.mimeType)
    .header('ETag', etag)
    .header('Cache-Control', 'public, max-age=0, must-revalidate')
    .header('Accept-Ranges', 'bytes');
  const condition = req.headers['if-none-match'];
  if (
    condition &&
    condition.length <= 1024 &&
    condition.split(',').some((value) => ['*', etag, `W/${etag}`].includes(value.trim()))
  )
    return reply.status(304).send();
  const range = req.headers.range;
  // HEAD ignores Range. Unsupported/multipart ranges are safely served as a whole.
  if (
    req.method === 'GET' &&
    range &&
    range.length <= 120 &&
    (!req.headers['if-range'] || req.headers['if-range'] === etag)
  ) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      const length = BigInt(bytes.length);
      const first = match[1] ? BigInt(match[1]) : null,
        last = match[2] ? BigInt(match[2]) : null;
      const start = first ?? (last! >= length ? 0n : length - last!);
      const end = first === null || last === null || last >= length ? length - 1n : last;
      if (start >= length || start > end)
        return reply
          .status(416)
          .header('Content-Range', `bytes */${bytes.length}`)
          .header('Content-Length', 0)
          .send();
      const part = bytes.subarray(Number(start), Number(end) + 1);
      return reply
        .status(206)
        .header('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
        .header('Content-Length', part.length)
        .send(part);
    }
  }
  return reply.header('Content-Length', bytes.length).send(bytes);
}
