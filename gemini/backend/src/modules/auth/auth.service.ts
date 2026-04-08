import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../../config/database';
import { generateToken, JwtPayload } from '../../middlewares/auth';
import { sendPasswordResetEmail } from '../../services/email.service';
import { UnauthorizedError, NotFoundError, ConflictError } from '../../utils/errors';
import { LoginInput, RegisterInput, ForgotPasswordInput, ResetPasswordInput } from './auth.schema';
import { Role } from '@prisma/client';

const SALT_ROUNDS = 12;

export async function login(data: LoginInput): Promise<{ token: string; user: JwtPayload }> {
  const user = await prisma.user.findUnique({ where: { email: data.email } });

  if (!user) {
    throw new UnauthorizedError('Invalid credentials');
  }

  const passwordValid = await bcrypt.compare(data.password, user.passwordHash);

  if (!passwordValid) {
    throw new UnauthorizedError('Invalid credentials');
  }

  const payload: JwtPayload = {
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
  };

  const token = generateToken(payload);

  return { token, user: payload };
}

export async function register(data: RegisterInput): Promise<JwtPayload> {
  const existingUser = await prisma.user.findUnique({ where: { email: data.email } });

  if (existingUser) {
    throw new ConflictError('Email already registered');
  }

  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      passwordHash,
      role: (data.role as Role) || 'OBSERVADOR',
    },
  });

  return { id: user.id, email: user.email, role: user.role, name: user.name };
}

export async function forgotPassword(data: ForgotPasswordInput): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: data.email } });

  // Always respond with success (don't reveal if email exists)
  if (!user) {
    return;
  }

  // Generate reset token
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
  const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetToken: resetTokenHash,
      resetExpires,
    },
  });

  // Send email with the un-hashed token
  await sendPasswordResetEmail(user.email, resetToken);
}

export async function resetPassword(data: ResetPasswordInput): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(data.token).digest('hex');

  const user = await prisma.user.findFirst({
    where: {
      resetToken: tokenHash,
      resetExpires: { gt: new Date() },
    },
  });

  if (!user) {
    throw new UnauthorizedError('Invalid or expired reset token');
  }

  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      resetToken: null,
      resetExpires: null,
    },
  });
}

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  if (!user) {
    throw new NotFoundError('User');
  }

  return user;
}
