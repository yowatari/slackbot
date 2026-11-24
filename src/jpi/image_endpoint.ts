import { GoogleImageEnv, GoogleImageSearch } from '../google/image_search'
import { isRenderableImageType } from '../lib/image_types'
import { consoleLogger as logger } from '../lib/logger'
import { verify } from './signature'

// Minimal R2 surface we use. Avoids pulling @cloudflare/workers-types'
// R2Bucket type into the function signature (it conflicts with slack-edge's
// type for ExecutionContext when both are imported into the same scope).
export type R2ObjectLike = {
  arrayBuffer(): Promise<ArrayBuffer>
  httpMetadata?: { contentType?: string }
}
export type R2BucketLike = {
  get(key: string): Promise<R2ObjectLike | null>
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
}

export type JpiImageDeps<E extends GoogleImageEnv> = {
  search: GoogleImageSearch<E>
  signingSecret: string
  /**
   * If provided, images are persisted to R2 under `${q}:${t}` so that the same
   * post is rendered with the same image forever — independent of CSE result
   * drift over time or edge cache eviction.
   */
  bucket?: R2BucketLike
  fetcher?: typeof fetch
  /**
   * Returns an index into `urls` (only the candidates that actually returned
   * an image) for the given seed. Default hashes the seed
   * (q+t) with SHA-256, so a given post is rendered the same across all edge
   * colos / users instead of each region rolling its own Math.random(). Once
   * R2 is in front of CSE the index choice only matters for the very first
   * fetch of a (q, t) pair.
   */
  pickIndex?: (urls: string[], seed: string) => Promise<number> | number
}

async function defaultPickIndex(urls: string[], seed: string): Promise<number> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
  const n = new DataView(hash).getUint32(0, false)
  return n % urls.length
}

// Minimal subset of Cloudflare Workers' ExecutionContext we actually need.
// Defined locally to avoid pulling slack-edge's ExecutionContext (no
// passThroughOnException) vs @cloudflare/workers-types' (requires it) into
// the same function signature.
type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void }

const PLACEHOLDER_URL = 'https://placehold.co/240x180/eeeeee/666666.png?text=No+Image'
const UPSTREAM_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const IMAGE_CACHE_CONTROL = 'public, s-maxage=300, max-age=0'
const PLACEHOLDER_CACHE_CONTROL = 'public, s-maxage=60, max-age=0'
type FetchedImage = { buf: ArrayBuffer; contentType: string }
type Candidate = { url: string; res: Response; contentType: string }

// Fetches one candidate and keeps it only if the response is OK and claims a
// Slack-renderable image type. The body is left unread so that candidates we
// end up not serving can be cancelled without downloading them.
async function probeCandidate(fetcher: typeof fetch, q: string, url: string): Promise<Candidate | null> {
  try {
    const res = await fetcher(url, {
      headers: { 'User-Agent': UPSTREAM_USER_AGENT },
    })
    if (!res.ok) {
      logger.warn('handleJpiImage: upstream fetch not ok', { q, url, status: res.status })
      await discardBody(res)
      return null
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (!isRenderableImageType(contentType)) {
      logger.warn('handleJpiImage: upstream content-type not allowed', { q, url, contentType })
      await discardBody(res)
      return null
    }
    return { url, res, contentType }
  } catch (e) {
    logger.warn('handleJpiImage: upstream fetch threw', { q, url, error: String(e) })
    return null
  }
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // Already consumed or errored; nothing left to release.
  }
}

