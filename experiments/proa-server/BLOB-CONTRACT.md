# Read adapter provider evidence

The implementation was checked against installed `@vercel/blob` **2.8.0**, pinned
by the repository's `bun.lock`, in `dist/index.js` (`get`) and
`dist/chunk-YYMLUMXS.js` (`resolveBlobAuth`, `constructBlobUrl`). Its read path
resolves the fourth underscore-separated field of a read/write token as store
id. Explicit OIDC uses `storeId` with an optional `store_` prefix removed.
There is **no OIDC token exchange for get**: both auth modes send
`authorization: Bearer <token>` directly. Both public and private reads use
`https://<store>.<access>.blob.vercel-storage.com/<pathname>`; `get` sends no
`x-api-version` or store-id header (those belong to the separate API request
path). Default cache behavior adds no query parameter. A 404 returns missing;
other unsuccessful responses throw. The Rust retrieval follows this path,
uses metadata's hash under the normalized configured prefix, and returns bytes.
It does not follow redirects with bearer credentials.

Primary provider references checked during implementation:

- https://vercel.com/docs/vercel-blob/using-blob-sdk#get
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html

S3 uses the official Rust AWS SDK GetObject with bucket and complete key,
explicit configured region/credentials, optional endpoint/session token and
path-style selection. Only NoSuchKey/404 becomes missing; 403 remains a storage
failure, since denied access cannot establish absence. Neither backend exposes
a write or delete method. Errors omit provider URLs, response bodies and secrets.
