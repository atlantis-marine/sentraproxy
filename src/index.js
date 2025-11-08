const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const cors = require('cors');
const helmet = require('helmet');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Utility functions
const isValidUrl = (urlString) => {
  try {
    const url = new URL(urlString);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
  } catch {
    return false;
  }
};

const getHttpModule = (protocol) => {
  return protocol === 'https:' ? https : http;
};

// Logging middleware
const requestLogger = (req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.originalUrl} - IP: ${req.ip}`);
  next();
};

app.use(requestLogger);

// Native proxy function
const proxyRequest = (req, res) => {
  const targetUrl = req.query.url;
  const method = req.method;

  // Validation
  if (!targetUrl) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'URL parameter is required',
      example: '/proxy?url=https://example.com/api/data'
    });
  }

  if (!isValidUrl(targetUrl)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid URL format',
      details: 'URL must be a valid HTTP or HTTPS URL'
    });
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const httpModule = getHttpModule(parsedUrl.protocol);

    console.log(`Native proxying ${method} request to: ${targetUrl}`);
    if (req.body && Object.keys(req.body).length > 0) {
      console.log('Request body:', JSON.stringify(req.body, null, 2));
    }

    // Prepare request options
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'User-Agent': 'NativeProxy/1.0.0',
        'Accept': req.headers['accept'] || 'application/json',
        'Authorization': req.headers['authorization'] || '',
        'X-Requested-With': req.headers['x-requested-with'] || '',
        ...req.headers['x-custom-header'] && { 'X-Custom-Header': req.headers['x-custom-header'] }
      },
      // Ignore SSL certificate errors
      rejectUnauthorized: false,
      timeout: 30000
    };

    // Add content-length if we have data
    if (['POST', 'PUT', 'PATCH'].includes(method) && req.body) {
      const bodyData = JSON.stringify(req.body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    // Add query parameters from original request (except 'url')
    const queryParams = new URLSearchParams();
    if (req.query && Object.keys(req.query).length > 1) {
      Object.entries(req.query).forEach(([key, value]) => {
        if (key !== 'url') {
          queryParams.append(key, value);
        }
      });
    }

    if (queryParams.toString()) {
      const separator = options.path.includes('?') ? '&' : '?';
      options.path += separator + queryParams.toString();
    }

    console.log('Native proxy options:', {
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: options.method,
      hasBody: !!req.body
    });

    // Create the proxy request
    const proxyReq = httpModule.request(options, (proxyRes) => {
      console.log(`Response status: ${proxyRes.statusCode} from: ${targetUrl}`);

      // Set response headers
      res.status(proxyRes.statusCode);

      // Copy important headers from target response
      const headersToCopy = [
        'content-type',
        'content-length',
        'cache-control',
        'etag',
        'last-modified'
      ];

      headersToCopy.forEach(headerName => {
        if (proxyRes.headers[headerName]) {
          res.setHeader(headerName, proxyRes.headers[headerName]);
        }
      });

      // Add CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Custom-Header');

      // Handle response data
      let responseData = Buffer.alloc(0);

      proxyRes.on('data', (chunk) => {
        responseData = Buffer.concat([responseData, chunk]);
      });

      proxyRes.on('end', () => {
        // Try to parse as JSON if content-type indicates JSON
        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          try {
            const jsonData = JSON.parse(responseData.toString());
            res.json(jsonData);
          } catch (error) {
            res.send(responseData);
          }
        } else {
          res.send(responseData);
        }
      });
    });

    // Handle request errors
    proxyReq.on('error', (error) => {
      console.error('Proxy request error:', error.message);

      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Cannot connect to target server',
          details: 'The target server is not reachable'
        });
      }

      if (error.code === 'ETIMEDOUT') {
        return res.status(504).json({
          error: 'Gateway Timeout',
          message: 'Request to target server timed out'
        });
      }

      if (error.code === 'CERT_HAS_EXPIRED' || error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        // Certificate error but we should still try to continue
        console.log('SSL certificate error detected, proceeding anyway...');
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to proxy request',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    });

    // Handle request timeout
    proxyReq.on('timeout', () => {
      console.error('Proxy request timeout');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({
          error: 'Gateway Timeout',
          message: 'Request to target server timed out'
        });
      }
    });

    // Send request body if present
    if (['POST', 'PUT', 'PATCH'].includes(method) && req.body) {
      proxyReq.write(JSON.stringify(req.body));
    }

    proxyReq.end();

  } catch (error) {
    console.error('Proxy setup error:', error.message);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to setup proxy request',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Proxy endpoint - supports all HTTP methods
app.all('/proxy', proxyRequest);

// Alternative path-based proxy for direct routing
app.use('/api/*', (req, res) => {
  const apiPath = req.originalUrl;
  const targetUrl = `https://119.13.101.169${apiPath}`;

  // Temporarily modify the query for the proxy function
  const originalQuery = req.query;
  req.query = { url: targetUrl };

  proxyRequest(req, res);

  // Restore original query
  req.query = originalQuery;
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    proxyType: 'native-nodejs',
    endpoints: {
      proxy: '/proxy?url=<target-url>',
      download: '/download?url=<file-url>',
      websocket: '/ws-proxy?url=<ws-url>',
      pathBased: '/api/* (auto-routes to 119.13.101.169)',
      health: '/health'
    },
    features: [
      'HTTP/HTTPS proxy',
      'File download streaming',
      'WebSocket proxy',
      'Large file support',
      'SSL certificate bypass',
      'Range request support'
    ]
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Native Node.js Proxy Server',
    version: '1.0.0',
    proxyType: 'native-nodejs',
    usage: {
      proxy: 'ANY HTTP METHOD /proxy?url=<target-url>',
      download: 'ANY HTTP METHOD /download?url=<file-url>',
      websocket: 'WebSocket /ws-proxy?url=<ws-url>',
      examples: [
        'GET /proxy?url=https://api.example.com/data',
        'POST /proxy?url=https://api.example.com/auth',
        'GET /download?url=https://example.com/largefile.zip',
        'WebSocket connection to ws://localhost:3000/ws-proxy with x-target-url header'
      ]
    },
    health: 'GET /health',
    features: [
      'Pure Node.js implementation',
      'No external proxy libraries',
      'Full HTTP method support',
      'Request/response body handling',
      'Header forwarding',
      'SSL certificate bypass',
      'Better error handling',
      'Response status preservation',
      'Large file download streaming',
      'WebSocket proxy support',
      'Range request support',
      'Download progress tracking'
    ]
  });
});

