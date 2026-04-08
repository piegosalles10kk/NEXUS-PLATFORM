import bcrypt from 'bcrypt';
import prisma from '../../config/database';
import { NotFoundError, ConflictError } from '../../utils/errors';
import { CreateUserInput, UpdateUserInput } from './users.schema';

const SALT_ROUNDS = 12;

export async function listUsers(page: number = 1, limit: number = 20) {
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, email: true, role: true, createdAt: true, updatedAt: true },
    }),
    prisma.user.count(),
  ]);

  return { users, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getUserById(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, role: true, createdAt: true, updatedAt: true },
  });

  if (!user) throw new NotFoundError('User');
  return user;
}

export async function createUser(data: CreateUserInput) {
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new ConflictError('Email already registered');

  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      passwordHash,
      role: data.role,
    },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  return user;
}

export async function updateUser(id: string, data: UpdateUserInput) {
  await getUserById(id); // throws NotFoundError if not found

  if (data.email) {
    const existing = await prisma.user.findFirst({
      where: { email: data.email, NOT: { id } },
    });
    if (existing) throw new ConflictError('Email already in use');
  }

  const user = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, name: true, email: true, role: true, createdAt: true, updatedAt: true },
  });

  return user;
}

export async function deleteUser(id: string) {
  await getUserById(id);
  await prisma.user.delete({ where: { id } });
}
