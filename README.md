# Reverse Proxy Server

Full-featured reverse proxy service for educational purposes.

## Features

- HTTP/HTTPS proxying with session support
- Cookie and header forwarding
- WebSocket support
- Request logging
- GZIP compression

## Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

### Environment Variables

Set these in Railway dashboard:

```
TARGET_URL=https://eflow.ie
LOG_LEVEL=info
LOG_REQUESTS=true
ENABLE_WEBSOCKET=true
ENABLE_COMPRESSION=true
PROXY_TIMEOUT=30000
```

Railway automatically sets `PORT` - don't override it.

## Local Development

```bash
npm install
npm start
```

Set environment variables in `.env` file or shell.

## License

MIT

