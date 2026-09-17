/**
 * Builds the stock image library the generator draws from.
 *
 * Run once, not per generation. Everything the pipeline needs at run time is an
 * index in S3 and the images beside it — nothing reaches a third party while a
 * user is waiting, and nothing about their brief leaves the region. That is the
 * whole reason this exists as a collection step rather than a search call.
 *
 * Only CC0 is collected. It is the one licence that permits redistribution with
 * no conditions attached, and redistribution is exactly what this does: the
 * images are mirrored into our bucket, embedded in generated pages, published on
 * a URL, and handed over inside a downloadable project. Licences that merely
 * permit "free use" — Unsplash's, Pixabay's — forbid precisely that, which is
 * why neither is a source here.
 *
 *   node scripts/curate-images.mjs --limit 50 --dry-run
 *   node scripts/curate-images.mjs --limit 50
 *   node scripts/curate-images.mjs                 # the full set
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { execSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';

import { SUBJECTS } from './subjects.mjs';

/**
 * The library is indexed by subject, not by category.
 *
 * The seven coarse categories this replaces were the reason a storefront selling
 * butter got a photograph of a shelf and every T-shirt on the page was
 * illustrated with an office desk: "product" is not a thing anyone can take a
 * picture of. A matcher cannot recover from a library that does not contain the
 * subject, so the fix starts with collecting subjects.
 */

/** Below this the image is a thumbnail; a hero band needs real pixels. */
const MIN_WIDTH = 900;
/** Panoramas and tall strips do not crop into a card or a hero. */
const MIN_ASPECT = 0.55;
const MAX_ASPECT = 2.4;
/** Bytes. Above this it is a print-resolution file we would be paying to serve. */
const MAX_BYTES = 2_000_000;
/** Openverse caps anonymous paging here, and says so in the response. */
const MAX_PAGE_DEPTH = 240;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const DRY_RUN = flag('dry-run');
const TOTAL_LIMIT = Number(value('limit', 0)) || Infinity;
const PER_QUERY = Number(value('per-query', 4));
const ONLY = value('subject', '');
/** Resume a partial run without re-downloading: subjects already at this depth are skipped. */
const SKIP_EXISTING = flag('skip-existing');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One page of results, CC0 only.
 *
 * The user agent is set deliberately. Openverse is a free service run by a
 * non-profit and asks that clients identify themselves; a script that hammers it
 * anonymously is the reason rate limits get tightened for everyone.
 */
async function search(query, page, pageSize) {
  const url =
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}` +
    `&license=cc0&page_size=${pageSize}&page=${page}&mature=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'MakeUI-image-curation/1.0' } });
  if (!res.ok) {
    if (res.status === 429) {
      console.log('    rate limited; waiting 30s');
      await sleep(30_000);
      return search(query, page, pageSize);
    }
    throw new Error(`openverse ${res.status} for "${query}" page ${page}`);
  }
  return res.json();
}

/**
 * Whether a result is worth keeping, judged before anything is downloaded.
 *
 * The sensitivity checks are not optional. This library ends up inside mockups
 * shown to customers, and "the tool put that on the slide" is not a sentence
 * anyone wants to say.
 */
function usable(r) {
  if (!r.url || !r.width || !r.height) return false;
  if (r.license !== 'cc0') return false;             // the filter is not trusted blindly
  if (r.mature) return false;
  if (Array.isArray(r.unstable__sensitivity) && r.unstable__sensitivity.length > 0) return false;
  if (r.width < MIN_WIDTH) return false;
  const aspect = r.width / r.height;
  return aspect >= MIN_ASPECT && aspect <= MAX_ASPECT;
}

/** Tags worth keeping as search terms: words, not machine noise. */
function tagsOf(r) {
  return [...new Set((r.tags ?? [])
    .map((t) => String(t.name || '').toLowerCase().trim())
    .filter((t) => t.length >= 3 && t.length <= 24 && /^[a-z][a-z0-9 -]*$/.test(t)))]
    .slice(0, 12);
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'MakeUI-image-curation/1.0' }, redirect: 'follow' });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES || buf.byteLength < 8_000) return null;
  return { buf, type };
}

