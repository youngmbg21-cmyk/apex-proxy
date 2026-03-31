const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
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

  // Helper: extract .raw or direct value from quoteSummary objects
  const v = (obj, key) => {
    if (!obj) return null;
    const val = obj[key];
    if (val === null || val === undefined) return null;
    return (typeof val === 'object' && 'raw' in val) ? val.raw : val;
  };

  try {
    // ── Call 1: v8 chart (1 year weekly) — reliable 52w range + avg volume ──
    let week52High = null, week52Low = null, avgVolume = null, chartMeta = {};
    try {
      const cr = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=1y`);
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

    // ── Call 2: v7/finance/quote — correct field names ──
    // NOTE: v7 uses different field names than quoteSummary!
    // trailingEps → epsTrailingTwelveMonths
    // dividendYield → trailingAnnualDividendYield
    // targetMeanPrice → not available in v7
    let v7 = {};
    try {
      const fields = [
        'shortName','longName','sector','industry','exchange','currency',
        'marketCap','trailingPE','forwardPE',
        'epsTrailingTwelveMonths',          // EPS
        'beta',
        'fiftyTwoWeekHigh','fiftyTwoWeekLow',
        'averageDailyVolume10Day',
        'trailingAnnualDividendYield',      // dividend yield
        'trailingAnnualDividendRate',       // dividend rate
        'targetMeanPrice',
        'recommendationKey',
      ].join(',');
      const v7r = await get(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&fields=${fields}`);
      if (v7r.status === 200) {
        const vd = JSON.parse(v7r.body);
        v7 = vd?.quoteResponse?.result?.[0] || {};
      }
    } catch(e) {}

    // ── Call 3: quoteSummary — fallback for gaps ──
    let sd = {}, ks = {}, fd = {}, pr = {}, qt = {};
    try {
      const sr = await get(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,financialData,price,quoteType`);
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

    // ── Merge: v7 first (correct field names), then quoteSummary fallback ──
    const result = {
      symbol,
      name:         v7.shortName   || v7.longName   || v(pr,'shortName') || chartMeta.shortName || symbol,
      sector:       v7.sector      || qt.sector      || '',
      industry:     v7.industry    || qt.industry    || '',
      exchange:     v7.exchange    || v(pr,'exchangeName') || chartMeta.fullExchangeName || '',
      currency:     v7.currency    || v(pr,'currency') || chartMeta.currency || 'USD',

      marketCap:    v7.marketCap   || v(pr,'marketCap') || null,

      peRatio:      v7.trailingPE  || v(sd,'trailingPE')
                 || v7.forwardPE   || v(sd,'forwardPE') || null,

      // v7 uses epsTrailingTwelveMonths, not trailingEps
      eps:          v7.epsTrailingTwelveMonths || v(ks,'trailingEps') || null,

      beta:         v7.beta        || v(sd,'beta') || null,

      // 52w: v7 first, then chart calculation
      week52High:   v7.fiftyTwoWeekHigh || week52High || v(sd,'fiftyTwoWeekHigh') || null,
      week52Low:    v7.fiftyTwoWeekLow  || week52Low  || v(sd,'fiftyTwoWeekLow')  || null,

      avgVolume10d: v7.averageDailyVolume10Day || avgVolume || v(sd,'averageVolume10days') || null,

      // v7 uses trailingAnnualDividendYield, not dividendYield
      divYield:     v7.trailingAnnualDividendYield || v(sd,'dividendYield') || null,
      divRate:      v7.trailingAnnualDividendRate  || v(sd,'dividendRate')  || null,

      analystTarget:  v7.targetMeanPrice  || v(fd,'targetMeanPrice') || null,
      recommendation: v7.recommendationKey || fd.recommendationKey  || '',
    };

    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
