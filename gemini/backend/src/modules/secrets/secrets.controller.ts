import { Request, Response, NextFunction } from 'express';
import * as secretsService from './secrets.service';
import { createSecretSchema, updateSecretSchema } from './secrets.schema';

export async function listSecrets(req: Request<{ projectId: string }>, res: Response, next: NextFunction) {
  try {
    const secrets = await secretsService.listSecrets(req.params.projectId);
    res.json({ status: 'success', data: { secrets } });
  } catch (error) {
    next(error);
  }
}

export async function createSecret(req: Request<{ projectId: string }>, res: Response, next: NextFunction) {
  try {
    const data = createSecretSchema.parse(req.body);
    const secret = await secretsService.createSecret(req.params.projectId, data);
    res.status(201).json({ status: 'success', data: { secret } });
  } catch (error) {
    next(error);
  }
}

export async function updateSecret(req: Request<{ secretId: string }>, res: Response, next: NextFunction) {
  try {
    const data = updateSecretSchema.parse(req.body);
    const secret = await secretsService.updateSecret(req.params.secretId, data);
    res.json({ status: 'success', data: { secret } });
  } catch (error) {
    next(error);
  }
}

export async function revealSecret(req: Request<{ secretId: string }>, res: Response, next: NextFunction) {
  try {
    const secret = await secretsService.revealSecret(req.params.secretId);
    res.json({ status: 'success', data: { secret } });
  } catch (error) {
    next(error);
  }
}

export async function deleteSecret(req: Request<{ secretId: string }>, res: Response, next: NextFunction) {
  try {
    await secretsService.deleteSecret(req.params.secretId);
    res.json({ status: 'success', message: 'Secret deleted' });
  } catch (error) {
    next(error);
  }
}