const main = async () => {
  // Through the CLI rather than a new SDK client: every deploy script in this
  // repo already depends on it, and one identity lookup does not justify
  // another package in the bundle's dependency tree.
  const bucket =
    process.env.OUTPUT_BUCKET_NAME ||
    `makeui-outputs-${execSync('aws sts get-caller-identity --query Account --output text').toString().trim()}`;
  const s3 = new S3Client({ region: REGION });

  console.log(`bucket: ${bucket}`);
  console.log(`mode:   ${DRY_RUN ? 'dry run (nothing uploaded)' : 'uploading'}`);
  console.log(`limit:  ${TOTAL_LIMIT === Infinity ? 'none' : TOTAL_LIMIT} total, ${PER_QUERY} per query\n`);

  const index = [];
  const seenId = new Set();
  const seenUrl = new Set();
  let rejected = { filtered: 0, duplicate: 0, download: 0 };

  /**
   * Resume rather than restart.
   *
   * A full collection is a hundred subjects against a rate-limited free API, so
   * it is measured in tens of minutes and any interruption used to mean starting
   * from nothing — and re-downloading images already sitting in the bucket.
   */
  if (SKIP_EXISTING && !DRY_RUN) {
    try {
      const res = await fetch(`https://${process.env.CLOUDFRONT_DOMAIN}/stock/index.json`);
      const prev = res.ok ? await res.json() : { images: [] };
      for (const img of prev.images ?? []) {
        if (!img.subject) continue;   // pre-taxonomy entries are not carried forward
        index.push(img);
        seenId.add(img.id);
      }
      console.log(`resuming with ${index.length} already collected\n`);
    } catch {
      console.log('no previous index to resume from\n');
    }
  }
  const have = (subject) => index.filter((i) => i.subject === subject).length;

  for (const [subject, { category, queries }] of Object.entries(SUBJECTS)) {
    if (ONLY && ONLY !== subject) continue;
    if (index.length >= TOTAL_LIMIT) break;
    if (SKIP_EXISTING && have(subject) >= PER_QUERY * queries.length) {
      continue;
    }
    console.log(`── ${category}/${subject}`);

    for (const query of queries) {
      if (index.length >= TOTAL_LIMIT) break;
      let kept = 0;

      for (let page = 1; kept < PER_QUERY && page * 20 <= MAX_PAGE_DEPTH; page++) {
        let data;
        try {
          data = await search(query, page, 20);
        } catch (e) {
          console.log(`    "${query}" page ${page}: ${e.message}`);
          break;
        }
        const results = data.results ?? [];
        if (results.length === 0) break;

        for (const r of results) {
          if (kept >= PER_QUERY || index.length >= TOTAL_LIMIT) break;
          if (!usable(r)) { rejected.filtered++; continue; }
          if (seenId.has(r.id) || seenUrl.has(r.url)) { rejected.duplicate++; continue; }
          seenId.add(r.id);
          seenUrl.add(r.url);

          const got = DRY_RUN ? { buf: Buffer.alloc(0), type: 'image/jpeg' } : await download(r.url);
          if (!got) { rejected.download++; continue; }

          const ext = got.type.includes('png') ? 'png' : got.type.includes('webp') ? 'webp' : 'jpg';
          // Keyed by subject so the bucket itself is browsable and a wrong
          // picture can be found and deleted by the name of what it should be.
          const key = `stock/${subject}/${r.id}.${ext}`;

          if (!DRY_RUN) {
            await s3.send(new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: got.buf,
              ContentType: got.type,
              // The library is immutable once curated, and every generated page
              // will reference it. A year is not optimistic here.
              CacheControl: 'public, max-age=31536000, immutable',
            }));
          }

          index.push({
            id: r.id,
            subject,
            category,
            key,
            width: r.width,
            height: r.height,
            aspect: Math.round((r.width / r.height) * 100) / 100,
            title: (r.title || '').slice(0, 120),
            tags: tagsOf(r),
            query,
            // Provenance, kept so the licence of every image can be re-checked
            // later without re-deriving it. Openverse reports what the source
            // declares; it does not verify, so being able to audit matters.
            license: r.license,
            licenseUrl: r.license_url,
            creator: r.creator || '',
            source: r.source || '',
            sourceUrl: r.foreign_landing_url || '',
            attribution: (r.attribution || '').slice(0, 300),
          });
          kept++;
          process.stdout.write(`\r    ${index.length} collected  (${subject}: "${query}")        `);
        }
        // Openverse is free and unmetered for us; this is the courtesy that keeps
        // it that way.
        await sleep(400);
      }
      process.stdout.write('\n');
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    count: index.length,
    licence: 'CC0 1.0 — public domain dedication, redistribution permitted without conditions',
    note: 'Collected via the Openverse API filtered to CC0. Openverse reports the licence each source declares and does not verify it; sourceUrl is kept for every image so provenance can be audited.',
    images: index,
  };

  console.log(`\ncollected ${index.length}`);
  console.log(`rejected: ${rejected.filtered} filtered, ${rejected.duplicate} duplicate, ${rejected.download} download`);

  /**
   * Subjects that came back with nothing.
   *
   * Reported loudly because an empty subject is a silent hole in the matcher: a
   * page about butter will simply get no photograph, which is the correct
   * behaviour but not an obvious one to debug six weeks later. Better to know
   * now that Openverse has no CC0 butter.
   */
  const empty = Object.keys(SUBJECTS).filter((s) => index.every((i) => i.subject !== s));
  console.log(`subjects covered: ${Object.keys(SUBJECTS).length - empty.length}/${Object.keys(SUBJECTS).length}`);
  if (empty.length) console.log(`EMPTY subjects (no photograph will ever be offered for these): ${empty.join(', ')}`);

  if (DRY_RUN) {
    console.log('\ndry run — nothing uploaded. Sample:');
    for (const i of index.slice(0, 5)) {
      console.log(`  ${i.subject.padEnd(12)} ${i.width}x${i.height} ${i.title.slice(0, 40)}`);
      console.log(`             ${i.sourceUrl}`);
    }
    return;
  }

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: 'stock/index.json',
    Body: JSON.stringify(manifest),
    ContentType: 'application/json',
    // The index changes when the library is re-curated; the images do not.
    CacheControl: 'public, max-age=300',
  }));
  console.log(`\nwrote s3://${bucket}/stock/index.json`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