// CSE results often include URLs that don't serve image bytes (rate limits,
// HTML landing pages). Probe every candidate in parallel and choose only among
// the ones that actually returned an image, so one bad link never turns the
// post into a placeholder while a good one exists.
async function selectImage(
  fetcher: typeof fetch,
  q: string,
  urls: string[],
  seed: string,
  pickIndex: (urls: string[], seed: string) => Promise<number> | number,
): Promise<FetchedImage | null> {
  const probed = await Promise.all(urls.map((url) => probeCandidate(fetcher, q, url)))
  const valid = probed.filter((c): c is Candidate => c !== null)
  if (valid.length === 0) return null

  const rawIdx = await pickIndex(
    valid.map((c) => c.url),
    seed,
  )
  const start = Math.max(0, Math.min(valid.length - 1, Math.floor(Number.isFinite(rawIdx) ? rawIdx : 0)))
  // Start from the seeded pick so a given post stays stable; if reading its
  // body fails, walk forward (wrapping) through the other valid candidates.
  let served: FetchedImage | null = null
  for (let i = 0; i < valid.length; i++) {
    const candidate = valid[(start + i) % valid.length]
    if (served) {
      await discardBody(candidate.res)
      continue
    }
    try {
      served = { buf: await candidate.res.arrayBuffer(), contentType: candidate.contentType }
    } catch (e) {
      logger.warn('handleJpiImage: upstream body read failed', { q, url: candidate.url, error: String(e) })
    }
  }
  return served
}

function placeholderResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: PLACEHOLDER_URL,
      'Cache-Control': PLACEHOLDER_CACHE_CONTROL,
    },
  })
}

function imageResponse(buf: ArrayBuffer, contentType: string): Response {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': IMAGE_CACHE_CONTROL,
    },
  })
}

export async function handleJpiImage<E extends GoogleImageEnv>(
  request: Request,
  deps: JpiImageDeps<E>,
  ctx?: WaitUntilContext,
): Promise<Response> {
  const { search, signingSecret, bucket, fetcher = fetch, pickIndex = defaultPickIndex } = deps

  // Cache API only accepts GET; reject other methods early to avoid noisy
  // caches.default.put() exceptions for HEAD/POST/etc.
  if (request.method !== 'GET') {
    return new Response('method not allowed', { status: 405, headers: { Allow: 'GET' } })
  }

  const url = new URL(request.url)
  const q = url.searchParams.get('q')?.trim() ?? ''
  if (!q) {
    return new Response('missing q', { status: 400 })
  }

  const t = url.searchParams.get('t') ?? ''
  const sig = url.searchParams.get('sig') ?? ''
  if (!t || !sig) {
    return new Response('missing signature', { status: 401 })
  }
  if (!Number.isFinite(Number(t))) {
    return new Response('invalid t', { status: 401 })
  }
  if (!(await verify(signingSecret, `${q}:${t}`, sig))) {
    return new Response('invalid signature', { status: 401 })
  }

  // Signature verified — safe to use the request URL as a cache key.
  const respond = (r: Response): Response => {
    if (ctx) {
      ctx.waitUntil(caches.default.put(request, r.clone()))
    }
    return r
  }

  if (ctx) {
    const cached = await caches.default.match(request)
    if (cached) {
      return cached
    }
  }

  // R2 lookup: same (q, t) → same image, forever.
  const objectKey = `${q}:${t}`
  if (bucket) {
    try {
      const obj = await bucket.get(objectKey)
      if (obj) {
        const contentType = obj.httpMetadata?.contentType ?? ''
        // Same rule as upstream — guard against historical entries with missing
        // or non-image metadata that would make Slack reject the block.
        if (!isRenderableImageType(contentType)) {
          logger.warn('handleJpiImage: R2 object content-type not allowed', { q, contentType })
        } else {
          const buf = await obj.arrayBuffer()
          return respond(imageResponse(buf, contentType))
        }
      }
    } catch (e) {
      logger.warn('handleJpiImage: R2 get failed, falling through to CSE', { q, error: String(e) })
    }
  }

  let urls: string[]
  try {
    urls = await search.image_urls(q)
  } catch (e) {
    logger.warn('handleJpiImage: search threw', { q, error: String(e) })
    return respond(placeholderResponse())
  }

  if (urls.length === 0) {
    return respond(placeholderResponse())
  }

  const image = await selectImage(fetcher, q, urls, `${q}:${t}`, pickIndex)
  if (!image) {
    return respond(placeholderResponse())
  }

  if (bucket && ctx) {
    ctx.waitUntil(
      bucket.put(objectKey, image.buf, { httpMetadata: { contentType: image.contentType } }).catch((e: unknown) => {
        logger.warn('handleJpiImage: R2 put failed', { q, error: String(e) })
      }),
    )
  }
  return respond(imageResponse(image.buf, image.contentType))
}
