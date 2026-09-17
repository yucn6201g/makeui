/**
 * Build the MODEL_PRICING table from AWS's own published prices.
 *
 * The prices were typed in by hand once, from the table on
 * https://aws.amazon.com/bedrock/pricing/. That is a number in a shell history
 * ageing silently, which is the thing this project keeps finding and removing.
 *
 * AWS's Pricing API cannot answer instead: for ap-northeast-1 it returns Claude
 * 2.0, 2.1, 3 Haiku and 3 Sonnet, and none of the models this project runs, in
 * any region. What does carry them is the pricing PAGE, which is two documents:
 *
 *   the page      a table per provider. Each cell holds a token,
 *                 `{priceOf!bedrockfoundationmodels/bedrockfoundationmodels!<hash>}`,
 *                 and the row's first cell is the model name.
 *   the feed      that hash to a price, per region, at
 *                 b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/…
 *
 * Columns are matched by their HEADER text, never by position: AWS adds columns
 * — batch, the two cache-write windows — and a script counting cells would read
 * the batch price as the on-demand one and be wrong by half with nothing to show
 * for it.
 *
 * Which model each tier resolves to comes from SSM, so the table cannot drift
 * from what the runtime actually invokes. `sonnet` was Sonnet 4.6 when this was
 * written, and Sonnet 5 is a different row at two thirds of the price.
 *
 *   node scripts/fetch-model-pricing.mjs                 # print the table
 *   node scripts/fetch-model-pricing.mjs > prices.json   # and keep it
 *   node scripts/fetch-model-pricing.mjs --explain       # show every match
 *
 * Then apply it with scripts/set-model-pricing.sh.
 */
import { execFileSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const REGION_LABEL = process.env.PRICING_REGION_LABEL || 'Asia Pacific (Tokyo)';
const PAGE = 'https://aws.amazon.com/bedrock/pricing/';
const FEED = 'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps'
  + '/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json';
const EXPLAIN = process.argv.includes('--explain');

/*
 * The four kinds this project is billed in, and the column that carries each.
 *
 * The cache-write window is the five-minute one because that is what the code
 * asks for: `prompt-cache.ts` sends `cache_control: { type: 'ephemeral' }` with
 * no ttl. Reading the one-hour column would overstate every cached run.
 */
const COLUMNS = {
  input: /price per 1m input tokens$/i,
  output: /price per 1m output tokens$/i,
  cacheWrite: /price per 1m input tokens \(5m cache write\)/i,
  cacheRead: /price per 1m input tokens \(cache read\)/i,
};

const get = (url) =>
  execFileSync('curl', ['-sL', '--compressed', '--max-time', '90', url], {
    encoding: 'utf8', maxBuffer: 1 << 29,
  });

/** The model each tier actually invokes, read from the parameters the runtime reads. */
function tierModels() {
  const raw = execFileSync('aws', [
    'ssm', 'get-parameters', '--region', REGION, '--output', 'json',
    '--names', '/makeui/models/haiku', '/makeui/models/sonnet', '/makeui/models/opus',
  ], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  const out = {};
  for (const p of JSON.parse(raw).Parameters ?? []) {
    out[p.Name.split('/').pop()] = p.Value;
  }
  return out;
}

/**
 * An inference-profile ARN to the name the pricing page prints.
 *
 * `jp.anthropic.claude-haiku-4-5-20251001-v1:0` -> `claude haiku 4 5`. The date
 * and the version suffix are dropped because the page does not carry them, and
 * the remaining words are matched as a set rather than as a string so
 * `claude-sonnet-4-6` finds "Claude Sonnet 4.6" whatever AWS does with spacing.
 */
function modelWords(arn) {
  const id = arn.split('/').pop() ?? arn;
  return id
    .replace(/^[a-z]{2,3}\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-\d{8}(-v\d+(:\d+)?)?$/, '')
    .replace(/[.:]/g, '-')
    .split('-')
    .filter(Boolean);
}

const strip = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Every table row on the page, as its header set plus its cells. */
function pageRows(html) {
  const rows = [];
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const headerRow = (table.match(/<tr[\s\S]*?<\/tr>/i) ?? [''])[0];
    const headers = [...headerRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => strip(m[1]));
    if (headers.length < 2) continue;
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => m[1]);
      if (cells.length < 2) continue;
      const name = strip(cells[0]);
      if (!name || /^price/i.test(name)) continue;
      rows.push({ name, headers, cells });
    }
  }
  return rows;
}

const TOKEN = /\{priceOf![^!]*![A-Za-z0-9_-]+\}/;
const hashOf = (cell) => (TOKEN.exec(cell) ?? [''])[0].replace(/^\{priceOf![^!]*!/, '').replace(/\}$/, '');

const [pageHtml, feedRaw] = [get(PAGE), get(FEED)];
const feed = JSON.parse(feedRaw).regions?.[REGION_LABEL];
if (!feed) {
  console.error(`No prices for "${REGION_LABEL}" in the feed. Regions it carries:`);
  console.error(Object.keys(JSON.parse(feedRaw).regions ?? {}).join('\n'));
  process.exit(1);
}

const rows = pageRows(pageHtml);
const models = {};
const notes = [];

for (const [tier, arn] of Object.entries(tierModels())) {
  const words = modelWords(arn);
  /*
   * Every word, so `claude sonnet 4 6` cannot match "Claude Sonnet 4.5", and the
   * shortest such row, so it cannot match a longer name that contains it.
   */
  const candidates = rows.filter((r) => {
    const name = r.name.toLowerCase().replace(/[.]/g, ' ').replace(/\s+/g, ' ');
    return words.every((w) => new RegExp(`(^| )${w}( |$)`).test(name));
  });
  if (candidates.length === 0) {
    notes.push(`${tier}: no row on the page matches ${words.join(' ')} (${arn})`);
    continue;
  }
  const row = candidates.sort((a, b) => a.name.length - b.name.length)[0];

  const prices = {};
  for (const [kind, header] of Object.entries(COLUMNS)) {
    const at = row.headers.findIndex((h) => header.test(h));
    if (at < 0 || !row.cells[at]) { notes.push(`${tier}: no column matching ${header} on "${row.name}"`); continue; }
    const hash = hashOf(row.cells[at]);
    const price = hash ? feed[hash]?.price : undefined;
    if (price === undefined) {
      const literal = /([\d.]+)/.exec(strip(row.cells[at]));
      if (!literal) { notes.push(`${tier}: "${row.name}" has no price under ${row.headers[at]}`); continue; }
      prices[kind] = Number(literal[1]);
    } else {
      prices[kind] = Number(price);
    }
    if (EXPLAIN) console.error(`  ${tier.padEnd(7)} ${row.name.padEnd(22)} ${row.headers[at].slice(0, 44).padEnd(46)} ${prices[kind]}`);
  }
  if (Object.keys(prices).length === 4) models[tier] = prices;
  else notes.push(`${tier}: only ${Object.keys(prices).join(', ')} could be read — left out`);
}

for (const n of notes) console.error(`WARNING  ${n}`);
if (Object.keys(models).length === 0) {
  console.error('No tier could be priced. The page layout has probably changed; run with --explain.');
  process.exit(1);
}
console.log(JSON.stringify({ currency: 'USD', models }, null, 2));
