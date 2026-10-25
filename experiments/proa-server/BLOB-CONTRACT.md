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
failure, since denied access cannot establish absence. The read adapter exposes no write or delete method. A separate upload adapter
serves operator artifact deposits. Errors omit provider URLs, response bodies and secrets.

# Operator artifact upload contract

Uploads use SHA-256 of the exact bytes as the object name, below the same
normalized prefix as reads. A provider failure returns no publishable hash.
The SQL artifact transaction runs only after complete upload success, locks the
build parent row, allocates the next revision under that lock, and updates the
build timestamp. Spec/guidance revisions are audit inputs and are not pruned.
An upload whose SQL transaction fails is unreferenced and cannot authorize a
spec revision.

The pinned `@vercel/blob` 2.8.0 `dist/chunk-YYMLUMXS.js` implements `put` as
raw-body `PUT /?pathname=<encoded complete key>` against
`https://blob.vercel-storage.com`. Its API is separate from the read/download
origin. The native adapter sends API version `12`, Bearer authentication,
`x-vercel-blob-store-id` in both token and OIDC modes, the configured
`x-vercel-blob-access`, `x-add-random-suffix: 0`, and
`x-allow-overwrite: 1`. Store-id normalization matches reads. The successful
JSON upload receipt must contain the documented URL, download URL, pathname,
content type and content disposition, with the exact requested pathname.
The local wire-contract tests assert the raw body and headers for both auth
modes, and reject provider failures without exposing their response bodies.
The [Vercel SDK reference](https://vercel.com/docs/vercel-blob/using-blob-sdk)
provides the public `put` authentication, access and response contract; exact
wire header values are pinned to the installed provider source above.

S3 uploads use the official Rust SDK `PutObject` with configured bucket,
complete key, credentials, region, endpoint and path style, and a raw byte
body. [AWS PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
defines whole-object success, so metadata publication follows its successful
response. The isolated operator integration's supplied-spec revision exercises
this path against the real local S3 service.
