import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { CrawlResult } from "../src/crawl/crawl.js";
import type { RoutePlan } from "../src/crawl/routeTemplates.js";
import { buildContentHandoffBundle } from "../src/site/contentHandoff.js";
import { buildSiteLinkTargets } from "../src/site/cloneSite.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function productHtml(handle: string): string {
  return `<!doctype html><html><head>
    <title>${handle} – Example Shop</title>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ProductGroup",
      name: `Product ${handle}`,
      description: `Description for ${handle}`,
      image: [`https://cdn.test/${handle}.jpg`],
      brand: { "@type": "Brand", name: "Example" },
      hasVariant: [
        {
          "@type": "Product",
          name: `${handle} XS`,
          sku: `${handle}-xs`,
          size: "XS",
          offers: {
            "@type": "Offer",
            price: "64.00",
            priceCurrency: "USD",
            availability: "https://schema.org/InStock",
          },
        },
      ],
    })}</script>
  </head><body></body></html>`;
}

function collectionHtml(handle: string): string {
  return `<!doctype html><html><head>
    <title>${handle} – Example Shop</title>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `Collection ${handle}`,
      description: `Description for ${handle}`,
      mainEntity: {
        "@type": "ItemList",
        itemListElement: [
          {
            "@type": "ListItem",
            item: {
              "@type": "Product",
              name: "Product alpha",
              url: "https://shop.test/products/alpha",
              image: "https://cdn.test/alpha.jpg",
            },
          },
        ],
      },
    })}</script>
  </head><body></body></html>`;
}

function fixture(): { crawl: CrawlResult; plan: RoutePlan } {
  const paths = [
    "/",
    "/account",
    "/collections/new",
    "/collections/sale",
    "/collections/underwear",
    "/products/alpha",
    "/products/beta",
    "/products/gamma",
  ];
  return {
    crawl: {
      entryUrl: "https://shop.test/",
      entryPath: "/",
      origin: "https://shop.test",
      paths,
      depthByPath: Object.fromEntries(paths.map((path) => [path, path === "/" ? 0 : 1])),
      sourcesByPath: Object.fromEntries(paths.map((path) => [path, path === "/" ? ["entry"] : ["link"]])),
      robotsDisallow: [],
    },
    plan: {
      entry: "/",
      maxRoutes: 12,
      selected: [
        { path: "/", role: "entry", template: "/", depth: 0 },
        { path: "/collections/new", role: "representative", template: "/collections/:id", depth: 2 },
        { path: "/products/alpha", role: "representative", template: "/products/:id", depth: 2 },
      ],
      collections: [
        {
          template: "/collections/:id",
          listing: null,
          representative: "/collections/new",
          siblingProbe: "/collections/sale",
          instanceCount: 3,
          instances: ["/collections/new", "/collections/sale", "/collections/underwear"],
          confirmed: true,
        },
        {
          template: "/products/:id",
          listing: null,
          representative: "/products/alpha",
          siblingProbe: "/products/beta",
          instanceCount: 3,
          instances: ["/products/alpha", "/products/beta", "/products/gamma"],
          confirmed: true,
        },
      ],
      templates: [],
      skipped: [],
    },
  };
}

describe("experimental Ion CMS content handoff", () => {
  it("emits deterministic product and collection groups for entry-page links", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const handle = path.split("/").filter(Boolean).at(-1)!;
      const html = path.startsWith("/products/") ? productHtml(handle) : collectionHtml(handle);
      return {
        ok: true,
        url,
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      } as Response;
    }) as typeof fetch;

    const input = fixture();
    const first = await buildContentHandoffBundle({ sourceUrl: "https://shop.test/", ...input });
    const second = await buildContentHandoffBundle({ sourceUrl: "https://shop.test/", ...input });

    assert.deepEqual(first, second, "the handoff contains no time/randomness");
    assert.equal(first.schema, "ion-cms-v1");
    assert.equal(first.version, 1);
    assert.equal(first.source.platform, "shopify");
    assert.deepEqual(first.families.map((family) => family.key), ["collections", "products"]);
    assert.equal(first.coverage.cms, 6);
    assert.equal(first.coverage.passthrough, 1);
    assert.equal(first.coverage.unresolved, 0);

    const products = first.families.find((family) => family.key === "products")!;
    assert.equal(products.label, "Products");
    assert.equal(products.origin, "import");
    assert.equal(products.routePattern, "/products/[slug]");
    assert.equal(products.entries.length, 3);
    assert.equal(products.entries[1]!.routePath, "/products/beta");
    assert.equal(products.entries[1]!.document.fields.custom?.price, 64);
    assert.deepEqual(products.entries[1]!.document.fields.custom?.sizes, ["XS"]);

    const collections = first.families.find((family) => family.key === "collections")!;
    assert.deepEqual(collections.entries[0]!.document.fields.custom?.productHandles, ["alpha"]);
    assert.equal(
      first.routes.find((route) => route.routePath === "/account")?.disposition,
      "passthrough",
    );
    assert.equal(JSON.stringify(first).includes("capturedAt"), false);
  });

  it("fails closed when extraction cannot produce a content record", async () => {
    globalThis.fetch = (async (input) => ({
      ok: true,
      url: String(input),
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode("<html><body>No metadata</body></html>").buffer,
    }) as Response) as typeof fetch;

    const bundle = await buildContentHandoffBundle({ sourceUrl: "https://shop.test/", ...fixture() });
    assert.equal(bundle.families.length, 0);
    assert.equal(bundle.coverage.cms, 0);
    assert.equal(bundle.coverage.unresolved, 4);
    assert.equal(bundle.coverage.cloned, 3, "captured representatives remain safe static routes");
  });

  it("changes representative rewriting only for explicitly CMS-backed instances", () => {
    const { plan } = fixture();
    const legacy = buildSiteLinkTargets(plan);
    assert.equal(legacy.get("/products/beta"), "/products/alpha");

    const flagged = buildSiteLinkTargets(plan, new Set(["/products/beta"]));
    assert.equal(flagged.get("/products/beta"), "/products/beta");
    assert.equal(flagged.get("/products/gamma"), "/products/alpha", "unextracted routes retain the safe legacy target");
  });
});
