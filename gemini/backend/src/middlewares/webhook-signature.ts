import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { UnauthorizedError } from '../utils/errors';
import { getWebhookSecret } from '../services/settings.service';

export async function validateWebhookSignature(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!signature) {
      throw new UnauthorizedError('Missing x-hub-signature-256 header');
    }

    const secret = await getWebhookSecret();
    const body = JSON.stringify(req.body);
    const expectedSignature =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(body).digest('hex');

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      throw new UnauthorizedError('Invalid webhook signature');
    }

    next();
  } catch (error) {
    next(error);
  }
}
