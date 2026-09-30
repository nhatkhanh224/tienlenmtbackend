import { Router } from 'express';
import { getBalance } from '../controllers/wallet.controller';
import { authenticateJWT } from '../middlewares/auth.middleware';

const router = Router();

router.get('/balance', authenticateJWT, getBalance);

export default router;
