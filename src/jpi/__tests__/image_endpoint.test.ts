import { handleJpiImage } from '../image_endpoint'
import { sign } from '../signature'
import { GoogleImageEnv, GoogleImageSearch } from '../../google/image_search'

const SECRET = 'test-secret'
const FIXED_NOW = 1_700_000_000_000

function makeSearch(impl: (q: string) => Promise<string[]>): GoogleImageSearch<GoogleImageEnv> {
  return { image_urls: impl } as unknown as GoogleImageSearch<GoogleImageEnv>
}

async function signedUrl(q: string, t: number = FIXED_NOW): Promise<string> {
  const sig = await sign(SECRET, `${q}:${t}`)
  return `http://x/jpi/img?q=${encodeURIComponent(q)}&t=${t}&sig=${sig}`
}

function makeBucket(obj: { bytes: ArrayBuffer; contentType: string } | null) {
  return {
    get: jest.fn(async () =>
      obj
        ? {
            arrayBuffer: async () => obj.bytes,
            httpMetadata: { contentType: obj.contentType },
          }
        : null,
    ),
    put: jest.fn(async () => undefined),
  }
}

// Returns an image whose body is the URL itself, so tests can tell which
// candidate was served.
function imageByUrl(contentType = 'image/jpeg') {
  return jest.fn(async (u: string) => new Response(u, { status: 200, headers: { 'content-type': contentType } }))
}

