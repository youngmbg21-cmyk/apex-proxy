const https = require('https');

function get(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        ...extraHeaders,
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      // Handle gzip
      let chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Fetch Yahoo crumb + cookie (required for v7/v10 endpoints since 2023)
async function getYahooCrumb() {
  try {
    // Step 1: hit the consent/cookie page to get session cookie
    const cookieRes = await get('https://fc.yahoo.com', {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    const cookie = (cookieRes.headers['set-cookie'] || [])
      .map(c => c.split(';')[0])
      .join('; ');

    // Step 2: fetch the crumb using the cookie
    const crumbRes = await get(
      'https://query1.finance.yahoo.com/v1/test/csrfToken',
      cookie ? { 'Cookie': cookie } : {}
    );

    if (crumbRes.status === 200) {
      const crumb = crumbRes.body.trim();
      return { crumb, cookie };
    }
  } catch(e) {}

  // Fallback: try query2 crumb endpoint
  try {
    const r = await get('https://query2.finance.yahoo.com/v1/test/csrfToken');
    if (r.status === 200) return { crumb: r.body.trim(), cookie: '' };
  } catch(e) {}

  return { crumb: null, cookie: '' };
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const symbol = (event.queryStringParameters?.symbol || '').trim().toUpperCase();
  if (!symbol) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing symbol' }) };

  const v = (obj, key) => {
    if (!obj) return null;
    const val = obj[key];
    if (val === null || val === undefined) return null;
    return (typeof val === 'object' && 'raw' in val) ? val.raw : val;
  };

  try {
    // ── Fetch crumb first (required for v7/v10 since 2023) ──
    const { crumb, cookie } = await getYahooCrumb();
    const authHeaders = cookie ? { 'Cookie': cookie } : {};
    const crumbParam  = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';

    // ── Call 1: v8 chart (1 year weekly) — works WITHOUT crumb ──
    // Reliable for 52w high/low, avg volume, basic meta
    let week52High = null, week52Low = null, avgVolume = null, chartMeta = {};
    try {
      const cr = await get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=1y`,
        authHeaders
      );
      if (cr.status === 200) {
        const cd = JSON.parse(cr.body);
        chartMeta = cd?.chart?.result?.[0]?.meta || {};
        const q = cd?.chart?.result?.[0]?.indicators?.quote?.[0] || {};
        const highs   = (q.high   || []).filter(x => x != null && x > 0);
        const lows    = (q.low    || []).filter(x => x != null && x > 0);
        const volumes = (q.volume || []).filter(x => x != null && x > 0);
        if (highs.length)   week52High = Math.max(...highs);
        if (lows.length)    week52Low  = Math.min(...lows);
        if (volumes.length) avgVolume  = Math.round(volumes.reduce((a,b)=>a+b,0)/volumes.length);
      }
    } catch(e) {}

    // ── Call 2: v7/finance/quote WITH crumb ──
    let v7 = {};
    try {
      const fields = [
        'shortName','longName','sector','industry','exchange','currency',
        'marketCap','trailingPE','forwardPE',
        'epsTrailingTwelveMonths',
        'beta',
        'fiftyTwoWeekHigh','fiftyTwoWeekLow',
        'averageDailyVolume10Day',
        'trailingAnnualDividendYield',
        'trailingAnnualDividendRate',
        'targetMeanPrice',
        'recommendationKey',
      ].join(',');
      const v7r = await get(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&fields=${fields}${crumbParam}`,
        { ...authHeaders, 'Accept': 'application/json' }
      );
      if (v7r.status === 200) {
        const vd = JSON.parse(v7r.body);
        v7 = vd?.quoteResponse?.result?.[0] || {};
      }
    } catch(e) {}

    // ── Call 3: v10/quoteSummary WITH crumb (fallback) ──
    let sd = {}, ks = {}, fd = {}, pr = {}, qt = {};
    try {
      const sr = await get(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,financialData,price,quoteType${crumbParam}`,
        { ...authHeaders, 'Accept': 'application/json' }
      );
      if (sr.status === 200) {
        const sdata = JSON.parse(sr.body);
        const r = sdata?.quoteSummary?.result?.[0];
        if (r) {
          sd = r.summaryDetail        || {};
          ks = r.defaultKeyStatistics || {};
          fd = r.financialData        || {};
          pr = r.price                || {};
          qt = r.quoteType            || {};
        }
      }
    } catch(e) {}

    // ── Merge best available data ──
    const result = {
      symbol,
      name:         v7.shortName   || v7.longName   || v(pr,'shortName') || chartMeta.shortName || symbol,
      sector:       v7.sector      || qt.sector      || '',
      industry:     v7.industry    || qt.industry    || '',
      exchange:     v7.exchange    || v(pr,'exchangeName') || chartMeta.fullExchangeName || '',
      currency:     v7.currency    || v(pr,'currency') || chartMeta.currency || 'USD',
      marketCap:    v7.marketCap   || v(pr,'marketCap') || null,
      peRatio:      v7.trailingPE  || v(sd,'trailingPE') || v7.forwardPE || v(sd,'forwardPE') || null,
      eps:          v7.epsTrailingTwelveMonths || v(ks,'trailingEps') || null,
      beta:         v7.beta        || v(sd,'beta') || null,
      week52High:   v7.fiftyTwoWeekHigh || week52High || v(sd,'fiftyTwoWeekHigh') || null,
      week52Low:    v7.fiftyTwoWeekLow  || week52Low  || v(sd,'fiftyTwoWeekLow')  || null,
      avgVolume10d: v7.averageDailyVolume10Day || avgVolume || v(sd,'averageVolume10days') || null,
      divYield:     v7.trailingAnnualDividendYield || v(sd,'dividendYield') || null,
      divRate:      v7.trailingAnnualDividendRate  || v(sd,'dividendRate')  || null,
      analystTarget:  v7.targetMeanPrice  || v(fd,'targetMeanPrice') || null,
      recommendation: v7.recommendationKey || fd.recommendationKey  || '',
      _crumbUsed: !!crumb, // debug flag
    };

    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
