import { createClient } from 'redis';
import logger from '../utils/logger';

// Redis client for sessions and execution state
const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  password: process.env.REDIS_PASSWORD || undefined,
});

redisClient.on('error', (err) => {
  logger.error('Redis client error:', err);
});

redisClient.on('connect', () => {
  logger.info('Redis client connected');
});

// Connect immediately
redisClient.connect().catch((err) => {
  logger.error('Failed to connect to Redis:', err);
});

export default redisClient;
