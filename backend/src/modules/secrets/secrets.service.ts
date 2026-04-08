import prisma from '../../config/database';
import { encrypt, decrypt } from '../../services/crypto.service';
import { NotFoundError, ConflictError } from '../../utils/errors';
import { CreateSecretInput, UpdateSecretInput } from './secrets.schema';

export async function listSecrets(projectId: string) {
  // Return only key names, never the encrypted values in listing
  const secrets = await prisma.projectSecret.findMany({
    where: { projectId },
    select: { id: true, keyName: true, projectId: true },
    orderBy: { keyName: 'asc' },
  });

  return secrets;
}

export async function createSecret(projectId: string, data: CreateSecretInput) {
  // Check if key already exists for this project
  const existing = await prisma.projectSecret.findUnique({
    where: { projectId_keyName: { projectId, keyName: data.keyName } },
  });

  if (existing) {
    throw new ConflictError(`Secret '${data.keyName}' already exists in this project`);
  }

  const encryptedValue = encrypt(data.value);

  const secret = await prisma.projectSecret.create({
    data: {
      projectId,
      keyName: data.keyName,
      encryptedValue,
    },
    select: { id: true, keyName: true, projectId: true },
  });

  return secret;
}

export async function updateSecret(secretId: string, data: UpdateSecretInput) {
  const existing = await prisma.projectSecret.findUnique({ where: { id: secretId } });
  if (!existing) throw new NotFoundError('Secret');

  const encryptedValue = encrypt(data.value);

  const secret = await prisma.projectSecret.update({
    where: { id: secretId },
    data: { encryptedValue },
    select: { id: true, keyName: true, projectId: true },
  });

  return secret;
}

export async function revealSecret(secretId: string) {
  const secret = await prisma.projectSecret.findUnique({ where: { id: secretId } });
  if (!secret) throw new NotFoundError('Secret');

  const decryptedValue = decrypt(secret.encryptedValue);

  return { id: secret.id, keyName: secret.keyName, value: decryptedValue };
}

export async function deleteSecret(secretId: string) {
  const existing = await prisma.projectSecret.findUnique({ where: { id: secretId } });
  if (!existing) throw new NotFoundError('Secret');

  await prisma.projectSecret.delete({ where: { id: secretId } });
}
