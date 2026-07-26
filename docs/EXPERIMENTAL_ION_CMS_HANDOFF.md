# Experimental Ion CMS handoff

This integration is private, versioned, and opt-in. Existing REST, MCP, core,
and compiler callers keep the current clone behavior unless they send the exact
`ion-cms-v1` flag on a multi-page clone.

## Start a handoff clone

REST:

```json
{
  "url": "https://example.com/",
  "options": {
    "mode": "multi",
    "experimentalContentHandoff": "ion-cms-v1"
  }
}
```

MCP:

```json
{
  "url": "https://example.com/",
  "options": {
    "mode": "multi",
    "experimentalContentHandoff": "ion-cms-v1"
  }
}
```

Local compiler:

```sh
npm run clone -- https://example.com/ \
  --mode=multi \
  --experimental-content-handoff=ion-cms-v1
```

Any other flag value is rejected. The flag is also rejected in single-page
mode and currently requires the default Next.js framework. Flagged and
unflagged requests use different cache keys.

## Artifact contract

A successful flagged clone includes:

```text
.ion/ditto-content-bundle.json
```

The JSON object has:

- `schema: "ion-cms-v1"` and `version: 1`
- `source`, including the source URL, origin, detected platform, and
  `scope: "entry-links"`
- deterministic `families` for recognized products, collections, pages, and
  articles
- each family's Ion-ready collection key, label, description, import origin,
  route pattern, representative static module, field schema, and extracted
  entries
- a disposition for every in-scope route: `cloned`, `cms`, `passthrough`, or
  `unresolved`
- aggregate `coverage` counts

There are no timestamps or random identifiers in the bundle. Ditto only
extracts same-origin links discovered directly from the entry page, up to 500
links. Content fetches use eight concurrent requests, a 15-second timeout per
request, and a 5 MiB response limit.

Only successfully extracted records receive the `cms` disposition. Routes that
cannot be safely extracted fail closed and retain Ditto's existing
representative-link behavior. Account, cart, checkout, and search routes are
marked as source passthrough where applicable.

## Ion importer requirements

The Ion-side agent should:

1. Verify both `schema === "ion-cms-v1"` and `version === 1`. Stop on any
   unknown schema or version.
2. Call Ion's collection upsert for each item in `families`, passing `key`,
   `label`, `description`, `fieldSchema`, and `origin: "import"`.
3. Upsert each item in `family.entries` by `family.key` plus `entry.slug`: call
   `getEntryBySlug`; create it with `routePath`, `document`, and
   `source: "import"` when absent, or update its draft and route identity when
   present. This makes repeated imports idempotent.
4. Build a dynamic route from `family.routePattern` and use
   `family.template.module` as the static visual reference. Bind the CMS
   document fields to that route's component props.
5. Preserve normal internal links for `cms` and `cloned` routes.
6. Send `passthrough` routes to their `targetUrl`.
7. Leave `unresolved` routes on Ditto's safe representative fallback and report
   them to the user instead of silently creating broken pages.
8. Publish imported entries when the project workflow permits it; public
   dynamic routes only resolve published CMS entries.
9. Report the imported family/item counts and the bundle's coverage counts.

The representative module is a visual source, not yet a prop-driven component.
Ion owns the final extraction of that static page into a reusable dynamic
template and must keep the static representative route working while doing so.

## Expected effect

Ditto still browser-clones only the small set of visually distinct routes
selected by the route planner. Product and collection siblings found on the
landing page are fetched as structured content in bounded parallel and handed
to Ion for CMS-backed dynamic routes. This is the path for making dozens of
landing-page links work without running visual clone/validation loops for every
item.
