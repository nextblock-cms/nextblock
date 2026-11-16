// apps/nextblock/lib/storage/presigned-put-client.ts

/**
 * Browser side of a presigned upload (`/api/media/r2-presigned`, `/api/upload/presigned-url`).
 * The URL is signed for one `Content-Length` and one `Content-Type`
 * (lib/storage/presigned-put.ts), and storage answers 403 SignatureDoesNotMatch to a PUT with any
 * other value. So the PUT carries exactly the headers the route returned.
 *
 * `Content-Length` is the one a script cannot set: browsers forbid it and compute it from the
 * body. It is left out of the fetch headers and checked against the file instead, since a URL
 * signed for another size could never succeed. Import-free, so client components can use it.
 */
export function presignedPutFetchHeaders(
  signedHeaders: Record<string, string> | undefined,
  file: Blob,
): Record<string, string> {
  if (!signedHeaders) {
    // A route that names no headers signed none beyond `host`.
    return file.type ? { 'Content-Type': file.type } : {};
  }

  const headers: Record<string, string> = {};
  let signedLength: string | null = null;
  for (const [name, value] of Object.entries(signedHeaders)) {
    if (name.toLowerCase() === 'content-length') {
      signedLength = value;
    } else {
      headers[name] = value;
    }
  }

  if (signedLength !== null && Number(signedLength) !== file.size) {
    throw new Error('The upload URL was signed for a different file size. Select the file again.');
  }
  return headers;
}
