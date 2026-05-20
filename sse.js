const express = require('express');
const router = express.Router();

// Active clients set (in-memory, strictly transient for active connections)
const clients = new Set();

router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial immediate connection message
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  clients.add(res);

  // Handle connection close
  req.on('close', () => {
    clients.delete(res);
  });
});

// Send heartbeat comment to all clients every 25 seconds
setInterval(() => {
  for (const client of clients) {
    try {
      client.write(': heartbeat\n\n');
    } catch (err) {
      clients.delete(client);
    }
  }
}, 25000);

/**
 * Broadcasts JSON data to all connected clients
 * @param {object} data
 */
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (err) {
      clients.delete(client);
    }
  }
}

module.exports = {
  router,
  broadcast
};
