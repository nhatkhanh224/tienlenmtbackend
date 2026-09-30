import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { config } from './config/env';

import authRoutes from './routes/auth.routes';
import walletRoutes from './routes/wallet.routes';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // Trong thực tế sẽ cấu hình URL cụ thể
    methods: ['GET', 'POST']
  }
});

import { setupSocket } from './socket/room.handler';

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Tien Len Mien Trung API is running' });
});

setupSocket(io);

httpServer.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});