// Enhanced file download endpoint
app.all('/download', (req, res) => {
  const targetUrl = req.query.url;
  const method = req.method;

  // Validation
  if (!targetUrl) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'URL parameter is required',
      example: '/download?url=https://example.com/largefile.zip'
    });
  }

  if (!isValidUrl(targetUrl)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid URL format',
      details: 'URL must be a valid HTTP or HTTPS URL'
    });
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const httpModule = getHttpModule(parsedUrl.protocol);

    console.log(`Downloading file from: ${targetUrl}`);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: {
        'User-Agent': 'NativeProxy/1.0.0',
        'Accept': '*/*',
        'Authorization': req.headers['authorization'] || '',
        'Range': req.headers['range'] || ''
      },
      rejectUnauthorized: false,
      timeout: 60000 // 60 seconds for large files
    };

    const proxyReq = httpModule.request(options, (proxyRes) => {
      console.log(`Download response status: ${proxyRes.statusCode} from: ${targetUrl}`);

      // Set response headers
      res.status(proxyRes.statusCode);

      // Copy important headers for file download
      const headersToCopy = [
        'content-type',
        'content-length',
        'content-disposition',
        'accept-ranges',
        'etag',
        'last-modified',
        'cache-control'
      ];

      headersToCopy.forEach(headerName => {
        if (proxyRes.headers[headerName]) {
          res.setHeader(headerName, proxyRes.headers[headerName]);
        }
      });

      // Add CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Custom-Header, Range');

      // Stream the response directly for large files
      const fileSize = parseInt(proxyRes.headers['content-length'] || '0');
      let downloadedBytes = 0;
      const startTime = Date.now();

      proxyRes.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        res.write(chunk);

        // Log progress for files larger than 1MB
        if (fileSize > 1024 * 1024) {
          const progress = ((downloadedBytes / fileSize) * 100).toFixed(2);
          const speed = (downloadedBytes / 1024 / ((Date.now() - startTime) / 1000)).toFixed(2);
          console.log(`Download progress: ${progress}% (${speed} KB/s)`);
        }
      });

      proxyRes.on('end', () => {
        res.end();
        const duration = (Date.now() - startTime) / 1000;
        console.log(`Download completed: ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB in ${duration.toFixed(2)} seconds`);
      });

      proxyRes.on('error', (error) => {
        console.error('Download stream error:', error.message);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Download Error',
            message: 'Failed to stream file from target server'
          });
        }
      });
    });

    proxyReq.on('error', (error) => {
      console.error('Download request error:', error.message);

      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Cannot connect to target server'
        });
      }

      if (error.code === 'ETIMEDOUT') {
        return res.status(504).json({
          error: 'Gateway Timeout',
          message: 'Download request timed out'
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to setup download request',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    });

    proxyReq.on('timeout', () => {
      console.error('Download request timeout');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({
          error: 'Gateway Timeout',
          message: 'Download request timed out'
        });
      }
    });

    proxyReq.end();

  } catch (error) {
    console.error('Download setup error:', error.message);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to setup download request',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// WebSocket Proxy endpoint
app.get('/ws-proxy', (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'WebSocket URL parameter is required',
      example: '/ws-proxy?url=wss://example.com/socket'
    });
  }

  if (!isValidUrl(targetUrl) || !targetUrl.match(/^wss?:\/\//)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid WebSocket URL format',
      details: 'URL must be a valid WebSocket URL (ws:// or wss://)'
    });
  }

  res.json({
    message: 'WebSocket proxy endpoint',
    instructions: [
      'Use WebSocket client to connect to: ws://localhost:' + PORT + '/ws-proxy',
      'Include target URL in header: x-target-url: ' + targetUrl,
      'Or use WebSocket upgrade directly to target URL'
    ],
    examples: [
      'const ws = new WebSocket("ws://localhost:' + PORT + '/ws-proxy");',
      'ws.onopen = () => ws.send(JSON.stringify({ target: "' + targetUrl + '" }));'
    ]
  });
});

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'Endpoint not found',
    availableEndpoints: ['/proxy', '/download', '/ws-proxy', '/api/*', '/health', '/']
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Create HTTP server with WebSocket support
const server = http.createServer(app);

