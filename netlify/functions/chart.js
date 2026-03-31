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

  const p      = event.queryStringParameters || {};
  const symbol = (p.symbol   || '').trim().toUpperCase();
  const range  = p.range    || '3mo';
  const interval = p.interval || '1d';

  if (!symbol) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing symbol' }) };

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const { status, body } = await get(url);

    if (status !== 200) return { statusCode: status, headers: cors, body: JSON.stringify({ error: `Yahoo returned ${status}` }) };

    const data   = JSON.parse(body);
    const result = data?.chart?.result?.[0];
    if (!result) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: `No data for "${symbol}"` }) };

    const timestamps = result.timestamp || [];
    const q          = result.indicators?.quote?.[0] || {};

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        symbol,
        timestamps,
        opens:   q.open   || [],
        highs:   q.high   || [],
        lows:    q.low    || [],
        closes:  q.close  || [],
        volumes: q.volume || [],
        currency: result.meta?.currency || 'USD',
        exchange: result.meta?.fullExchangeName || '',
      })
    };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
