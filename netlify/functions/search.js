const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Map Yahoo exchange codes to flag emojis + readable names
const EXCHANGE_MAP = {
  'NMS': { flag: '🇺🇸', name: 'NASDAQ' },
  'NYQ': { flag: '🇺🇸', name: 'NYSE' },
  'NGM': { flag: '🇺🇸', name: 'NASDAQ' },
  'ASE': { flag: '🇺🇸', name: 'NYSE American' },
  'PCX': { flag: '🇺🇸', name: 'NYSE Arca' },
  'STO': { flag: '🇸🇪', name: 'Stockholm' },
  'OMX': { flag: '🇸🇪', name: 'OMX' },
  'LSE': { flag: '🇬🇧', name: 'London' },
  'IOB': { flag: '🇬🇧', name: 'London IOB' },
  'FRA': { flag: '🇩🇪', name: 'Frankfurt' },
  'TOR': { flag: '🇨🇦', name: 'Toronto' },
  'ASX': { flag: '🇦🇺', name: 'ASX' },
  'TYO': { flag: '🇯🇵', name: 'Tokyo' },
  'HKG': { flag: '🇭🇰', name: 'Hong Kong' },
  'EPA': { flag: '🇫🇷', name: 'Paris' },
  'AMS': { flag: '🇳🇱', name: 'Amsterdam' },
  'MCE': { flag: '🇪🇸', name: 'Madrid' },
  'MIL': { flag: '🇮🇹', name: 'Milan' },
  'CPH': { flag: '🇩🇰', name: 'Copenhagen' },
  'HEL': { flag: '🇫🇮', name: 'Helsinki' },
  'OSL': { flag: '🇳🇴', name: 'Oslo' },
};

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const query = (event.queryStringParameters?.q || '').trim();
  if (!query || query.length < 1) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing query' }) };

  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;
    const { status, body } = await get(url);

    if (status !== 200) return { statusCode: status, headers: cors, body: JSON.stringify({ error: `Yahoo returned ${status}` }) };

    const data = JSON.parse(body);
    const quotes = (data?.quotes || [])
      .filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
      .slice(0, 7)
      .map(q => {
        const exch = EXCHANGE_MAP[q.exchange] || EXCHANGE_MAP[q.exchDisp] || { flag: '🌐', name: q.exchDisp || q.exchange || '' };
        return {
          symbol:   q.symbol,
          name:     q.shortname || q.longname || q.symbol,
          exchange: exch.name,
          flag:     exch.flag,
          type:     q.quoteType,
        };
      });

    return { statusCode: 200, headers: cors, body: JSON.stringify({ results: quotes }) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
