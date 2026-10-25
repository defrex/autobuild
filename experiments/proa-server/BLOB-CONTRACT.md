# Blob provider evidence

Checked 2026-10-25. `data/blobs.rs::BlobReader` now implements whole-object
`put(hash, bytes)` beside the existing read API. S3 emulator round trips and
pinned-SDK request comparisons prove the subset below. No live Vercel
interoperability is claimed.

## Evidence and pinned implementations

The public APIs were checked against the primary
[AWS PutObject reference](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
and [Vercel Blob SDK reference](https://vercel.com/docs/vercel-blob/using-blob-sdk#put).
Vercel documents explicit OIDC credentials, token precedence, access and upload
options; the HTTP request shape below comes from the provider-owned installed
implementation, not an inference from those options.

The repository's `bun.lock` pins **`@vercel/blob` 2.8.0**. Its package metadata
identifies `vercel/storage`, directory `packages/blob`, as the upstream source.
Inspect these installed files relative to the repository root:

- `packages/postgres-store/node_modules/@vercel/blob/dist/index.js`: public `put`
  construction (around line 491) and direct `get` (around line 99).
- `packages/postgres-store/node_modules/@vercel/blob/dist/chunk-YYMLUMXS.js`:
  `resolveBlobAuth` (161), `getApiUrl` (257), `blobFetch` (407), `requestApi` (722),
  `createPutHeaders` (909), `createPutOptions` (937), `createPutMethod` (1467).
  Source-map/original source labels in this provider file identify `src/helpers.ts`,
  `src/api.ts`, `src/put-helpers.ts`, `src/put.ts` and `src/vercel-oidc-token.ts`.

SHA-256 of the checked distribution files:

```text
index.js             49c3427b1f3a04c7d473a4e1e33064dbd9c3459330236078ebad5af6ce4fa162
chunk-YYMLUMXS.js    26f2117c463494a728fe664a071db6106cde4f85d5226dd33b215909cc838047
```

`Cargo.lock` pins **`aws-sdk-s3` 1.155.0**. Its installed provider source
`aws-sdk-s3-1.155.0/src/operation/put_object.rs` constructs a `PUT`, supplies
`Content-Type: application/octet-stream` by default and sets `Content-Length`
when the body length is known (around lines 474–494). The existing Rust client
configuration already supplies region, credentials, optional endpoint/session
credentials and path-style selection. Reuse that configuration for writes;
SDK signing, endpoint resolution, checksum and retry behavior stay SDK-owned.

## Deterministic address and whole-object writes

The TypeScript facades are `packages/postgres-store/src/s3.ts` and `vercel.ts`.
Both use `blobPath`: split the configured prefix on `/`, drop empty segments,
join with `/`, then append the hash with one separator; an empty prefix yields
just the hash. Rust `data/blobs.rs::blob_path` has the same rule. The store owns
SHA-256 content addressing; the provider owns bytes at that deterministic key.
Do not introduce per-upload suffixes, metadata-only updates or a new address
scheme.

The store must await a successful whole-object upload before publishing blob
metadata. A later SQL rollback may leave an unreferenced immutable object. Do
not delete that key as rollback compensation: another committed writer may
already reference the same hash.

### S3-compatible backend

The TypeScript facade sends `PutObjectCommand({Bucket, Key, Body: bytes})` with
no ACL, multipart, append offset or conditional-write option. The Rust equivalent
is the configured client's `put_object`, bucket, complete `blob_path`, and a
byte stream backed by the complete raw byte vector. Never base64-encode the body.
The provider SDK handles the HTTP headers/signature; do not construct a second
S3 signing implementation.

AWS specifies a binary request body and whole-object success, and identifies the
object by bucket/key. Its documented ordinary success is HTTP 200. Concurrent
unconditional writes to the same key replace that key; deterministic hashes make
repeating the same content safe. ACL changes require separate permissions and
are not part of this adapter. These properties are the required subset of
[PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html), not
a request to add directory-bucket append or multipart behavior.

### Vercel Blob backend

The TypeScript facade passes a supported binary **Buffer**, including an empty
Buffer, with `access` from configuration, `addRandomSuffix: false` and
`allowOverwrite: true`. It supplies no `multipart`, image optimization,
`contentType`, `cacheControlMaxAge`, progress callback or `ifMatch` option.
Following the checked SDK's non-multipart branch gives this request:

```text
PUT https://vercel.com/api/blob/?pathname=<URLSearchParams-encoded blob_path>
authorization: Bearer <resolved token>
x-vercel-blob-store-id: <normalized store id>
x-api-version: 12
x-vercel-blob-access: public | private
x-add-random-suffix: 0
x-allow-overwrite: 1
x-api-blob-request-id: <store id>:<milliseconds>:<random hexadecimal suffix>
x-api-blob-request-attempt: 0

<complete original binary bytes>
```

The pathname is a **query parameter**, not an API path segment. Encode it once
with URLSearchParams/form query rules, preserving the decoded normalized prefix
and hash. The API write origin is separate from the blob download origin.
`createPutHeaders` uses `x-content-type` and `x-cache-control-max-age` only when
those options are explicitly set; this facade sets neither. A Buffer has no
implicit HTTP content type in the checked `undici` fetch path. The HTTP client
can supply the ordinary content length for the complete byte body. The SDK's
additional **`x-content-length`** is conditional on upload progress or
`VERCEL_BLOB_USE_X_CONTENT_LENGTH=1`, neither used by this facade normally.

`requestApi` adds the request-id/attempt headers for both auth modes and all
operations. A retry retains the request id and increments the attempt count.
The normal API version is `12`; the SDK also honors its explicit
`VERCEL_BLOB_API_VERSION_OVERRIDE` / `NEXT_PUBLIC_VERCEL_BLOB_API_VERSION_OVERRIDE`
overrides. API URL and alternative proxy headers likewise have SDK environment
escape hatches. They are evidence for isolated request tests, not permission to
silently change the configured production provider endpoint.

Authentication is fully established by this installed SDK for **both** modes:

- An explicit read/write `token` wins over OIDC. The fourth underscore-separated
  field supplies the store id, as on the read path.
- An explicit `oidcToken` is trimmed and paired with trimmed `storeId`; one leading
  `store_` is removed. The JWT itself goes directly into the bearer header and the
  store id goes into `x-vercel-blob-store-id`. **There is no token exchange in this
  put path.** Missing store identity with an explicit OIDC token throws before
  an upload. Explicit OIDC tokens are not automatically refreshed.

The SDK's automatic OIDC branch calls `@vercel/oidc` when no explicit token is
supplied, with environment read/write credentials as its later fallback. Rust's
explicit configured token/OIDC modes need not invent that environment discovery
or exchange protocol. Public and private uploads use the same API endpoint;
`x-vercel-blob-access` conveys access. The
[official authentication options](https://vercel.com/docs/vercel-blob/using-blob-sdk#authentication)
agree with these modes and explicit-token precedence.

`requestApi` accepts a successful HTTP status only after JSON decoding. The
normal JSON response carries `url`, `downloadUrl`, `pathname`, `contentType`,
`contentDisposition` and `etag`; `createPutMethod` projects those fields without
strict field validation. The TypeScript BlobStore discards the returned object.
A success status with invalid/empty JSON is not an SDK success. For unsuccessful
statuses, `getBlobError` reads `error.code` / `error.message` when available and
maps provider errors; unparseable error JSON becomes an unknown error. Network
errors and selected unknown/service errors are retried (`10` retries by default);
access, missing-store, pathname, size and precondition errors are failures, not
successful empty writes. A classified `rate_limited` error carries `retryAfter`
but is bailed out by this request retry loop; do not infer an automatic 429
retry from the retry count alone. Rust must preserve failure/rollback behavior while
keeping provider messages, URLs, bearer tokens and response bodies out of public
errors and logs. Keep the current sanitized provider-error boundary.

## Limits and read interoperability

The pinned SDK rejects an empty pathname, more than **950 JavaScript UTF-16
code units**, or a pathname containing `//`. Prefix normalization removes empty
slash components but is not a general pathname validation or URI encoder.
The hash component remains nonempty. The SDK enters multipart only when
`multipart === true`; the existing facade never requests it. This body path has
no local maximum-size check in the checked `createPutMethod`.

Provider object/multipart limits do not replace application limits. The approved
protocol artifact ceiling is **1 MiB decoded**. Core ticket assets permit
**25 MiB total file bytes per revision** before any deployment-specific encoded
request ceiling narrows that bound. These are local contracts in the core and
hosted-service config. Vercel documents a **5 TB global file maximum**, recommending
multipart above **100 MB**; this does not establish a new buffered-upload limit
for this experiment. See [Vercel size limits](https://vercel.com/docs/vercel-blob/usage-and-pricing#size-limits).

Reads retain their existing contract: the installed SDK uses direct
`https://<store>.<access>.blob.vercel-storage.com/<pathname>` GET with bearer auth,
without API-version/store-id headers or a get-token exchange. Default cache
options add no query parameter. Only 404 is missing. Rust does not follow
credential-bearing redirects and verifies bytes at the data-reader boundary.
S3 reads likewise distinguish missing from denied access. See the primary
[AWS GetObject reference](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
and [Vercel get reference](https://vercel.com/docs/vercel-blob/using-blob-sdk#get).

## Executable write evidence

`tools/protocol-blob-fixtures.ts --generate` runs the actual installed
`@vercel/blob` 2.8.0 facade against an isolated loopback responder. The eight
requests cover token/explicit trimmed OIDC auth, public/private access and
empty/binary Buffers, normalized prefixes and encoded spaces/Unicode. The
committed `fixtures/protocol-blob-provider.json` records selected exact headers,
method, encoded target and all bytes, plus source hashes. The same script without
`--generate` and its colocated unit test detect stale provider sources. Its only
API-origin override is local to fixture generation; the Rust production writer
fixes `https://vercel.com/api/blob/` and accepts no environment API override.

Rust `data::blobs` tests compare actual HTTP requests to all eight SDK oracle
rows. Additional tests inspect the configured S3 bucket/key, raw empty/binary
body, SDK signing and session credentials; reject denied/missing-store/rate-limit
and redirect responses; require parseable non-null successful JSON; enforce the
950 UTF-16 pathname limit; and verify a retry retains its request ID/body while
incrementing the attempt header. Recognized SDK error/message classifications
bail immediately. Network/unknown/service/internal errors retry up to ten times
with exponential backoff. Provider bodies, endpoints and credentials never enter
diagnostics: the adapter exposes `blob storage write failed`, and the machine
router returns a generic internal error. Reads retain their
existing distinct missing-object/error diagnostics.

`tools/protocol-blobs.integration.test.ts::protocolBlobInteroperability` invokes
the private `examples/protocol-blob-proof.rs` against a fresh S3 emulator. Its ten
checks cover Rust put → TypeScript get, TypeScript put → Rust get and repeated
whole-object overwrites for empty bytes, non-UTF8 binary and UTF-8 plus NUL, and a
distinct missing object. The bridge accepts only the isolated loopback emulator
and fixture bucket, has no production HTTP route, and does not connect to a
database. The harness bounds startup/response/exit and tears down its child and
emulator on failure as well as success. The aggregate protocol gate builds and
runs this proof; its sanitized report explicitly records `liveVercel: false`.

`protocol-artifacts.integration.test.ts` and
`protocol-artifact-boundaries.integration.test.ts` separately prove that real S3
NoSuchBucket failure publishes no metadata, including before a stale deposit
comparison. SQL insert and deferred-commit failures after successful upload
consume no visible revision/event sequence, timestamp or change position. A
recovered writer starts at revision zero. These transaction proofs complement
the provider tests; an orphan immutable object after failed SQL is harmless.

A fake Vercel HTTP responder proves request/decoding mechanics only. No live
Vercel credentials were used and no remote Vercel object was written. Live
Vercel interoperability remains unproved until explicitly provisioned
integration evidence exists.

Native ticket assets and stream close use the same configured blob adapter as
artifact deposits. Asset writes validate paths/ceilings and preflight their
manifest response before publishing metadata; snapshot-pin reads additionally
verify gzip/chunk/file integrity. Stream close prepares its immutable object
before publication, then locks and rechecks the acknowledged chunk prefix. A
racing append requires reassembly and another put before the closed state and
artifact revision commit together. Upload or SQL commit failure exposes no
partial close or consumed artifact revision. The stream proof exercises real
S3 failure and the TypeScript writer race, rather than substituting a fake store.

The normal server's deferred backend initialization changes liveness only:
`/health` does not contact storage; configured data operations and `/readyz`
still require schema preflight. Blob credentials remain constructor input and
are never exposed by health, routing errors, capture metadata or evidence logs.

Request and response values now retain JavaScript UTF16 units until an explicit
encoding boundary. Artifact metadata goes to PostgreSQL as exact JSON, so its
server-side failure occurs after the same upload/CAS decisions as TypeScript.
Ticket manifests and stream parts use the source JSONB string envelope and can
retain escaped lone units; compressed snapshot-pin decoding and SDK close bytes
use the lossless model too. Request/response ceilings count the actual source
serialization, including escaped units and replacement-decoded HTTP body bytes.

Legacy string envelopes in other stored fields remain a separate unfinished read
increment, including artifact metadata. See FIELD-NOTES.md and the read-envelope
diagnostic; successful write/provider proofs do not waive that remaining scope.

## Operator artifact publication

Operator uploads use the same transport, endpoint, request identity and retries. Before SQL publication, the adapter additionally requires string url, downloadUrl, pathname, contentType and contentDisposition fields and the exact requested pathname. Build-row locking allocates revisions after upload success. Spec/guidance revisions remain audit inputs; SQL failure leaves an unreferenced object and cannot authorize a spec revision.
