const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, (res) => {
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

  try {
    const modules = 'summaryDetail,defaultKeyStatistics,financialData,price,quoteType';
    const { status, body } = await get(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`
    );

    if (status !== 200) return { statusCode: status, headers: cors, body: JSON.stringify({ error: `Yahoo returned ${status}` }) };

    const data = JSON.parse(body);
    const r = data?.quoteSummary?.result?.[0];
    if (!r) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: `No data for "${symbol}"` }) };

    const sd = r.summaryDetail        || {};
    const ks = r.defaultKeyStatistics || {};
    const fd = r.financialData        || {};
    const pr = r.price                || {};
    const qt = r.quoteType            || {};

    const v = (obj, key) => {
      const val = obj[key];
      if (val == null) return null;
      return (typeof val === 'object' && 'raw' in val) ? val.raw : val;
    };

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        symbol,
        name:           pr.shortName || pr.longName || qt.shortName || symbol,
        sector:         qt.sector    || '',
        industry:       qt.industry  || '',
        exchange:       qt.exchange  || pr.exchangeName || '',
        currency:       pr.currency  || sd.currency || 'USD',
        marketCap:      v(pr, 'marketCap'),
        peRatio:        v(sd, 'trailingPE'),
        forwardPE:      v(sd, 'forwardPE'),
        eps:            v(ks, 'trailingEps'),
        beta:           v(sd, 'beta'),
        week52High:     v(sd, 'fiftyTwoWeekHigh'),
        week52Low:      v(sd, 'fiftyTwoWeekLow'),
        avgVolume10d:   v(sd, 'averageVolume10days') || v(sd, 'averageDailyVolume10Day'),
        divYield:       v(sd, 'dividendYield'),
        divRate:        v(sd, 'dividendRate'),
        analystTarget:  v(fd, 'targetMeanPrice'),
        recommendation: fd.recommendationKey || '',
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
