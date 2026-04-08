import { Request, Response, NextFunction } from 'express';
import { getSetting, setSetting, deleteSetting, isSettingSet } from '../../services/settings.service';
import { env } from '../../config/env';

const MANAGED_KEYS = ['GITHUB_WEBHOOK_SECRET'] as const;
type ManagedKey = typeof MANAGED_KEYS[number];

const KEY_META: Record<ManagedKey, { label: string; description: string }> = {
  GITHUB_WEBHOOK_SECRET: {
    label: 'GitHub Webhook Secret',
    description: 'Segredo usado para validar a assinatura HMAC-SHA256 dos eventos enviados pelo GitHub.',
  },
};

// ─── Docker Proxy Permissions ─────────────────────────────────────────────────
const DOCKER_PERMISSION_KEYS = [
  'DOCKER_ALLOW_CONTAINERS_CREATE',
  'DOCKER_ALLOW_VOLUMES_DELETE',
  'DOCKER_ALLOW_IMAGES_DELETE',
] as const;
type DockerPermissionKey = typeof DOCKER_PERMISSION_KEYS[number];

const DOCKER_PERMISSION_META: Record<DockerPermissionKey, { label: string; description: string }> = {
  DOCKER_ALLOW_CONTAINERS_CREATE: {
    label: 'Criar Containers',
    description: 'Permite que o sistema crie e inicie novos containers Docker durante deploys.',
  },
  DOCKER_ALLOW_VOLUMES_DELETE: {
    label: 'Remover Volumes',
    description: 'Permite que o sistema remova volumes Docker ao excluir projetos ou limpar recursos.',
  },
  DOCKER_ALLOW_IMAGES_DELETE: {
    label: 'Remover Imagens',
    description: 'Permite que o sistema remova imagens Docker após builds ou ao limpar o cache.',
  },
};

export async function listDockerPermissions(_req: Request, res: Response, next: NextFunction) {
  try {
    const permissions = await Promise.all(
      DOCKER_PERMISSION_KEYS.map(async (key) => {
        const stored = await getSetting(key);
        const enabled = stored !== null ? stored === '1' : true; // default: enabled
        return { key, ...DOCKER_PERMISSION_META[key], enabled };
      }),
    );
    res.json({ status: 'success', data: { permissions } });
  } catch (error) {
    next(error);
  }
}

export async function updateDockerPermission(
  req: Request<{ key: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const { key } = req.params;
    if (!DOCKER_PERMISSION_KEYS.includes(key as DockerPermissionKey)) {
      res.status(400).json({ status: 'error', message: `Permissão '${key}' desconhecida.` });
      return;
    }
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ status: 'error', message: 'Campo "enabled" deve ser boolean.' });
      return;
    }
    await setSetting(key, enabled ? '1' : '0');
    res.json({ status: 'success', message: `Permissão '${key}' ${enabled ? 'habilitada' : 'desabilitada'}.` });
  } catch (error) {
    next(error);
  }
}

export async function listSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const settings = await Promise.all(
      MANAGED_KEYS.map(async (key) => ({
        key,
        ...KEY_META[key],
        isSet: await isSettingSet(key),
        source: (await isSettingSet(key)) ? 'database' : 'env',
      })),
    );
    res.json({ status: 'success', data: { settings } });
  } catch (error) {
    next(error);
  }
}

export async function updateSetting(req: Request<{ key: string }>, res: Response, next: NextFunction) {
  try {
    const { key } = req.params;
    if (!MANAGED_KEYS.includes(key as ManagedKey)) {
      res.status(400).json({ status: 'error', message: `Chave '${key}' não é gerenciável.` });
      return;
    }
    const { value } = req.body as { value: string };
    if (!value || typeof value !== 'string' || value.trim().length === 0) {
      res.status(400).json({ status: 'error', message: 'O valor não pode ser vazio.' });
      return;
    }
    await setSetting(key, value.trim());
    res.json({ status: 'success', message: `Configuração '${key}' salva com sucesso.` });
  } catch (error) {
    next(error);
  }
}

export async function resetSetting(req: Request<{ key: string }>, res: Response, next: NextFunction) {
  try {
    const { key } = req.params;
    if (!MANAGED_KEYS.includes(key as ManagedKey)) {
      res.status(400).json({ status: 'error', message: `Chave '${key}' não é gerenciável.` });
      return;
    }
    await deleteSetting(key);
    res.json({ status: 'success', message: `Configuração '${key}' redefinida para variável de ambiente.` });
  } catch (error) {
    next(error);
  }
}
