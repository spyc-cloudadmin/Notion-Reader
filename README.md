# Notion lesson reader

A small, read-only publishing service for selected Notion lesson trees. It uses one Node.js Cloud Run service, one private Cloud Storage bucket, and two Secret Manager secrets. Student routes only read storage; optional cold-start refreshes call Notion separately from those routes.

**Published lessons are public.** A hard-to-guess URL is not access control. Source Notion permissions do not carry over to this website. Publish only non-sensitive material with no student information. Recursive mode publishes every descendant child page beneath an approved root, so review the entire tree. If school-only access is needed later, add it as a separate, designed phase rather than treating the publish token as student authentication.

## Architecture and storage

- `GET /` lists the configured allowlisted roots.
- `GET /lessons/:slug` reads the applicable root pointer and its completed HTML snapshot.
- `GET /assets/:slug/:version/:filename` serves a mirrored asset from the same bucket.
- `POST /admin/publish/:slug` synchronously publishes one allowlisted root or tree.
- `GET /healthz` checks the application only; it does not call Notion or storage.
- `GET /style.css` serves the stylesheet.

For each root and discovered descendant, objects have this layout:

```text
lessons/<root-slug>/current.json                  # root pointer and discovered page manifest
lessons/<root-slug>/publish-lock.json             # present only during a publish
lessons/<page-slug>/versions/<publish-id>/index.html
lessons/<page-slug>/versions/<publish-id>/assets/...
```

A publish fetches each page and recursively fetches block children with cursor pagination. With `RECURSIVE_PUBLISH=true`, only actual `child_page` descendants are discovered; links, mentions, and linked pages are not followed. Descendant slugs combine a readable title with a short page-ID suffix. All tree snapshots and assets are written before the root's `current.json` pointer changes using a storage generation precondition.

Requests are serialized and retries are bounded. Notion `429`/`529` responses honor `Retry-After`; transient idempotent request failures also have bounded retries. Notion errors, content-limit errors, and storage failures leave the previous current tree untouched. Failed downloads instead produce visible placeholders and a successful response with a warning count.

A storage precondition creates an expiring per-root lock. Only one publisher can hold it. Version IDs make snapshots and assets immutable. Incomplete old versions may remain after failures; they are not public through `current.json`, but still consume storage until manually removed.

With `REFRESH_ON_START=true`, every new Cloud Run instance refreshes each configured root in the background after the HTTP server starts. Students receive existing snapshots while this happens. Cold starts can therefore indirectly cause Notion calls and publishing charges. Enable always-allocated CPU for reliable background completion; otherwise CPU throttling can pause work when no request is active. This is not a periodic scheduler: warm instances do not refresh until a manual publish or a later cold start.

## Supported content

Paragraphs, text formatting, headings, bulleted/numbered lists, read-only to-dos, code with a language label, quotes, dividers, callouts, toggles, tables, images, files, and PDFs are supported. Mentions of allowlisted pages become local lesson links. Standard Notion links containing an allowlisted page ID are also recognized on a best-effort basis; Notion does not guarantee its URL formats. Other HTTP(S) links are labelled external and open in a new tab.

Unsupported blocks produce a visible placeholder and structured log. Discovered child pages become local links; non-allowlisted child pages remain placeholders when recursive mode is off. Linked pages are never crawled. Embeds, bookmarks, audio, and video are rendered as external links rather than loaded third-party content. Consequently, ordinary student page loads have no third-party dependency; following an external link is the student's choice.

The runtime uses Node.js 24 and Notion API version `2026-03-11`. References checked during implementation:

- <https://cloud.google.com/run/docs/runtimes/nodejs>
- <https://developers.notion.com/reference/versioning>
- <https://developers.notion.com/reference/get-block-children>
- <https://developers.notion.com/reference/request-limits>

## Configure lessons

```sh
cp lessons.example.json lessons.json
```

Edit `lessons.json`. Each entry needs a unique lowercase slug, display title, and Notion page UUID:

```json
[
  {
    "slug": "fractions-intro",
    "title": "Introduction to fractions",
    "pageId": "01234567-89ab-cdef-8123-456789abcdef"
  }
]
```

This file is allowlist configuration, not a secret. It is ignored by default so local page IDs are not accidentally committed. The page must be explicitly shared with the integration; being listed here does not grant access.

## Local development

Use a current supported Node.js release (24 recommended; 22 also satisfies the package engine range) and a dedicated test bucket. Do not test against the only copy of important content.

