// Disposable loopback event source for the release soak; no inference.
import { createServer } from 'node:net';
const server = createServer(socket => {
  socket.on('error', () => {});
  socket.on('data', bytes => socket.write(bytes));
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port, rss: process.memoryUsage().rss }));
process.on('disconnect', () => server.close());
