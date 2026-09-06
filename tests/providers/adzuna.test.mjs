// tests/providers/adzuna.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — adzuna');

try {
  const adzunaModule = await import(pathToFileURL(join(ROOT, 'providers/adzuna.mjs')).href);
  const adzuna = adzunaModule.default;
  const { stripHtml, parseAdzunaItem, parseAdzunaResponse, parseAdzunaConfig } = adzunaModule;

  // 1. Identity & detection
  if (adzuna.id === 'adzuna') pass('adzuna.id is "adzuna"');
  else fail(`adzuna.id is ${JSON.stringify(adzuna.id)}`);

  const hitExplicit = adzuna.detect({ name: 'Adzuna Board', provider: 'adzuna' });
  if (hitExplicit && hitExplicit.url === 'https://api.adzuna.com/v1/api/jobs') {
    pass('adzuna.detect() claims explicit provider config');
  } else {
    fail(`adzuna.detect() returned ${JSON.stringify(hitExplicit)}`);
  }

  const hitUrl = adzuna.detect({ name: 'Adzuna UK', careers_url: 'https://www.adzuna.co.uk/jobs' });
  if (hitUrl && hitUrl.url === 'https://www.adzuna.co.uk/jobs') {
    pass('adzuna.detect() matches adzuna.co.uk careers_url');
  } else {
    fail(`adzuna.detect() did not match adzuna.co.uk, got: ${JSON.stringify(hitUrl)}`);
  }

  const hitIndiaUrl = adzuna.detect({ name: 'Adzuna IN', careers_url: 'https://www.adzuna.in/jobs' });
  if (hitIndiaUrl && hitIndiaUrl.url === 'https://www.adzuna.in/jobs') {
    pass('adzuna.detect() matches adzuna.in careers_url');
  } else {
    fail(`adzuna.detect() did not match adzuna.in, got: ${JSON.stringify(hitIndiaUrl)}`);
  }

  if (adzuna.detect({ name: 'Other Board', provider: 'other' }) === null) {
    pass('adzuna.detect() returns null for other provider ids');
  } else {
    fail('adzuna.detect() should ignore other provider ids');
  }

  // 2. HTML Tag Stripping & Entity Decoding
  const htmlRaw = 'Senior <strong>Software</strong> &amp; <b>AI</b> Engineer';
  if (stripHtml(htmlRaw) === 'Senior Software & AI Engineer') {
    pass('stripHtml() removes HTML highlight tags and decodes entities');
  } else {
    fail(`stripHtml() output: ${JSON.stringify(stripHtml(htmlRaw))}`);
  }

  // 3. Item normalization
  const sampleItem = {
    id: '123456',
    title: 'Senior <strong>Go</strong> &amp; <strong>AI</strong> Engineer',
    description: 'Looking for a <strong>skilled</strong> developer &amp; leader.',
    company: { display_name: ' Acme &amp; Co ' },
    location: {
      display_name: 'Bengaluru, Karnataka',
      area: ['India', 'Karnataka', 'Bengaluru'],
    },
    redirect_url: 'https://www.adzuna.in/land/ad/123456?se=xyz',
    created: '2026-08-30T10:15:00Z',
  };

  const parsedItem = parseAdzunaItem(sampleItem, 'Fallback Co');
  if (parsedItem?.title === 'Senior Go & AI Engineer') {
    pass('parseAdzunaItem() decodes entities and strips highlight tags from title');
  } else {
    fail(`parsedItem title = ${JSON.stringify(parsedItem?.title)}`);
  }

  if (parsedItem?.company === 'Acme & Co') {
    pass('parseAdzunaItem() extracts and sanitizes company name');
  } else {
    fail(`parsedItem company = ${JSON.stringify(parsedItem?.company)}`);
  }

  if (parsedItem?.location === 'Bengaluru, Karnataka') {
    pass('parseAdzunaItem() extracts location display_name');
  } else {
    fail(`parsedItem location = ${JSON.stringify(parsedItem?.location)}`);
  }

  if (parsedItem?.url === 'https://www.adzuna.in/land/ad/123456?se=xyz') {
    pass('parseAdzunaItem() extracts redirect_url as job url');
  } else {
    fail(`parsedItem url = ${JSON.stringify(parsedItem?.url)}`);
  }

  if (parsedItem?.description === 'Looking for a skilled developer & leader.') {
    pass('parseAdzunaItem() extracts and cleans description');
  } else {
    fail(`parsedItem description = ${JSON.stringify(parsedItem?.description)}`);
  }

  if (parsedItem?.postedAt === Date.parse('2026-08-30T10:15:00Z')) {
    pass('parseAdzunaItem() parses created ISO string to postedAt epoch ms');
  } else {
    fail(`parsedItem postedAt = ${JSON.stringify(parsedItem?.postedAt)}`);
  }

  // Fallback behavior
  const fallbackItem = {
    title: 'Software Developer',
    redirect_url: 'https://www.adzuna.com/land/ad/999',
    location: {
      area: ['UK', 'London', 'Central London'],
    },
  };
  const parsedFallback = parseAdzunaItem(fallbackItem, 'My Portal');
  if (parsedFallback?.company === 'My Portal') {
    pass('parseAdzunaItem() falls back to entry.name when company is absent');
  } else {
    fail(`parsedFallback company = ${JSON.stringify(parsedFallback?.company)}`);
  }

  if (parsedFallback?.location === 'UK, London, Central London') {
    pass('parseAdzunaItem() falls back to location.area joined when display_name is absent');
  } else {
    fail(`parsedFallback location = ${JSON.stringify(parsedFallback?.location)}`);
  }

  // Dropping invalid items
  if (parseAdzunaItem({ title: '', redirect_url: 'https://example.com' }) === null) {
    pass('parseAdzunaItem() drops item with empty title');
  } else {
    fail('parseAdzunaItem() should drop empty title');
  }

  if (parseAdzunaItem({ title: 'Role', redirect_url: 'not-a-valid-url' }) === null) {
    pass('parseAdzunaItem() drops item with non-http/https redirect_url');
  } else {
    fail('parseAdzunaItem() should drop invalid redirect_url');
  }

  // 4. Response parsing
  const sampleResponse = {
    count: 2,
    results: [
      sampleItem,
      fallbackItem,
      { title: '', redirect_url: 'https://bad.com' }, // dropped
    ],
  };

  const allParsed = parseAdzunaResponse(sampleResponse, 'Fallback Co');
  if (allParsed.length === 2) {
    pass('parseAdzunaResponse() parses valid items and filters invalid ones');
  } else {
    fail(`parseAdzunaResponse returned ${allParsed.length} items (expected 2)`);
  }

  if (parseAdzunaResponse(null).length === 0 && parseAdzunaResponse({}).length === 0) {
    pass('parseAdzunaResponse() handles null / empty payload gracefully');
  } else {
    fail('parseAdzunaResponse() should return [] for empty/null payload');
  }

  // 5. Config parsing
  const config = parseAdzunaConfig({
    country: 'in',
    app_id: 'test_id',
    app_key: 'test_key',
    searchKeywords: ['Go', 'AI'],
    searchLocation: 'Bengaluru',
    pageSize: 30,
    maxPages: 2,
    days: 14,
  });

  if (config.country === 'in' && config.appId === 'test_id' && config.appKey === 'test_key'
      && config.keywords === 'Go AI' && config.location === 'Bengaluru'
      && config.pageSize === 30 && config.maxPages === 2 && config.maxDaysOld === 14) {
    pass('parseAdzunaConfig() correctly parses and sanitizes all config fields');
  } else {
    fail(`parseAdzunaConfig output: ${JSON.stringify(config)}`);
  }

  // 6. Fetch execution
  let capturedUrls = [];
  let capturedOpts = [];
  const mockCtx = {
    transport: 'http',
    fetchJson: async (url, opts) => {
      capturedUrls.push(url);
      capturedOpts.push(opts);
      return {
        count: 2,
        results: [sampleItem, fallbackItem],
      };
    },
    fetchText: async () => '',
  };

  const fetched = await adzuna.fetch(
    {
      name: 'Adzuna India Tech',
      provider: 'adzuna',
      country: 'in',
      app_id: 'sample_id',
      app_key: 'sample_key',
      searchKeywords: 'Backend Engineer',
      searchLocation: 'Bengaluru',
      pageSize: 50,
      maxPages: 2,
    },
    mockCtx,
  );

  if (fetched.length === 2) {
    pass('adzuna.fetch() returns normalized jobs');
  } else {
    fail(`adzuna.fetch() returned ${fetched.length} jobs (expected 2)`);
  }

  if (capturedUrls[0] && capturedUrls[0].startsWith('https://api.adzuna.com/v1/api/jobs/in/search/1')) {
    pass('adzuna.fetch() formats target URL with country and page number');
  } else {
    fail(`adzuna.fetch() requested URL: ${JSON.stringify(capturedUrls[0])}`);
  }

  const urlObj = new URL(capturedUrls[0]);
  if (urlObj.searchParams.get('app_id') === 'sample_id'
      && urlObj.searchParams.get('app_key') === 'sample_key'
      && urlObj.searchParams.get('what') === 'Backend Engineer'
      && urlObj.searchParams.get('where') === 'Bengaluru'
      && urlObj.searchParams.get('results_per_page') === '50') {
    pass('adzuna.fetch() passes query parameters to Adzuna API');
  } else {
    fail(`adzuna.fetch() query parameters wrong: ${urlObj.search}`);
  }

  if (capturedOpts[0]?.redirect === 'error') {
    pass('adzuna.fetch() passes redirect:"error" to fetchJson (SSRF protection)');
  } else {
    fail(`adzuna.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts[0])}`);
  }

  // Missing credentials error
  let missingCredsThrew = false;
  try {
    await adzuna.fetch({ name: 'No Creds', provider: 'adzuna' }, mockCtx);
  } catch (err) {
    missingCredsThrew = /missing app_id or app_key/.test(err.message);
  }
  if (missingCredsThrew) {
    pass('adzuna.fetch() throws actionable error when app_id or app_key is missing');
  } else {
    fail('adzuna.fetch() must throw when credentials are missing');
  }

  // Malformed API response error
  let badApiThrew = false;
  try {
    await adzuna.fetch(
      { name: 'Bad Api', provider: 'adzuna', app_id: 'a', app_key: 'b' },
      {
        fetchJson: async () => ({ unexpected: true }),
      },
    );
  } catch (err) {
    badApiThrew = /unexpected API response/.test(err.message);
  }
  if (badApiThrew) {
    pass('adzuna.fetch() throws when API response lacks results array on page 1');
  } else {
    fail('adzuna.fetch() should throw on unexpected API response shape');
  }

} catch (e) {
  fail(`adzuna provider tests crashed: ${e.message}`);
}