describe('handleJpiImage', () => {
  it('returns 405 for non-GET methods', async () => {
    const res = await handleJpiImage(new Request('http://x/jpi/img', { method: 'POST' }), {
      search: makeSearch(async () => []),
      signingSecret: SECRET,
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
  })

  it('returns 400 when q is missing', async () => {
    const res = await handleJpiImage(new Request('http://x/jpi/img'), {
      search: makeSearch(async () => []),
      signingSecret: SECRET,
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when q is empty', async () => {
    const res = await handleJpiImage(new Request('http://x/jpi/img?q='), {
      search: makeSearch(async () => []),
      signingSecret: SECRET,
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when q is whitespace only', async () => {
    const res = await handleJpiImage(new Request('http://x/jpi/img?q=%20%20'), {
      search: makeSearch(async () => []),
      signingSecret: SECRET,
    })
    expect(res.status).toBe(400)
  })

  it('returns 401 when signature params are missing', async () => {
    const res = await handleJpiImage(new Request('http://x/jpi/img?q=neko'), {
      search: makeSearch(async () => []),
      signingSecret: SECRET,
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 when t is not a number', async () => {
    const sig = await sign(SECRET, `neko:abc`)
    const res = await handleJpiImage(new Request(`http://x/jpi/img?q=neko&t=abc&sig=${sig}`), {
      search: makeSearch(async () => []),
      signingSecret: SECRET,
    })
    expect(res.status).toBe(401)
  })

  it('accepts arbitrarily old t (no clock-skew check)', async () => {
    const ancientT = 0
    const fetcher = jest.fn().mockResolvedValue(
      new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    const res = await handleJpiImage(new Request(await signedUrl('neko', ancientT)), {
      search: makeSearch(async () => ['https://example.com/a.png']),
      signingSecret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(res.status).toBe(200)
  })

  it('returns 401 when signature does not match', async () => {
    const res = await handleJpiImage(new Request(`http://x/jpi/img?q=neko&t=${FIXED_NOW}&sig=deadbeef`), {
      search: makeSearch(async () => []),
      signingSecret: SECRET,
    })
    expect(res.status).toBe(401)
  })

  it('redirects to placeholder when search returns empty (signed)', async () => {
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => []),
      signingSecret: SECRET,
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^https:\/\/placehold\.co\//)
  })

  it('proxies image bytes with a browser-like User-Agent (signed)', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      new Response('binary', { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => ['https://example.com/a.png']),
      signingSecret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.com/a.png',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': expect.stringContaining('Mozilla') }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('binary')
  })

  it('picks via pickIndex (injected for determinism)', async () => {
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => ['https://example.com/1.jpg', 'https://example.com/2.jpg']),
      signingSecret: SECRET,
      fetcher: imageByUrl() as unknown as typeof fetch,
      pickIndex: () => 1,
    })
    expect(await res.text()).toBe('https://example.com/2.jpg')
  })

  it('clamps out-of-range pickIndex return values', async () => {
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => ['https://example.com/1.jpg', 'https://example.com/2.jpg']),
      signingSecret: SECRET,
      fetcher: imageByUrl() as unknown as typeof fetch,
      pickIndex: () => 99, // out of range
    })
    expect(await res.text()).toBe('https://example.com/2.jpg')
  })

  it('clamps negative pickIndex return values', async () => {
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => ['https://example.com/1.jpg', 'https://example.com/2.jpg']),
      signingSecret: SECRET,
      fetcher: imageByUrl() as unknown as typeof fetch,
      pickIndex: () => -5,
    })
    expect(await res.text()).toBe('https://example.com/1.jpg')
  })

  it('picks deterministically from q+t when pickIndex is not injected', async () => {
    const urls = ['https://example.com/a.jpg', 'https://example.com/b.jpg', 'https://example.com/c.jpg']
    // 2 回叩く → 同じ q+t なら同じ画像が選ばれる
    const first = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => urls),
      signingSecret: SECRET,
      fetcher: imageByUrl() as unknown as typeof fetch,
    })
    const second = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => urls),
      signingSecret: SECRET,
      fetcher: imageByUrl() as unknown as typeof fetch,
    })
    expect(await first.text()).toBe(await second.text())
  })

  it('falls back to placeholder redirect when search throws (signed)', async () => {
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => {
        throw new Error('boom')
      }),
      signingSecret: SECRET,
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^https:\/\/placehold\.co\//)
  })

  it('falls back to placeholder when upstream content-type is not an allowed image', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
    )
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => ['https://example.com/a.svg']),
      signingSecret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^https:\/\/placehold\.co\//)
  })

  it('falls back to placeholder redirect when fetcher returns not ok (signed)', async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response('', { status: 500 }))
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => ['https://example.com/a.png']),
      signingSecret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^https:\/\/placehold\.co\//)
  })

  describe('selects among the candidates that actually fetched', () => {
    const urls = ['https://a.example/1.png', 'https://b.example/2.png', 'https://c.example/3.png']
    const png = (u: string) => new Response(u, { status: 200, headers: { 'content-type': 'image/png' } })

    it('fetches every candidate in parallel', async () => {
      const resolvers: Array<() => void> = []
      const fetcher = jest.fn(
        (u: string) => new Promise<Response>((resolve) => resolvers.push(() => resolve(png(u)))),
      )
      const pending = handleJpiImage(new Request(await signedUrl('neko')), {
        search: makeSearch(async () => urls),
        signingSecret: SECRET,
        fetcher: fetcher as unknown as typeof fetch,
        pickIndex: () => 0,
      })
      await new Promise((r) => setTimeout(r, 0))
      // All fetches are in flight before any of them resolves.
      expect(fetcher).toHaveBeenCalledTimes(urls.length)
      resolvers.forEach((resolve) => resolve())
      expect((await pending).status).toBe(200)
    })

    it('passes only the candidates that returned a renderable image to pickIndex', async () => {
      const fetcher = jest.fn(async (u: string) => {
        if (u.startsWith('https://a.')) return new Response('', { status: 429 })
        if (u.startsWith('https://b.')) return new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } })
        return png(u)
      })
      const pickIndex = jest.fn(() => 0)
      const res = await handleJpiImage(new Request(await signedUrl('neko')), {
        search: makeSearch(async () => [...urls, 'https://d.example/4.png']),
        signingSecret: SECRET,
        fetcher: fetcher as unknown as typeof fetch,
        pickIndex,
      })
      expect(pickIndex).toHaveBeenCalledWith(['https://c.example/3.png', 'https://d.example/4.png'], `neko:${FIXED_NOW}`)
      expect(await res.text()).toBe('https://c.example/3.png')
    })

    it('treats a throwing fetch as a failed candidate', async () => {
      const fetcher = jest.fn(async (u: string) => {
        if (u.startsWith('https://a.')) throw new Error('network down')
        return png(u)
      })
      const res = await handleJpiImage(new Request(await signedUrl('neko')), {
        search: makeSearch(async () => urls),
        signingSecret: SECRET,
        fetcher: fetcher as unknown as typeof fetch,
        pickIndex: () => 0,
      })
      expect(await res.text()).toBe('https://b.example/2.png')
    })

    it('uses the next valid candidate when reading the picked body fails', async () => {
      const broken = {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => {
          throw new Error('stream reset')
        },
        body: { cancel: jest.fn(async () => undefined) },
      }
      const fetcher = jest.fn(async (u: string) => (u.startsWith('https://a.') ? broken : png(u)))
      const res = await handleJpiImage(new Request(await signedUrl('neko')), {
        search: makeSearch(async () => urls),
        signingSecret: SECRET,
        fetcher: fetcher as unknown as typeof fetch,
        pickIndex: () => 0,
      })
      expect(await res.text()).toBe('https://b.example/2.png')
    })

    it('cancels the bodies of valid candidates that were not served', async () => {
      const cancels: jest.Mock[] = []
      const fetcher = jest.fn(async (u: string) => {
        const cancel = jest.fn(async () => undefined)
        cancels.push(cancel)
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'image/png' }),
          arrayBuffer: async () => new TextEncoder().encode(u).buffer,
          body: { cancel },
        }
      })
      await handleJpiImage(new Request(await signedUrl('neko')), {
        search: makeSearch(async () => urls),
        signingSecret: SECRET,
        fetcher: fetcher as unknown as typeof fetch,
        pickIndex: () => 1,
      })
      expect(cancels.filter((c) => c.mock.calls.length > 0)).toHaveLength(2)
    })

    it('stores the served image in R2 under the original (q, t) key', async () => {
      const bucket = makeBucket(null)
      const waits: Promise<unknown>[] = []
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) }
      const cache = { match: jest.fn(async () => undefined), put: jest.fn(async () => undefined) }
      const originalCaches = (globalThis as any).caches
      ;(globalThis as any).caches = { default: cache }
      const fetcher = jest.fn(async (u: string) => (u.startsWith('https://a.') ? new Response('', { status: 500 }) : png(u)))
      const res = await handleJpiImage(
        new Request(await signedUrl('neko')),
        {
          search: makeSearch(async () => urls),
          signingSecret: SECRET,
          fetcher: fetcher as unknown as typeof fetch,
          pickIndex: () => 0,
          bucket,
        },
        ctx,
      ).finally(() => {
        ;(globalThis as any).caches = originalCaches
      })
      await Promise.all(waits)
      expect(res.status).toBe(200)
      expect(bucket.put).toHaveBeenCalledWith(`neko:${FIXED_NOW}`, expect.any(ArrayBuffer), {
        httpMetadata: { contentType: 'image/png' },
      })
    })

    it('returns the placeholder only after every candidate failed', async () => {
      const many = ['1', '2', '3', '4', '5'].map((n) => `https://x.example/${n}.png`)
      const fetcher = jest.fn(async () => new Response('', { status: 500 }))
      const res = await handleJpiImage(new Request(await signedUrl('neko')), {
        search: makeSearch(async () => many),
        signingSecret: SECRET,
        fetcher: fetcher as unknown as typeof fetch,
        pickIndex: () => 0,
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toMatch(/^https:\/\/placehold\.co\//)
      expect(fetcher).toHaveBeenCalledTimes(many.length)
    })
  })

  it('returns R2-stored bytes without hitting CSE when the object exists', async () => {
    const bytes = new TextEncoder().encode('persisted').buffer as ArrayBuffer
    const bucket = makeBucket({ bytes, contentType: 'image/jpeg' })
    const searchSpy = jest.fn(async () => ['https://example.com/never-called.png'])
    const fetcherSpy = jest.fn()
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: { image_urls: searchSpy } as unknown as GoogleImageSearch<GoogleImageEnv>,
      signingSecret: SECRET,
      bucket,
      fetcher: fetcherSpy as unknown as typeof fetch,
    })
    expect(bucket.get).toHaveBeenCalledWith(`neko:${FIXED_NOW}`)
    expect(searchSpy).not.toHaveBeenCalled()
    expect(fetcherSpy).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(await res.text()).toBe('persisted')
  })

  it('falls through to CSE when R2 object has a disallowed content-type', async () => {
    const bytes = new TextEncoder().encode('<svg/>').buffer as ArrayBuffer
    const bucket = makeBucket({ bytes, contentType: 'image/svg+xml' })
    const fetcher = jest.fn().mockResolvedValue(
      new Response('fresh', { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => ['https://example.com/a.png']),
      signingSecret: SECRET,
      bucket,
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(bucket.get).toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalled() // 上流 fetch にフォールスルー
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('fresh')
  })

  it('falls through to CSE when bucket has no object (no put without ctx)', async () => {
    const bucket = makeBucket(null)
    const fetcher = jest.fn().mockResolvedValue(
      new Response('fresh', { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => ['https://example.com/a.png']),
      signingSecret: SECRET,
      bucket,
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(bucket.get).toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalled()
    expect(bucket.put).not.toHaveBeenCalled() // ctx undefined なので waitUntil 経路に乗らない
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('fresh')
  })

  it('falls through to CSE when bucket.get throws', async () => {
    const bucket = {
      get: jest.fn(async () => {
        throw new Error('R2 down')
      }),
      put: jest.fn(),
    }
    const fetcher = jest.fn().mockResolvedValue(
      new Response('via-cse', { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    const res = await handleJpiImage(new Request(await signedUrl('neko')), {
      search: makeSearch(async () => ['https://example.com/a.png']),
      signingSecret: SECRET,
      bucket,
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('via-cse')
  })
})
