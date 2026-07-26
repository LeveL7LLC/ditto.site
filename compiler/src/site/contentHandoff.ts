import type { CrawlResult } from "../crawl/crawl.js";
import type { CollapsedCollection, RoutePlan } from "../crawl/routeTemplates.js";
import { routeToSegment } from "./generateSite.js";

export const DITTO_CONTENT_BUNDLE_PATH = ".ion/ditto-content-bundle.json";
const FETCH_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ENTRY_LINKS = 500;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

type FieldType = "text" | "textarea" | "date" | "image" | "list" | "boolean" | "reference" | "number" | "select" | "url" | "color";

export type DittoCmsFieldDefinition = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  description?: string;
};

export type DittoContentDocument = {
  title: string;
  publishedAt?: string;
  fields: {
    description?: string;
    heroImageUrl?: string;
    authorName?: string;
    tags?: string[];
    seo?: {
      metaTitle?: string;
      metaDescription?: string;
      ogImageUrl?: string;
      noIndex?: boolean;
    };
    custom?: Record<string, string | number | boolean | string[]>;
  };
  body: string;
};

export type DittoContentEntry = {
  sourceUrl: string;
  routePath: string;
  slug: string;
  document: DittoContentDocument;
};

export type DittoContentFamily = {
  key: "products" | "collections" | "pages" | "articles";
  label: "Products" | "Collections" | "Pages" | "Articles";
  description: string;
  origin: "import";
  kind: "product" | "collection" | "page" | "article";
  routePattern: string;
  indexPath: string | null;
  representativeRoute: string;
  template: { module: string; exportName: "default" };
  fieldSchema: DittoCmsFieldDefinition[];
  entries: DittoContentEntry[];
};

export type DittoRouteDisposition = {
  routePath: string;
  disposition: "cloned" | "cms" | "passthrough" | "unresolved";
  familyKey?: DittoContentFamily["key"];
  targetUrl?: string;
  reason?: string;
};

export type DittoContentBundleV1 = {
  schema: "ion-cms-v1";
  version: 1;
  source: {
    url: string;
    origin: string;
    platform: "shopify" | "unknown";
    scope: "entry-links";
  };
  families: DittoContentFamily[];
  routes: DittoRouteDisposition[];
  coverage: {
    discovered: number;
    cloned: number;
    cms: number;
    passthrough: number;
    unresolved: number;
  };
};

type FamilySpec = Pick<DittoContentFamily, "key" | "label" | "kind" | "fieldSchema">;
type JsonRecord = Record<string, unknown>;

const PRODUCT_FIELDS: DittoCmsFieldDefinition[] = [
  { key: "price", label: "Price", type: "number" },
  { key: "compareAtPrice", label: "Compare-at price", type: "number" },
  { key: "currency", label: "Currency", type: "text" },
  { key: "images", label: "Images", type: "list" },
  { key: "available", label: "Available", type: "boolean" },
  { key: "vendor", label: "Vendor", type: "text" },
  { key: "sku", label: "SKU", type: "text" },
  { key: "sizes", label: "Sizes", type: "list" },
  { key: "sourceUrl", label: "Source URL", type: "url", required: true },
];

const COLLECTION_FIELDS: DittoCmsFieldDefinition[] = [
  { key: "productHandles", label: "Product handles", type: "list" },
  { key: "images", label: "Images", type: "list" },
  { key: "sourceUrl", label: "Source URL", type: "url", required: true },
];

const PAGE_FIELDS: DittoCmsFieldDefinition[] = [
  { key: "sourceUrl", label: "Source URL", type: "url", required: true },
];

function familySpec(collection: CollapsedCollection): FamilySpec | null {
  const first = collection.template.split("/").filter(Boolean)[0]?.toLowerCase();
  if (first === "products") return { key: "products", label: "Products", kind: "product", fieldSchema: PRODUCT_FIELDS };
  if (first === "collections") return { key: "collections", label: "Collections", kind: "collection", fieldSchema: COLLECTION_FIELDS };
  if (first === "pages") return { key: "pages", label: "Pages", kind: "page", fieldSchema: PAGE_FIELDS };
  if (first && ["blog", "blogs", "articles", "news"].includes(first)) {
    return { key: "articles", label: "Articles", kind: "article", fieldSchema: PAGE_FIELDS };
  }
  return null;
}

function nextPattern(template: string): string | null {
  const matches = [...template.matchAll(/:id/g)];
  if (matches.length !== 1) return null;
  return template.replace(":id", "[slug]");
}

