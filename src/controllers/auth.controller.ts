import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { config } from '../config/env';

const prisma = new PrismaClient();

export const register = async (req: Request, res: Response) => {
  try {
    const { username, password, email } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu!' });
    }

    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) {
      return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại! Vui lòng chọn tên khác.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        email,
        wallet: {
          create: {
            balance: 10000 // Tặng 10000 xu cho tài khoản mới
          }
        }
      },
      include: {
        wallet: true
      }
    });

    res.status(201).json({ message: 'Đăng ký tài khoản thành công! Tặng 10.000 xu thưởng.', userId: user.id });
  } catch (error: any) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Lỗi hệ thống khi đăng ký!' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu!' });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return res.status(400).json({ error: 'Tài khoản chưa được đăng ký! Vui lòng đăng ký trước khi đăng nhập.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Mật khẩu không chính xác!' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, config.jwtSecret, {
      expiresIn: '30d'
    });

    res.json({ token, userId: user.id, username: user.username });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Lỗi hệ thống khi đăng nhập!' });
  }
};
