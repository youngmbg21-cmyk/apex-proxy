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
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
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
    const { status, body } = await get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`
    );

    if (status !== 200) return {
      statusCode: status,
      headers: cors,
      body: JSON.stringify({ error: `Yahoo returned ${status} for "${symbol}"` })
    };

    const data = JSON.parse(body);
    const result = data?.chart?.result?.[0];
    if (!result) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: `"${symbol}" not found` }) };

    const m = result.meta || {};

    // Get today's OHLCV from the indicators if meta is missing values
    const quotes = result.indicators?.quote?.[0] || {};
    const timestamps = result.timestamp || [];
    const lastIdx = timestamps.length - 1;

    const price    = m.regularMarketPrice   || quotes.close?.[lastIdx]  || 0;
    const prev     = m.chartPreviousClose   || m.previousClose          || quotes.close?.[lastIdx - 1] || 0;
    const open     = m.regularMarketOpen    || quotes.open?.[lastIdx]   || 0;
    const dayHigh  = m.regularMarketDayHigh || quotes.high?.[lastIdx]   || 0;
    const dayLow   = m.regularMarketDayLow  || quotes.low?.[lastIdx]    || 0;
    const volume   = m.regularMarketVolume  || quotes.volume?.[lastIdx] || 0;
    const chg      = prev ? price - prev : 0;
    const pct      = prev ? (chg / prev) * 100 : 0;

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        symbol:      m.symbol           || symbol,
        name:        m.shortName        || m.longName || symbol,
        currency:    m.currency         || 'USD',
        exchange:    m.fullExchangeName || m.exchangeName || '',
        price,
        open,
        prevClose:   prev,
        dayHigh,
        dayLow,
        volume,
        change:      Math.round(chg * 10000) / 10000,
        changePct:   Math.round(pct * 10000) / 10000,
        marketState: m.marketState || 'CLOSED',
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