function slugOf(routePath: string): string {
  const last = routePath.split("/").filter(Boolean).at(-1) ?? "home";
  const slug = decodeURIComponent(last)
    .replace(/\.[A-Za-z0-9]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "entry";
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap(strings);
}

function firstString(...values: unknown[]): string | undefined {
  return values.flatMap(strings).find(Boolean);
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^0-9.-]/g, "")) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function typesOf(value: JsonRecord): string[] {
  return strings(value["@type"]).map((type) => type.toLowerCase());
}

function allRecords(value: unknown, out: JsonRecord[] = []): JsonRecord[] {
  const valueRecord = record(value);
  if (valueRecord) {
    out.push(valueRecord);
    for (const child of Object.values(valueRecord)) allRecords(child, out);
  } else if (Array.isArray(value)) {
    for (const child of value) allRecords(child, out);
  }
  return out;
}

function jsonLdRecords(html: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  const scripts = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scripts)) {
    const text = match[1]?.trim();
    if (!text) continue;
    try {
      allRecords(JSON.parse(text), records);
    } catch {
      // A malformed third-party block must not discard other usable structured data.
    }
  }
  return records;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "));
}

function attr(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const a = new RegExp(`<meta\\b[^>]*(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']+)["'][^>]*>`, "i").exec(html);
    const b = new RegExp(`<meta\\b[^>]*content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*>`, "i").exec(html);
    const value = a?.[1] ?? b?.[1];
    if (value) return decodeEntities(value);
  }
  return undefined;
}

function titleFromHtml(html: string): string | undefined {
  return attr(html, ["og:title", "twitter:title"]) ?? (() => {
    const value = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    return value ? stripTags(value) : undefined;
  })();
}

function imageUrls(value: unknown): string[] {
  const out: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (/^https?:\/\//i.test(candidate)) out.push(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const candidateRecord = record(candidate);
    if (candidateRecord) visit(candidateRecord.url ?? candidateRecord.contentUrl);
  };
  visit(value);
  return [...new Set(out)];
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function availability(value: unknown): boolean | undefined {
  if (typeof value !== "string") return undefined;
  if (/InStock$/i.test(value)) return true;
  if (/OutOfStock|SoldOut|Discontinued$/i.test(value)) return false;
  return undefined;
}

function offerRecords(node: JsonRecord): JsonRecord[] {
  return allRecords(node.offers).filter((candidate) => typesOf(candidate).some((type) => type.includes("offer")));
}

function productDocument(records: JsonRecord[], html: string, sourceUrl: string): DittoContentDocument | null {
  const product = records.find((candidate) => typesOf(candidate).some((type) => type === "productgroup"))
    ?? records.find((candidate) => typesOf(candidate).some((type) => type === "product"));
  const title = firstString(product?.name, titleFromHtml(html));
  if (!title) return null;
  const variants = allRecords(product?.hasVariant).filter((candidate) => typesOf(candidate).includes("product"));
  const offers = product ? offerRecords(product) : [];
  for (const variant of variants) offers.push(...offerRecords(variant));
  const price = numberValue(offers[0]?.price, offers[0]?.lowPrice, attr(html, ["product:price:amount"]));
  const compareAtPrice = numberValue(product?.compareAtPrice, product?.priceSpecification);
  const currency = firstString(offers[0]?.priceCurrency, attr(html, ["product:price:currency"]));
  const images = [...new Set([
    ...imageUrls(product?.image),
    ...variants.flatMap((variant) => imageUrls(variant.image)),
    ...strings(attr(html, ["og:image", "twitter:image"])),
  ])];
  const availableValues = offers.map((offer) => availability(offer.availability)).filter((value): value is boolean => value !== undefined);
  const brand = record(product?.brand);
  const sizes = [...new Set(variants.flatMap((variant) => strings(
    variant.size ?? variant.name?.toString().match(/\b(?:XXS|XS|S|M|L|XL|XXL|\d{1,2}[A-Z]{1,2})\b/gi) ?? []
  )))];
  const description = firstString(product?.description, attr(html, ["description", "og:description"]));
  const custom: NonNullable<DittoContentDocument["fields"]["custom"]> = { sourceUrl };
  if (price !== undefined) custom.price = price;
  if (compareAtPrice !== undefined) custom.compareAtPrice = compareAtPrice;
  if (currency) custom.currency = currency;
  if (images.length) custom.images = images;
  if (availableValues.length) custom.available = availableValues.some(Boolean);
  const vendor = firstString(brand?.name, product?.brand);
  if (vendor) custom.vendor = vendor;
  const sku = firstString(product?.sku, variants[0]?.sku);
  if (sku) custom.sku = sku;
  if (sizes.length) custom.sizes = sizes;
  return {
    title: stripTags(title),
    fields: {
      ...(description ? { description: stripTags(description) } : {}),
      ...(images[0] ? { heroImageUrl: images[0] } : {}),
      seo: {
        metaTitle: stripTags(title),
        ...(description ? { metaDescription: stripTags(description) } : {}),
        ...(images[0] ? { ogImageUrl: images[0] } : {}),
      },
      custom,
    },
    body: description ? stripTags(description) : "",
  };
}

function itemRecord(value: unknown): JsonRecord | null {
  const valueRecord = record(value);
  return record(valueRecord?.item) ?? valueRecord;
}

function handleFromUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    const productIndex = segments.lastIndexOf("products");
    return productIndex >= 0 ? segments[productIndex + 1] ?? null : null;
  } catch {
    return null;
  }
}