```sh
npm ci
gcloud auth application-default login
export GCS_BUCKET="your-test-bucket"
export LESSONS_CONFIG="$PWD/lessons.json"
export ADMIN_TOKEN="$(openssl rand -base64 48)"
read -rsp "Notion integration token: " NOTION_TOKEN; export NOTION_TOKEN; echo
npm test
npm start
```

Application Default Credentials must be able to read and write objects in the test bucket. In production, Cloud Run instead uses its attached service account, and Cloud Run injects the two secrets from Secret Manager as environment variables. The application does not need Secret Manager API access at runtime beyond Cloud Run's secret injection.

Open <http://localhost:8080>. Publish locally without putting the credential in a URL:

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  http://localhost:8080/admin/publish/fractions-intro
```

## Deploy to Google Cloud

The following commands create resources and incur charges. Choose a region and globally unique bucket name. Keep the bucket dedicated to this app.

```sh
export PROJECT_ID="your-project-id"
export REGION="europe-west1"
export BUCKET="your-globally-unique-lesson-bucket"
export SERVICE="lesson-reader"
export SA="lesson-reader"
export SA_EMAIL="${SA}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "${PROJECT_ID}"
gcloud services enable \
  run.googleapis.com storage.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud storage buckets create "gs://${BUCKET}" \
  --project="${PROJECT_ID}" --location="${REGION}" \
  --uniform-bucket-level-access --public-access-prevention

gcloud iam service-accounts create "${SA}" \
  --display-name="Notion lesson reader"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectUser"
```

`storage.objectUser` permits object read/write/delete only in this dedicated bucket; it does not grant bucket administration. Public Access Prevention and uniform bucket-level access keep snapshots private. The app reads them through its service account.

### Create secrets

Create a Notion **internal integration with read-content capability only**, then create the secrets without placing values on a command line:

```sh
read -rsp "Notion integration token: " NOTION_INPUT; echo
printf '%s' "${NOTION_INPUT}" | gcloud secrets create notion-token --data-file=-
unset NOTION_INPUT

export ADMIN_TOKEN="$(openssl rand -base64 48)"
printf '%s' "${ADMIN_TOKEN}" | gcloud secrets create admin-publish --data-file=-

gcloud secrets add-iam-policy-binding notion-token \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding admin-publish \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor"
```

In Notion, open each approved source page, use its connections/share menu, and add the integration. Share only approved pages. A page that is not shared returns `404`/`403` during publishing. Do not give the integration write capabilities.

### Deploy

```sh
export LESSONS_JSON="$(tr -d '\n' < lessons.json)"
gcloud run deploy "${SERVICE}" \
  --source . --region="${REGION}" \
  --service-account="${SA_EMAIL}" --allow-unauthenticated \
  --set-env-vars="^@^GCS_BUCKET=${BUCKET}@LESSONS_JSON=${LESSONS_JSON}@RECURSIVE_PUBLISH=true@REFRESH_ON_START=true" \
  --set-secrets="NOTION_TOKEN=notion-token:latest,ADMIN_TOKEN=admin-publish:latest" \
  --min-instances=0 --max-instances=3 --concurrency=20 \
  --cpu=1 --memory=256Mi --timeout=300 --no-cpu-throttling

export SERVICE_URL="$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" --format='value(status.url)')"
curl "${SERVICE_URL}/healthz"
```

The alternate `@` delimiter prevents commas in JSON from being interpreted as multiple environment assignments. Avoid `@` in lesson titles or choose a different delimiter using the same `gcloud` escaping syntax. Updating the allowlist requires redeploying the service configuration.

`--allow-unauthenticated` is intentional because published lessons are public. `--max-instances=3` bounds concurrent instances and potential cost, but excess traffic can be queued/throttled and publish requests may contend for CPU. Raise it only if measured demand requires it. Scale-to-zero can cause cold starts. `--no-cpu-throttling` allows cold-start publication to continue without an active request and can increase charges; omit it and set `REFRESH_ON_START=false` if background refresh is not wanted.

### Publish and read

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${SERVICE_URL}/admin/publish/fractions-intro"
```

Then open `${SERVICE_URL}/lessons/fractions-intro`. With recursive mode enabled, the response's `pages` count includes all discovered descendants. Editing Notion changes the public site after a manual publish or the next enabled cold-start refresh. Do not send the admin token to students, put it in browser code, or include it in URLs.

## Limits and security behavior

