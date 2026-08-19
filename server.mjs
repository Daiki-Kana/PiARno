/**
 * server.mjs - All-in-One Dev Server for AR-Piano
 * - Dual HTTP (3000) & HTTPS (3443)
 * - Automatic Cloudflare Tunnel (untun) with valid public HTTPS
 * - Terminal QR code for instant smartphone scanning
 * - Zero firewall/network configuration needed
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import selfsigned from 'selfsigned';
import qrcode from 'qrcode-terminal';
import { startTunnel } from 'untun';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = 3000;
const HTTPS_PORT = 3443;

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.mjs': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.task': 'application/octet-stream'
};

// 1. Get or Generate SSL Certificate
async function getCertificate() {
  const certDir = path.join(__dirname, '.cert');
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      cert: fs.readFileSync(certPath, 'utf8'),
      key: fs.readFileSync(keyPath, 'utf8')
    };
  }

  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = await selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256'
  });

  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }
  fs.writeFileSync(certPath, pems.cert, 'utf8');
  fs.writeFileSync(keyPath, pems.private, 'utf8');

  return {
    cert: pems.cert,
    key: pems.private
  };
}

// 2. Static File Request Handler
function handleRequest(req, res) {
  let reqUrl = req.url.split('?')[0];
  if (reqUrl === '/' || reqUrl === '') {
    reqUrl = '/index.html';
  }

  const safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

// 3. Find primary LAN IP
function getLanIps() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// 4. Main Server Startup
async function startServer() {
  const sslOptions = await getCertificate();

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res);
  });

  const httpsServer = https.createServer(sslOptions, (req, res) => {
    handleRequest(req, res);
  });

  httpServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n❌ エラー: ポート ${HTTP_PORT} はすでに使用されています。`);
      console.error(`   古いサーバープロセスが残っている可能性があります。`);
    } else {
      console.error('HTTP Server Error:', e);
    }
    process.exit(1);
  });

  httpsServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n❌ エラー: ポート ${HTTPS_PORT} はすでに使用されています。`);
    } else {
      console.error('HTTPS Server Error:', e);
    }
    process.exit(1);
  });

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', async () => {
      const lanIps = getLanIps();
      const primaryIp = lanIps[0] || 'localhost';
      const lanHttpsUrl = `https://${primaryIp}:${HTTPS_PORT}`;
      const localHttpsUrl = `https://localhost:${HTTPS_PORT}`;

      console.log('\n=============================================================');
      console.log('  🎹 AR-Piano Dev Server Starting...');
      console.log('=============================================================');
      console.log('  ⏳ Cloudflare 公開HTTPSトンネルを準備中...');

      let tunnelUrl = null;
      try {
        const tunnel = await startTunnel({ port: HTTP_PORT });
        tunnelUrl = await tunnel.getURL();
      } catch (tunnelErr) {
        console.warn('  ⚠️ Cloudflare Tunnel failed to start:', tunnelErr.message);
      }

      console.log('\n=============================================================');
      console.log('  🎹 AR-Piano Dev Server Ready!');
      console.log('=============================================================');

      if (tunnelUrl) {
        console.log(`  🌟 スマホ推奨URL (Cloudflare Tunnel):`);
        console.log(`     ${tunnelUrl}`);
        console.log(`     ※ ファイアウォールやWi-Fi制限に関係なく100%接続可能 & 公式SSL付き`);
        console.log('-------------------------------------------------------------');
        console.log('  📲 スマホで以下のQRコードをスキャンすると直接開けます:');
        console.log('-------------------------------------------------------------');
        qrcode.generate(tunnelUrl, { small: true }, (qr) => {
          console.log(qr);
        });
      } else {
        console.log(`  📱 スマホ接続用 (LAN HTTPS):  ${lanHttpsUrl}`);
        console.log('-------------------------------------------------------------');
        qrcode.generate(lanHttpsUrl, { small: true }, (qr) => {
          console.log(qr);
        });
      }

      console.log('-------------------------------------------------------------');
      console.log(`  💻 PCブラウザ用 (Local):     ${localHttpsUrl}`);
      console.log(`  🏠 LAN直接接続 (LAN HTTPS):  ${lanHttpsUrl}`);
      console.log('=============================================================\n');
    });
  });
}

startServer().catch(err => {
  console.error('Server startup error:', err);
});