function collectionDocument(records: JsonRecord[], html: string, sourceUrl: string): DittoContentDocument | null {
  const collection = records.find((candidate) => typesOf(candidate).includes("collectionpage"));
  const list = allRecords(collection ?? records).find((candidate) => typesOf(candidate).includes("itemlist"));
  const items = Array.isArray(list?.itemListElement) ? list.itemListElement.map(itemRecord).filter((item): item is JsonRecord => Boolean(item)) : [];
  const title = firstString(collection?.name, list?.name, titleFromHtml(html));
  if (!title) return null;
  const description = firstString(collection?.description, attr(html, ["description", "og:description"]));
  const productHandles = [...new Set(items.map((item) => handleFromUrl(item.url ?? item["@id"])).filter((value): value is string => Boolean(value)))];
  const images = [...new Set([
    ...items.flatMap((item) => imageUrls(item.image)),
    ...strings(attr(html, ["og:image", "twitter:image"])),
  ])];
  return {
    title: stripTags(title),
    fields: {
      ...(description ? { description: stripTags(description) } : {}),
      ...(images[0] ? { heroImageUrl: images[0] } : {}),
      seo: {
        metaTitle: stripTags(title),
        ...(description ? { metaDescription: stripTags(description) } : {}),
        ...(images[0] ? { ogImageUrl: images[0] } : {}),
      },
      custom: {
        sourceUrl,
        ...(productHandles.length ? { productHandles } : {}),
        ...(images.length ? { images } : {}),
      },
    },
    body: description ? stripTags(description) : "",
  };
}

function pageDocument(records: JsonRecord[], html: string, sourceUrl: string, article: boolean): DittoContentDocument | null {
  const wanted = article ? ["article", "blogposting", "newsarticle"] : ["webpage", "aboutpage", "contactpage"];
  const page = records.find((candidate) => typesOf(candidate).some((type) => wanted.includes(type)));
  const title = firstString(page?.headline, page?.name, titleFromHtml(html));
  if (!title) return null;
  const description = firstString(page?.description, attr(html, ["description", "og:description"]));
  const image = firstString(...imageUrls(page?.image), attr(html, ["og:image", "twitter:image"]));
  const author = firstString(record(page?.author)?.name, page?.author);
  const publishedAt = isoDate(page?.datePublished);
  return {
    title: stripTags(title),
    ...(publishedAt ? { publishedAt } : {}),
    fields: {
      ...(description ? { description: stripTags(description) } : {}),
      ...(image ? { heroImageUrl: image } : {}),
      ...(author ? { authorName: author } : {}),
      seo: {
        metaTitle: stripTags(title),
        ...(description ? { metaDescription: stripTags(description) } : {}),
        ...(image ? { ogImageUrl: image } : {}),
      },
      custom: { sourceUrl },
    },
    body: description ? stripTags(description) : "",
  };
}