Defaults: 50 pages per recursive tree, tree depth 8, 1,000 blocks per page, nested block depth 32, 2 MB rendered HTML per page, 10 MB per asset, 50 MB total mirrored assets per tree, 10 seconds per asset download attempt, three redirects, and a 240-second application publication deadline per root. `MAX_TREE_PAGES` and `MAX_TREE_DEPTH` can lower or raise the tree bounds within the application's hard maxima. Cloud Run is configured with a 300-second request timeout and a 300-second lock TTL. `LOCK_TTL_MS` must remain safely greater than `PUBLISH_TIMEOUT_MS`.

A large lesson tree may not fit a synchronous request or cold-start publication window. Split it into smaller allowlisted roots or adjust the bounded settings within the configured request timeout. If reliable publication genuinely needs longer work, that is a separate architectural phase requiring an asynchronous job design; no scheduler or queue is hidden in this app.

Assets require HTTPS and an exact hostname in `ASSET_ALLOWED_HOSTS` (comma-separated). Defaults cover common Notion file hosts. For example, external Unsplash images remain unavailable unless `images.unsplash.com` is explicitly added. Every redirect is revalidated. DNS results are checked and the connection is pinned to a validated public IP to reduce DNS-rebinding/SSRF risk. Private, loopback, link-local, and other non-public addresses are rejected.

Only JPEG, PNG, GIF, and WebP images display inline. Other files download as attachments; active formats such as HTML and SVG are never inlined. Responses use `nosniff` and restrictive Content Security Policy headers. Downloaded HTML or scripts are never executed by the publisher. Timeouts and byte limits apply before and during downloads.

HTML is escaped; raw Notion HTML is not accepted. Student HTML uses `public, max-age=0, must-revalidate` and a version ETag. Assets use one-year immutable caching. There is no application-memory cache, so restarts and scale-to-zero cannot strand content or serve a warm copy indefinitely.

Structured logs contain request IDs, route categories, publish IDs, slugs, block types, and result codes. They intentionally omit authorization headers, tokens, source asset URLs, and request query strings.

## Testing and acceptance coverage

```sh
npm test
npm run check
```

The suite makes real HTTP requests to a local server with in-memory storage and a scripted Notion API. It covers rendering/escaping, safe URLs and IPs, authentication, unknown slugs, rate-limit retry behavior, pagination and nested blocks, recursive descendant discovery, dynamic child routes/assets, cold-start refreshes, local mirrored images, zero Notion calls during repeated/concurrent student visits, edit-before-republish isolation, successful updates, failed-publish rollback, restart persistence, ETag revalidation, and competing publish requests.

For a deployed smoke test:

1. Publish one lesson and confirm its nested content and images.
2. Record the successful `version` in the JSON response.
3. Edit Notion and verify the public lesson does not change.
4. Temporarily revoke the integration's page access and publish; expect an error while the old version remains readable.
5. Restore access, publish, and verify a new version and changed content.
6. Restart/redeploy the Cloud Run service and verify the same snapshot and assets remain readable.
7. Check logs and student responses to confirm no credential exposure.

## Troubleshooting

```sh
gcloud run services logs read "${SERVICE}" --region="${REGION}" --limit=100
```

- `401`: missing/incorrect bearer token; never paste it into a URL.
- `404` when publishing: unknown slug, or Notion has not shared the page with the integration.
- `404` for students: the lesson has no successfully published current snapshot.
- `409`: another publish holds that lesson's lock. A crashed publisher's lock expires after its TTL.
- `413`: block, nesting, or rendered-content limit reached.
- Asset placeholders: inspect `asset_mirrored_failed` logs; check host allowlisting, size, type, source availability, and timeout.
- `502`: Notion request failed after the bounded retry policy; verify integration access and Notion status.
- `504`: the publication deadline or required retry delay exceeded the available time.

Cloud Logging, Cloud Run, Cloud Storage operations/storage/egress, Secret Manager versions/access, Cloud Build, and Artifact Registry can incur charges. This deployment is not claimed to be free.

## Delete the deployment

Deletion is destructive. Export anything you need first, then remove the service, secrets, bucket contents, bucket, and service account:

```sh
gcloud run services delete "${SERVICE}" --region="${REGION}" --quiet
gcloud secrets delete notion-token --quiet
gcloud secrets delete admin-publish --quiet
gcloud storage rm --recursive "gs://${BUCKET}"
gcloud storage buckets delete "gs://${BUCKET}"
gcloud iam service-accounts delete "${SA_EMAIL}" --quiet
unset ADMIN_TOKEN
```

Cloud Build history and Artifact Registry images are separate. Remove the deployment's images/repository in Artifact Registry if no longer needed. APIs may remain enabled without creating these resources again.
