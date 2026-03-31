const https = require('https');
const zlib  = require('zlib');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      // Handle compression
      let stream = res;
      const enc = res.headers['content-encoding'] || '';
      if (enc.includes('gzip'))    stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      else if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());

      let body = '';
      stream.on('data', d => body += d.toString('utf8'));
      stream.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      stream.on('error', reject);
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
    // ── v11/quoteSummary — does NOT require crumb auth ──
    // This is the key insight: v11 works from server IPs without crumb
    // v7 and v10 require crumb + are blocked from AWS; v11 is not
    const modules = 'summaryDetail,defaultKeyStatistics,financialData,price,quoteType';
    const [v11Result, chartResult] = await Promise.allSettled([
      get(`https://query2.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`),
      get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=1y`),
    ]);

    // Parse v11
    let sd = {}, ks = {}, fd = {}, pr = {}, qt = {};
    if (v11Result.status === 'fulfilled' && v11Result.value.status === 200) {
      try {
        const d = JSON.parse(v11Result.value.body);
        const r = d?.quoteSummary?.result?.[0];
        if (r) {
          sd = r.summaryDetail        || {};
          ks = r.defaultKeyStatistics || {};
          fd = r.financialData        || {};
          pr = r.price                || {};
          qt = r.quoteType            || {};
        }
      } catch(e) {}
    }

    // Parse v8 chart for 52W high/low + avg volume (always works, no auth)
    let week52High = null, week52Low = null, avgVolume = null, chartMeta = {};
    if (chartResult.status === 'fulfilled' && chartResult.value.status === 200) {
      try {
        const cd = JSON.parse(chartResult.value.body);
        chartMeta = cd?.chart?.result?.[0]?.meta || {};
        const q = cd?.chart?.result?.[0]?.indicators?.quote?.[0] || {};
        const highs   = (q.high   || []).filter(x => x != null && x > 0);
        const lows    = (q.low    || []).filter(x => x != null && x > 0);
        const volumes = (q.volume || []).filter(x => x != null && x > 0);
        if (highs.length)   week52High = Math.max(...highs);
        if (lows.length)    week52Low  = Math.min(...lows);
        if (volumes.length) avgVolume  = Math.round(volumes.reduce((a,b)=>a+b,0)/volumes.length);
      } catch(e) {}
    }

    const result = {
      symbol,
      name:         v(pr,'shortName')  || v(pr,'longName')  || chartMeta.shortName || symbol,
      sector:       v(qt,'sector')     || '',
      industry:     v(qt,'industry')   || '',
      exchange:     v(pr,'exchangeName') || chartMeta.fullExchangeName || '',
      currency:     v(pr,'currency')   || chartMeta.currency || 'USD',
      marketCap:    v(pr,'marketCap')  || v(sd,'marketCap') || null,
      peRatio:      v(sd,'trailingPE') || v(sd,'forwardPE') || null,
      forwardPE:    v(sd,'forwardPE')  || null,
      eps:          v(ks,'trailingEps') || null,
      beta:         v(sd,'beta')       || null,
      week52High:   week52High || v(sd,'fiftyTwoWeekHigh') || null,
      week52Low:    week52Low  || v(sd,'fiftyTwoWeekLow')  || null,
      avgVolume10d: avgVolume  || v(sd,'averageVolume10days') || null,
      divYield:     v(sd,'dividendYield')  || null,
      divRate:      v(sd,'dividendRate')   || null,
      analystTarget:  v(fd,'targetMeanPrice') || null,
      recommendation: fd.recommendationKey   || '',
      profitMargin:   v(fd,'profitMargins')  || null,
      returnOnEquity: v(fd,'returnOnEquity') || null,
      debtToEquity:   v(fd,'debtToEquity')  || null,
      priceToBook:    v(ks,'priceToBook')    || null,
      pegRatio:       v(ks,'pegRatio')       || null,
      evToEbitda:     v(ks,'enterpriseToEbitda') || null,
      _source: 'v11',
    };

    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
