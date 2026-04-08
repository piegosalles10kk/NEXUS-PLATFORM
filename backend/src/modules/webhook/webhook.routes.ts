import { Router } from 'express';
import { handleGithubWebhook } from './webhook.controller';
import { validateWebhookSignature } from '../../middlewares/webhook-signature';

const router = Router();

router.post('/github', validateWebhookSignature, handleGithubWebhook);

export default router;
