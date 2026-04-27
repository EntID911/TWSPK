const fs = require('fs')
const path = require('path')
const express = require('express')

const app = express()

const REALAB_BASE = 'https://www.realab.com'
const REALAB_JSON_PREFIX = '/nice-json/front-end'
const REALAB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; bot)',
  'Accept': 'application/json, text/plain, */*'
}
const SEARCH_INDEX_TTL_MS = 10 * 60 * 1000
const SEARCH_RESULT_LIMIT = 12
const PRODUCT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const PRODUCT_CACHE_DIR = path.join(__dirname, 'cache', 'products')

const searchIndexCache = {
  loadedAt: 0,
  items: [],
  pending: null
}

fs.mkdirSync(PRODUCT_CACHE_DIR, { recursive: true })

app.use(express.static('public'))

function normalizeSearchText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[()\uFF08\uFF09\[\]\u3010\u3011{}]/g, ' ')
    .replace(/[\\/|+_,.:;'"`~!@#$%^&*?<>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactSearchText(text) {
  return normalizeSearchText(text).replace(/[^0-9a-z\u3400-\u9fff]+/g, '')
}

function splitBrandParts(brandName) {
  return String(brandName || '')
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
}

function stripLeadingBrand(title, brandName) {
  let out = String(title || '').trim()
  const wholeBrand = String(brandName || '').trim()
  const brandParts = splitBrandParts(brandName)

  if (wholeBrand) {
    const lowerOut = out.toLowerCase()
    const lowerWhole = wholeBrand.toLowerCase()
    if (lowerOut.startsWith(lowerWhole + ' ')) {
      out = out.slice(wholeBrand.length).trim()
    }
  }

  brandParts.forEach(part => {
    const lowerOut = out.toLowerCase()
    const lowerPart = part.toLowerCase()
    if (lowerOut.startsWith(lowerPart + ' ')) {
      out = out.slice(part.length).trim()
    }
  })

  return out
}

function buildSearchAliases(title, brandName) {
  const aliases = new Set()
  const brandParts = splitBrandParts(brandName)
  const modelTitle = stripLeadingBrand(title, brandName)

  aliases.add(title)
  aliases.add(brandName)
  aliases.add(modelTitle)

  brandParts.forEach(part => {
    aliases.add(part)
    if (modelTitle) aliases.add(part + ' ' + modelTitle)
  })

  if (modelTitle) {
    aliases.add(modelTitle.replace(/\u652F\u6301\u4E3B\u52A8\u964D\u566A/g, 'ANC'))
    aliases.add(modelTitle.replace(/\u4E0D\u652F\u6301\u4E3B\u52A8\u964D\u566A/g, 'No ANC'))
    aliases.add(modelTitle.replace(/\u4E3B\u52A8\u964D\u566A/g, 'ANC'))
  }

  return Array.from(aliases).filter(Boolean)
}

function createSearchItem(brand, product) {
  const brandName = brand && brand.name ? brand.name : ''
  const searchKeys = buildSearchAliases(product.title, brandName).map(text => ({
    raw: text,
    normalized: normalizeSearchText(text),
    compact: compactSearchText(text)
  }))

  return {
    brandId: brand.id,
    brandName,
    slug: String(product.slug || ''),
    title: String(product.title || ''),
    modelTitle: stripLeadingBrand(product.title, brandName),
    normalizedModel: normalizeSearchText(stripLeadingBrand(product.title, brandName)),
    url: `${REALAB_BASE}/data/${product.slug}.html`,
    searchKeys
  }
}

function orderedSubsequenceScore(haystack, needle) {
  if (!haystack || !needle) return -1

  let cursor = -1
  let spread = 0

  for (const ch of needle) {
    const next = haystack.indexOf(ch, cursor + 1)
    if (next === -1) return -1
    if (cursor !== -1) spread += next - cursor - 1
    cursor = next
  }

  return Math.max(0, needle.length * 6 - spread)
}

function scoreSearchItem(item, query) {
  const normalizedQuery = normalizeSearchText(query)
  const compactQuery = compactSearchText(query)
  if (!normalizedQuery) return -1

  const tokens = normalizedQuery.split(' ').filter(Boolean)
  let best = -1

  item.searchKeys.forEach(key => {
    let score = -1

    if (compactQuery && key.compact === compactQuery) {
      score = 1000
    } else if (key.normalized === normalizedQuery) {
      score = 960
    } else if (compactQuery && key.compact.startsWith(compactQuery)) {
      score = 900 - Math.min(80, key.compact.length - compactQuery.length)
    } else if (key.normalized.startsWith(normalizedQuery)) {
      score = 860 - Math.min(80, key.normalized.length - normalizedQuery.length)
    } else if (compactQuery && key.compact.includes(compactQuery)) {
      score = 780 - key.compact.indexOf(compactQuery)
    } else if (key.normalized.includes(normalizedQuery)) {
      score = 740 - key.normalized.indexOf(normalizedQuery)
    } else if (tokens.length > 1) {
      const matched = tokens.every(token => {
        const compactToken = compactSearchText(token)
        return key.normalized.includes(token) || (compactToken && key.compact.includes(compactToken))
      })
      if (matched) score = 640 + tokens.length * 15
    }

    if (score < 0 && compactQuery) {
      const subsequence = orderedSubsequenceScore(key.compact, compactQuery)
      if (subsequence >= 0) score = 520 + subsequence
    }

    if (score > best) best = score
  })

  if (best < 0) return -1
  if (item.normalizedModel && item.normalizedModel.includes(normalizedQuery)) best += 25
  return best
}

async function fetchRealabText(url) {
  const response = await fetch(url, { headers: REALAB_HEADERS })
  if (!response.ok) {
    throw new Error(`ReaLab request failed (${response.status})`)
  }
  return response.text()
}

function normalizeRealabUrl(input) {
  try {
    const url = new URL(String(input || '').trim())
    const hostname = url.hostname.toLowerCase()
    if (!/^https?:$/.test(url.protocol)) return null
    if (hostname !== 'www.realab.com' && hostname !== 'realab.com') return null

    url.protocol = 'https:'
    url.hostname = 'www.realab.com'
    url.hash = ''
    return url
  } catch (error) {
    return null
  }
}

function getProductCacheFile(url) {
  const slug = path.basename(url.pathname, path.extname(url.pathname)) || 'product'
  const safeSlug = slug.replace(/[^0-9a-z_-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'product'
  return path.join(PRODUCT_CACHE_DIR, safeSlug + '.json')
}

async function readProductCache(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.payload || !parsed.fetched_at) return null
    return parsed
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    return null
  }
}

async function writeProductCache(filePath, sourceUrl, payload) {
  const cacheEntry = {
    source_url: sourceUrl,
    fetched_at: new Date().toISOString(),
    payload
  }

  await fs.promises.writeFile(filePath, JSON.stringify(cacheEntry, null, 2), 'utf8')
  return cacheEntry
}

function isFreshProductCache(cacheEntry) {
  const fetchedAt = Date.parse(cacheEntry && cacheEntry.fetched_at)
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < PRODUCT_CACHE_TTL_MS
}

function extractProductPayloadFromHtml(html) {
  const match = String(html || '').match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]+?\});<\/script>/)
  if (!match) {
    throw new Error('Unable to find product data on the page.')
  }

  const raw = JSON.parse(match[1])
  const dataRoot = raw && raw.Data
  if (!dataRoot) {
    throw new Error('Unexpected ReaLab payload.')
  }

  const { title, brand, data, target_data } = dataRoot
  return { title, brand, data, target_data }
}

