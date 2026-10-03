import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middlewares/auth.middleware';

const prisma = new PrismaClient();

export const getBalance = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user.id;
    const wallet = await prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId, balance: 10000 }
    });

    res.json({ balance: wallet.balance.toString() }); // Trả về dạng string vì BigInt không tự serialize JSON được
  } catch (error: any) {
    console.error('Wallet error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
