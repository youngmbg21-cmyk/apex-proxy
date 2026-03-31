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

  const v = (obj, key) => {
    if (!obj) return null;
    const val = obj[key];
    if (val === null || val === undefined) return null;
    return (typeof val === 'object' && 'raw' in val) ? val.raw : val;
  };

  try {
    // ── Call 1: v8 chart (1 year) — most reliable for 52w high/low and volume ──
    let week52High = null, week52Low = null, avgVolume = null, chartMeta = {};
    try {
      const chartResp = await get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=1y`
      );
      if (chartResp.status === 200) {
        const cd = JSON.parse(chartResp.body);
        chartMeta = cd?.chart?.result?.[0]?.meta || {};
        const q = cd?.chart?.result?.[0]?.indicators?.quote?.[0] || {};
        const highs   = (q.high   || []).filter(x => x != null && x > 0);
        const lows    = (q.low    || []).filter(x => x != null && x > 0);
        const volumes = (q.volume || []).filter(x => x != null && x > 0);
        if (highs.length)   week52High = Math.max(...highs);
        if (lows.length)    week52Low  = Math.min(...lows);
        if (volumes.length) avgVolume  = Math.round(volumes.reduce((a,b)=>a+b,0)/volumes.length);
      }
    } catch(e) { /* chart failed */ }

    // ── Call 2: v7 quote — highly reliable for market cap, P/E, EPS, beta ──
    let v7Data = {};
    try {
      const v7Resp = await get(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&fields=shortName,longName,sector,industry,exchange,currency,marketCap,trailingPE,forwardPE,trailingEps,beta,fiftyTwoWeekHigh,fiftyTwoWeekLow,averageDailyVolume10Day,dividendYield,dividendRate,targetMeanPrice,recommendationKey,quoteType`
      );
      if (v7Resp.status === 200) {
        const vd = JSON.parse(v7Resp.body);
        v7Data = vd?.quoteResponse?.result?.[0] || {};
      }
    } catch(e) { /* v7 failed */ }

    // ── Call 3: quoteSummary — fallback for any gaps ──
    let sd = {}, ks = {}, fd = {}, pr = {}, qt = {};
    try {
      const summaryResp = await get(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,financialData,price,quoteType`
      );
      if (summaryResp.status === 200) {
        const sdata = JSON.parse(summaryResp.body);
        const r = sdata?.quoteSummary?.result?.[0];
        if (r) {
          sd = r.summaryDetail        || {};
          ks = r.defaultKeyStatistics || {};
          fd = r.financialData        || {};
          pr = r.price                || {};
          qt = r.quoteType            || {};
        }
      }
    } catch(e) { /* summary failed */ }

    // ── Merge best available data — v7 takes priority ──
    const result = {
      symbol,
      name:         v7Data.shortName  || v7Data.longName  || v(pr,'shortName') || chartMeta.shortName || symbol,
      sector:       v7Data.sector     || qt.sector         || '',
      industry:     v7Data.industry   || qt.industry       || '',
      exchange:     v7Data.exchange   || v(pr,'exchangeName') || chartMeta.fullExchangeName || '',
      currency:     v7Data.currency   || v(pr,'currency')  || chartMeta.currency || 'USD',

      // Market cap — v7 is most reliable
      marketCap:    v7Data.marketCap  || v(pr,'marketCap') || null,

      // P/E — v7 first, then summaryDetail
      peRatio:      v7Data.trailingPE || v(sd,'trailingPE') || v7Data.forwardPE || v(sd,'forwardPE') || null,

      // EPS
      eps:          v7Data.trailingEps || v(ks,'trailingEps') || null,

      // Beta
      beta:         v7Data.beta        || v(sd,'beta')     || null,

      // 52-week — v7 or calculated from chart
      week52High:   v7Data.fiftyTwoWeekHigh || week52High  || v(sd,'fiftyTwoWeekHigh') || null,
      week52Low:    v7Data.fiftyTwoWeekLow  || week52Low   || v(sd,'fiftyTwoWeekLow')  || null,

      // Volume
      avgVolume10d: v7Data.averageDailyVolume10Day || avgVolume || v(sd,'averageVolume10days') || null,

      // Dividend
      divYield:     v7Data.dividendYield || v(sd,'dividendYield') || null,
      divRate:      v7Data.dividendRate  || v(sd,'dividendRate')  || null,

      // Analyst
      analystTarget:  v7Data.targetMeanPrice || v(fd,'targetMeanPrice') || null,
      recommendation: v7Data.recommendationKey || fd.recommendationKey  || '',
    };

    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
