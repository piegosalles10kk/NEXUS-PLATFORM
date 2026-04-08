import { Request, Response, NextFunction } from 'express';
import * as usersService from './users.service';
import { createUserSchema, updateUserSchema } from './users.schema';

export async function listUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const result = await usersService.listUsers(page, limit);
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

export async function getUserById(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const user = await usersService.getUserById(req.params.id);
    res.json({ status: 'success', data: { user } });
  } catch (error) {
    next(error);
  }
}

export async function createUser(req: Request, res: Response, next: NextFunction) {
  try {
    const data = createUserSchema.parse(req.body);
    const user = await usersService.createUser(data);
    res.status(201).json({ status: 'success', data: { user } });
  } catch (error) {
    next(error);
  }
}

export async function updateUser(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const data = updateUserSchema.parse(req.body);
    const user = await usersService.updateUser(req.params.id, data);
    res.json({ status: 'success', data: { user } });
  } catch (error) {
    next(error);
  }
}

export async function deleteUser(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    await usersService.deleteUser(req.params.id);
    res.json({ status: 'success', message: 'User deleted' });
  } catch (error) {
    next(error);
  }
}
