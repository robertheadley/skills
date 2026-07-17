'use strict';

const http = require('node:http');

function requestJson({ port, pathname, method = 'GET', token = undefined, body = undefined, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}),
      },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (error) { reject(new Error(`Invalid JSON response from VibeCat service: ${error.message}`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`VibeCat service request timed out after ${timeoutMs} ms.`)));
    request.on('error', reject);
    if (raw) request.write(raw);
    request.end();
  });
}

module.exports = { requestJson };
