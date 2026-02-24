// Load environment variables FIRST
console.log('[STARTUP] Loading environment variables...');
import dotenv from 'dotenv';
dotenv.config();
console.log('[STARTUP] Environment loaded, importing express...');

import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import cors from 'cors';
import helmet from 'helmet';
import DatabasePools from './config/database';
import redisClient from './config/redis';
import historyService from './services/history.service';
import logger from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

// Routes
import authRoutes from './routes/auth.routes';
import queryRoutes from './routes/query.routes';
import historyRoutes from './routes/history.routes';
import schemaRoutes from './routes/schema.routes';
import replicationRoutes from './routes/replication.routes';

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (for sessions behind load balancer)
app.set('trust proxy', 1);

// Middleware
// Use Helmet but disable CSP in production (Pomerium handles authentication redirects)
// Disable HTTPS redirect in production (Pomerium/ALB handles SSL termination)
app.use(helmet({
  // Disable HSTS in production - let Pomerium/ALB handle it
  hsts: process.env.NODE_ENV === 'production' ? false : {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  // Disable CSP in production - Pomerium auth redirects need external domains
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? false : {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
}));

// CORS configuration - allow frontend origin
app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        process.env.FRONTEND_URL || 'http://localhost:5173',
        'http://localhost:5174',
        process.env.BACKEND_URL || 'http://localhost:3000',
      ];
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Session middleware
app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      httpOnly: true,
      maxAge: parseInt(process.env.SESSION_TTL_SECONDS || '43200', 10) * 1000, // Default 12 hours
      sameSite: 'lax',
    },
  })
);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Routes
console.log('[STARTUP] Mounting routes...');
app.use('/api/auth', authRoutes);
console.log('[STARTUP] ✓ /api/auth routes mounted');
app.use('/api/query', queryRoutes);
console.log('[STARTUP] ✓ /api/query routes mounted');
app.use('/api/history', historyRoutes);
console.log('[STARTUP] ✓ /api/history routes mounted');
app.use('/api/schemas', schemaRoutes);
console.log('[STARTUP] ✓ /api/schemas routes mounted');
app.use('/api/replication', replicationRoutes);
console.log('[STARTUP] ✓ /api/replication routes mounted');

// 404 handler
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down gracefully...');

  try {
    // Close database pools
    const dbPools = DatabasePools.getInstance();
    await dbPools.shutdown();

    // Close Redis connection
    await redisClient.quit();

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
const startServer = async () => {
  try {
    console.log('[STARTUP] Starting server initialization...');
    console.log(`[STARTUP] PORT: ${PORT}`);
    console.log(`[STARTUP] NODE_ENV: ${process.env.NODE_ENV}`);
    console.log(`[STARTUP] REDIS_CLUSTER_MODE: ${process.env.REDIS_CLUSTER_MODE || 'false'}`);

    // Connect to Redis (skip if already connected from module import)
    console.log('[STARTUP] Connecting to Redis...');
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    console.log('[STARTUP] Redis connected successfully');

    // Initialize database pools
    console.log('[STARTUP] Initializing database pools...');
    DatabasePools.getInstance();
    console.log('[STARTUP] Database pools initialized');

    // Initialize history database schema (if enabled)
    if (process.env.RUN_MIGRATIONS === 'true') {
      console.log('[STARTUP] Initializing history schema...');
      await historyService.initializeSchema();
      console.log('[STARTUP] History schema initialized');
    } else {
      console.log('[STARTUP] Schema initialization skipped (RUN_MIGRATIONS not set)');
    }

    // Start listening
    console.log('[STARTUP] Starting HTTP server...');
    app.listen(PORT, () => {
      console.log(`[STARTUP] ✅ Server listening on port ${PORT}`);
      logger.info(`🚀 Server started on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
    });
  } catch (error) {
    console.error('[STARTUP] ❌ Failed to start server:', error);
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

console.log('[STARTUP] Calling startServer()...');
startServer();