// WebSocket server for proxying WebSocket connections
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const targetUrl = request.headers['x-target-url'];

  if (!targetUrl) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  try {
    const targetWs = new WebSocket(targetUrl, {
      headers: {
        'User-Agent': 'NativeProxy/1.0.0',
        'Authorization': request.headers['authorization'] || '',
        'Cookie': request.headers['cookie'] || ''
      }
    });

    console.log(`WebSocket proxying: ${targetUrl}`);

    targetWs.on('open', () => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        console.log('WebSocket connection established');

        // Proxy messages from client to target
        ws.on('message', (message) => {
          try {
            targetWs.send(message);
            console.log(`WebSocket message proxied to target: ${message.length} bytes`);
          } catch (error) {
            console.error('Error sending message to target:', error.message);
            ws.close(1011, 'Proxy error');
          }
        });

        // Proxy messages from target to client
        targetWs.on('message', (message) => {
          try {
            ws.send(message);
            console.log(`WebSocket message proxied to client: ${message.length} bytes`);
          } catch (error) {
            console.error('Error sending message to client:', error.message);
            targetWs.close();
          }
        });

        // Handle connection close
        ws.on('close', (code, reason) => {
          console.log(`Client WebSocket closed: ${code} ${reason}`);
          targetWs.close();
        });

        targetWs.on('close', (code, reason) => {
          console.log(`Target WebSocket closed: ${code} ${reason}`);
          ws.close(code, reason);
        });

        // Handle errors
        ws.on('error', (error) => {
          console.error('Client WebSocket error:', error.message);
          targetWs.close();
        });

        targetWs.on('error', (error) => {
          console.error('Target WebSocket error:', error.message);
          ws.close(1011, 'Target WebSocket error');
        });

        // Send connection ready message
        ws.send(JSON.stringify({
          type: 'connected',
          target: targetUrl,
          timestamp: new Date().toISOString()
        }));
      });
    });

    targetWs.on('error', (error) => {
      console.error('Failed to connect to target WebSocket:', error.message);
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    });

  } catch (error) {
    console.error('WebSocket proxy error:', error.message);
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Native Node.js Proxy server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Proxy endpoint: http://localhost:${PORT}/proxy?url=<target-url>`);
  console.log(`💾 Download endpoint: http://localhost:${PORT}/download?url=<file-url>`);
  console.log(`🔌 WebSocket endpoint: http://localhost:${PORT}/ws-proxy?url=<ws-url>`);
  console.log(`🛠️  Using pure Node.js HTTP/HTTPS modules (no external proxy libraries)`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;