async function fetchProductPayload(url) {
  const html = await fetchRealabText(url)
  return extractProductPayloadFromHtml(html)
}

async function fetchRealabJson(endpoint, query = {}) {
  const url = new URL(REALAB_JSON_PREFIX + endpoint, REALAB_BASE)

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  })

  const response = await fetch(url, { headers: REALAB_HEADERS })
  if (!response.ok) {
    throw new Error(`ReaLab search request failed (${response.status})`)
  }

  const json = await response.json()
  if (!json || json.code !== 200 || !Array.isArray(json.data)) {
    throw new Error((json && json.message) || 'Unexpected ReaLab response')
  }

  return json.data
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const current = cursor
      cursor += 1
      if (current >= items.length) return
      results[current] = await mapper(items[current], current)
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker()
  )

  await Promise.all(workers)
  return results
}

async function buildSearchIndex() {
  const brands = await fetchRealabJson('/brand')
  const productLists = await mapWithConcurrency(brands, 8, async brand => {
    const products = await fetchRealabJson('/product', { brand: brand.id })
    return products
      .filter(product => product && product.slug && product.title)
      .map(product => createSearchItem(brand, product))
  })

  return productLists.flat()
}

async function getSearchIndex(forceRefresh = false) {
  const isFresh =
    !forceRefresh &&
    searchIndexCache.items.length > 0 &&
    Date.now() - searchIndexCache.loadedAt < SEARCH_INDEX_TTL_MS

  if (isFresh) return searchIndexCache.items
  if (searchIndexCache.pending) return searchIndexCache.pending

  searchIndexCache.pending = buildSearchIndex()
    .then(items => {
      searchIndexCache.items = items
      searchIndexCache.loadedAt = Date.now()
      return items
    })
    .finally(() => {
      searchIndexCache.pending = null
    })

  return searchIndexCache.pending
}

function searchProducts(items, query) {
  return items
    .map(item => ({ item, score: scoreSearchItem(item, query) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return Number(b.item.slug || 0) - Number(a.item.slug || 0)
    })
    .slice(0, SEARCH_RESULT_LIMIT)
    .map(({ item, score }) => ({
      brand: item.brandName,
      slug: item.slug,
      title: item.title,
      url: item.url,
      score
    }))
}

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (query.length < 2) {
    return res.status(400).json({ error: 'Please enter at least 2 characters.' })
  }

  try {
    const items = await getSearchIndex(req.query.refresh === '1')
    const results = searchProducts(items, query)
    res.json({
      query,
      total: results.length,
      results
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/fetch', async (req, res) => {
  const sourceUrl = normalizeRealabUrl(req.query.url)
  if (!sourceUrl) {
    return res.status(400).json({ error: 'Only realab.com URLs are supported.' })
  }

  const normalizedUrl = sourceUrl.toString()
  const cacheFile = getProductCacheFile(sourceUrl)

  try {
    const cached = await readProductCache(cacheFile)
    if (cached && isFreshProductCache(cached)) {
      return res.json({
        ...cached.payload,
        cache: {
          status: 'hit',
          fetched_at: cached.fetched_at
        }
      })
    }

    try {
      const payload = await fetchProductPayload(normalizedUrl)
      const saved = await writeProductCache(cacheFile, normalizedUrl, payload)

      return res.json({
        ...payload,
        cache: {
          status: cached ? 'refreshed' : 'miss',
          fetched_at: saved.fetched_at
        }
      })
    } catch (error) {
      if (cached && cached.payload) {
        return res.json({
          ...cached.payload,
          cache: {
            status: 'stale',
            fetched_at: cached.fetched_at
          }
        })
      }

      throw error
    }
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

const PORT = Number(process.env.PORT || 3000)

app.listen(PORT, () => console.log(`http://localhost:${PORT}`))
