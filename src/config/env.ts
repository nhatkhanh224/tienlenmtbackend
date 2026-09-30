import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 3001,
  jwtSecret: process.env.JWT_SECRET || 'secret-key-for-dev',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
};
