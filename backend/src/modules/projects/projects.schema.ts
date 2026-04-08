import { z } from 'zod';

export const workflowStepSchema = z.object({
  name: z.string().min(1, 'Nome do passo é obrigatório'),
  type: z.enum(['LOCAL_COMMAND', 'REMOTE_SSH_COMMAND']),
  command: z.string().min(1, 'Comando é obrigatório'),
  order: z.number().int().positive(),
});

export const saveWorkflowSchema = z.object({
  steps: z.array(workflowStepSchema),
});

export type SaveWorkflowInput = z.infer<typeof saveWorkflowSchema>;

export const createProjectSchema = z.object({
  name: z.string().min(2),
  repoUrl: z.string().url('Must be a valid URL'),
  environmentType: z.enum(['LOCAL', 'CLOUD', 'NODE']).default('LOCAL'),
  nodeId: z.string().uuid().optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(2).optional(),
  repoUrl: z.string().url().optional(),
  branchTarget: z.string().optional(),
  environmentType: z.enum(['LOCAL', 'CLOUD']).optional(),
  status: z.enum(['ATIVO', 'FALHOU', 'PAUSADO']).optional(),
  autoDeployEnabled: z.boolean().optional(),
  lbEnabled: z.boolean().optional(),
  lbPort: z.number().int().positive().nullable().optional(),
  lbAppPort: z.number().int().positive().nullable().optional(),
  lbDomain: z.string().nullable().optional(),
  lbHealthPath: z.string().optional(),
  proxyHost: z.string().nullable().optional(),
  proxyPort: z.number().int().positive().nullable().optional(),
  cloudServerId: z.string().uuid().nullable().optional(),
  nodeId: z.string().uuid().nullable().optional(),
  envVars: z.array(z.string()).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
