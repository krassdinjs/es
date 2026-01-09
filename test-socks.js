// Test SOCKS5 proxy connection
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');

const proxyUrl = 'socks5://NuhaiProxy_vJl3Ss5m:m9m7nslR@185.26.236.199:30449';
const agent = new SocksProxyAgent(proxyUrl);

console.log('Testing SOCKS5 proxy connection to eflow.ie...');

const req = https.get({
  hostname: 'eflow.ie',
  path: '/',
  agent: agent,
  timeout: 30000,
}, (res) => {
  console.log('SUCCESS! Status:', res.statusCode);
  console.log('Headers:', JSON.stringify(res.headers, null, 2));
  
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Body length:', data.length, 'bytes');
    console.log('First 500 chars:', data.substring(0, 500));
    process.exit(0);
  });
});

req.on('error', (err) => {
  console.error('ERROR:', err.message);
  console.error('Stack:', err.stack);
  process.exit(1);
});

req.on('timeout', () => {
  console.error('TIMEOUT after 30 seconds');
  req.destroy();
  process.exit(1);
});
