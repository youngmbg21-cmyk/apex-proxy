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
      // Follow redirects
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

  // Helper to safely extract .raw or direct value
  const v = (obj, key) => {
    if (!obj) return null;
    const val = obj[key];
    if (val === null || val === undefined) return null;
    return (typeof val === 'object' && 'raw' in val) ? val.raw : val;
  };

  try {
    // ── Call 1: Chart endpoint (1 year) — reliable for 52w high/low, volume, open ──
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
    const chartResp = await get(chartUrl);

    let chartMeta = {};
    let week52High = null, week52Low = null, avgVolume = null;

    if (chartResp.status === 200) {
      try {
        const cd = JSON.parse(chartResp.body);
        chartMeta = cd?.chart?.result?.[0]?.meta || {};

        // Calculate 52w high/low from historical closes
        const closes = cd?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
        const highs   = cd?.chart?.result?.[0]?.indicators?.quote?.[0]?.high  || [];
        const lows    = cd?.chart?.result?.[0]?.indicators?.quote?.[0]?.low   || [];
        const volumes = cd?.chart?.result?.[0]?.indicators?.quote?.[0]?.volume || [];

        const validHighs = highs.filter(x => x != null && x > 0);
        const validLows  = lows.filter(x => x != null && x > 0);
        const validVols  = volumes.filter(x => x != null && x > 0);

        if (validHighs.length) week52High = Math.max(...validHighs);
        if (validLows.length)  week52Low  = Math.min(...validLows);
        if (validVols.length)  avgVolume  = Math.round(validVols.reduce((a,b) => a+b, 0) / validVols.length);

      } catch(e) { /* chart parse failed, continue */ }
    }

    // ── Call 2: QuoteSummary — for P/E, EPS, market cap, dividend, beta, analyst target ──
    const summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,financialData,price,quoteType`;
    const summaryResp = await get(summaryUrl);

    let sd = {}, ks = {}, fd = {}, pr = {}, qt = {};

    if (summaryResp.status === 200) {
      try {
        const sd_data = JSON.parse(summaryResp.body);
        const r = sd_data?.quoteSummary?.result?.[0];
        if (r) {
          sd = r.summaryDetail        || {};
          ks = r.defaultKeyStatistics || {};
          fd = r.financialData        || {};
          pr = r.price                || {};
          qt = r.quoteType            || {};
        }
      } catch(e) { /* summary parse failed, use chart data only */ }
    }

    // ── Build response with best available data ──
    const result = {
      symbol,
      name:           v(pr,'shortName') || v(pr,'longName') || chartMeta.shortName || chartMeta.longName || symbol,
      sector:         qt.sector    || '',
      industry:       qt.industry  || '',
      exchange:       qt.exchange  || v(pr,'exchangeName') || chartMeta.fullExchangeName || chartMeta.exchangeName || '',
      currency:       v(pr,'currency') || chartMeta.currency || 'USD',

      // Market cap — from price module
      marketCap:      v(pr,'marketCap'),

      // P/E ratio — try multiple fields
      peRatio:        v(sd,'trailingPE') || v(sd,'forwardPE') || null,

      // EPS
      eps:            v(ks,'trailingEps') || null,

      // Beta
      beta:           v(sd,'beta') || null,

      // 52-week range — prefer calculated from chart data (more reliable)
      week52High:     week52High || v(sd,'fiftyTwoWeekHigh') || null,
      week52Low:      week52Low  || v(sd,'fiftyTwoWeekLow')  || null,

      // Average volume — prefer calculated from chart data
      avgVolume10d:   avgVolume || v(sd,'averageVolume10days') || v(sd,'averageDailyVolume10Day') || null,

      // Dividend
      divYield:       v(sd,'dividendYield') || null,
      divRate:        v(sd,'dividendRate')  || null,

      // Analyst target
      analystTarget:  v(fd,'targetMeanPrice') || null,
      recommendation: fd.recommendationKey || '',
    };

    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