async function extractEntry(origin: string, routePath: string, spec: FamilySpec): Promise<DittoContentEntry | null> {
  const sourceUrl = origin + (routePath === "/" ? "/" : routePath);
  const response = await fetch(sourceUrl, {
    headers: { "User-Agent": "ditto.site content handoff/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || new URL(response.url).origin !== origin) return null;
  const declaredBytes = Number(response.headers?.get?.("content-length") ?? 0);
  if (declaredBytes > MAX_PAGE_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PAGE_BYTES) return null;
  const html = new TextDecoder().decode(bytes);
  const records = jsonLdRecords(html);
  const document = spec.kind === "product"
    ? productDocument(records, html, sourceUrl)
    : spec.kind === "collection"
    ? collectionDocument(records, html, sourceUrl)
    : pageDocument(records, html, sourceUrl, spec.kind === "article");
  return document ? { sourceUrl, routePath, slug: slugOf(routePath), document } : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) output[index] = await fn(items[index]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return output;
}

function passthroughReason(routePath: string): string | null {
  const first = routePath.split("/").filter(Boolean)[0]?.toLowerCase();
  if (first === "account") return "authenticated account route";
  if (first === "cart" || first === "checkout") return "transactional commerce route";
  if (first === "search") return "source-backed search route";
  return null;
}

export async function buildContentHandoffBundle(params: {
  sourceUrl: string;
  crawl: CrawlResult;
  plan: RoutePlan;
  log?: (event: Record<string, unknown>) => void;
}): Promise<DittoContentBundleV1> {
  const origin = params.crawl.origin;
  const eligibleList = params.crawl.paths
    .filter((path) => (params.crawl.depthByPath[path] ?? Number.POSITIVE_INFINITY) <= 1)
    .sort();
  const eligiblePaths = new Set(eligibleList);
  const unresolved = new Map<string, string>();
  const extractablePaths = new Set(eligibleList.slice(0, MAX_ENTRY_LINKS));
  for (const path of eligibleList.slice(MAX_ENTRY_LINKS)) unresolved.set(path, "entry-link extraction limit exceeded");
  eligiblePaths.add(params.crawl.entryPath);
  extractablePaths.add(params.crawl.entryPath);
  const families: DittoContentFamily[] = [];

  for (const collection of params.plan.collections) {
    const spec = familySpec(collection);
    const routePattern = nextPattern(collection.template);
    const scopedInstances = collection.instances.filter((path) => extractablePaths.has(path)).sort();
    if (!spec || !routePattern || scopedInstances.length === 0) continue;
    const extracted = await mapLimit(scopedInstances, FETCH_CONCURRENCY, async (routePath) => {
      try {
        return await extractEntry(origin, routePath, spec);
      } catch (error) {
        params.log?.({ event: "content_handoff_extract_failed", path: routePath, error: String(error).slice(0, 200) });
        return null;
      }
    });
    const entries = extracted.filter((entry): entry is DittoContentEntry => entry !== null);
    for (let index = 0; index < scopedInstances.length; index += 1) {
      if (!extracted[index]) unresolved.set(scopedInstances[index]!, "structured content extraction failed");
    }
    if (entries.length === 0) continue;
    const representativeDir = routeToSegment(collection.representative).dir;
    families.push({
      ...spec,
      description: `Imported from ${origin} for ${routePattern}`,
      origin: "import",
      routePattern,
      indexPath: collection.listing,
      representativeRoute: collection.representative,
      template: {
        module: `src/app/${representativeDir ? `${representativeDir}/` : ""}page.tsx`,
        exportName: "default",
      },
      entries,
    });
  }

  families.sort((left, right) => left.key.localeCompare(right.key) || left.routePattern.localeCompare(right.routePattern));
  const cmsByPath = new Map<string, DittoContentFamily["key"]>();
  for (const family of families) for (const entry of family.entries) cmsByPath.set(entry.routePath, family.key);
  const clonedPaths = new Set(params.plan.selected.map((route) => route.path));
  const routes: DittoRouteDisposition[] = [...eligiblePaths].sort().map((routePath) => {
    const familyKey = cmsByPath.get(routePath);
    if (familyKey) return { routePath, disposition: "cms", familyKey };
    if (clonedPaths.has(routePath)) return { routePath, disposition: "cloned" };
    const reason = passthroughReason(routePath);
    if (reason) return { routePath, disposition: "passthrough", targetUrl: origin + routePath, reason };
    return { routePath, disposition: "unresolved", reason: unresolved.get(routePath) ?? "no safe cloned or CMS route" };
  });
  const count = (disposition: DittoRouteDisposition["disposition"]) =>
    routes.filter((route) => route.disposition === disposition).length;

  return {
    schema: "ion-cms-v1",
    version: 1,
    source: {
      url: params.sourceUrl,
      origin,
      platform: families.some((family) => family.key === "products" || family.key === "collections") ? "shopify" : "unknown",
      scope: "entry-links",
    },
    families,
    routes,
    coverage: {
      discovered: routes.length,
      cloned: count("cloned"),
      cms: count("cms"),
      passthrough: count("passthrough"),
      unresolved: count("unresolved"),
    },
  };
}
