import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export interface AuthRequest extends Request {
  user?: any;
}

export const authenticateJWT = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];

    jwt.verify(token, config.jwtSecret, (err, user) => {
      if (err) {
        return res.sendStatus(403); // Token không hợp lệ hoặc đã hết hạn
      }
      req.user = user;
      next();
    });
  } else {
    res.sendStatus(401); // Không có token
  }
};
