import { Request, Response, NextFunction } from 'express';
import * as projectsService from './projects.service';
import { createProjectSchema, updateProjectSchema, saveWorkflowSchema } from './projects.schema';
import prisma from '../../config/database';
import {
  stopContainer,
  restartContainer,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
  copyProjectFile,
  deleteProjectFile,
  moveProjectFile,
  startContainerLogs,
  stopContainerLogs,
  syncProjectRepository,
} from '../../services/agent-ws.service';
import { aiService } from '../../services/ai.service';

export async function listProjects(req: Request, res: Response, next: NextFunction) {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const result = await projectsService.listProjects(page, limit);
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

export async function getProjectById(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const project = await projectsService.getProjectById(req.params.id);
    res.json({ status: 'success', data: { project } });
  } catch (error) {
    next(error);
  }
}

export async function createProject(req: Request, res: Response, next: NextFunction) {
  try {
    const data = createProjectSchema.parse(req.body);
    const project = await projectsService.createProject(data);
    res.status(201).json({ status: 'success', data: { project } });
  } catch (error) {
    next(error);
  }
}

export async function updateProject(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const data = updateProjectSchema.parse(req.body);
    const project = await projectsService.updateProject(req.params.id, data);
    res.json({ status: 'success', data: { project } });
  } catch (error) {
    next(error);
  }
}

export async function deleteProject(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    await projectsService.deleteProject(req.params.id);
    res.json({ status: 'success', message: 'Project deleted' });
  } catch (error) {
    next(error);
  }
}

export async function saveWorkflow(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const data = saveWorkflowSchema.parse(req.body);
    const steps = await projectsService.saveWorkflow(req.params.id, data);
    res.json({ status: 'success', data: { steps } });
  } catch (error) {
    next(error);
  }
}

export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    const stats = await projectsService.getProjectStats();
    res.json({ status: 'success', data: stats });
  } catch (error) {
    next(error);
  }
}

// ── Container lifecycle ───────────────────────────────────────────────────────

async function resolveNodeAndImage(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw Object.assign(new Error('Projeto não encontrado'), { statusCode: 404 });
  if (!project.nodeId) throw Object.assign(new Error('Projeto não possui nodeId configurado'), { statusCode: 400 });
  const imageName = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return { project, imageName };
}

export async function stopProject(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    await stopContainer(project.nodeId!, imageName);
    res.json({ status: 'success', message: 'Container parado' });
  } catch (error) {
    next(error);
  }
}

export async function restartProject(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    await restartContainer(project.nodeId!, imageName);
    res.json({ status: 'success', message: 'Container reiniciado' });
  } catch (error) {
    next(error);
  }
}

// ── File manager ──────────────────────────────────────────────────────────────

export async function listFiles(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    const filePath = (req.query.path as string) ?? '';
    const entries = await listProjectFiles(project.nodeId!, imageName, filePath);
    res.json({ status: 'success', data: { entries } });
  } catch (error) {
    next(error);
  }
}

export async function getFileContent(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    const filePath = (req.query.path as string) ?? '';
    if (!filePath) {
      res.status(400).json({ status: 'error', message: 'path query param required' });
      return;
    }
    const content = await readProjectFile(project.nodeId!, imageName, filePath);
    res.json({ status: 'success', data: { content } });
  } catch (error) {
    next(error);
  }
}

export async function updateFile(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      res.status(400).json({ status: 'error', message: 'path and content are required' });
      return;
    }
    await writeProjectFile(project.nodeId!, imageName, filePath, content);
    res.json({ status: 'success', message: 'Arquivo salvo' });
  } catch (error) {
    next(error);
  }
}

export async function copyFile(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    const { path: filePath, dest: destPath } = req.body;
    if (!filePath || !destPath) {
      res.status(400).json({ status: 'error', message: 'path and dest are required' });
      return;
    }
    await copyProjectFile(project.nodeId!, imageName, filePath, destPath);
    res.json({ status: 'success', message: 'Arquivo copiado' });
  } catch (error) {
    next(error);
  }
}

export async function deleteFile(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    const filePath = (req.query.path as string) ?? '';
    if (!filePath) {
      res.status(400).json({ status: 'error', message: 'path query param required' });
      return;
    }
    await deleteProjectFile(project.nodeId!, imageName, filePath);
    res.json({ status: 'success', message: 'Arquivo excluído' });
  } catch (error) {
    next(error);
  }
}

export async function moveFile(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    const { path: filePath, dest: destPath } = req.body;
    if (!filePath || !destPath) {
      res.status(400).json({ status: 'error', message: 'path and dest are required' });
      return;
    }
    await moveProjectFile(project.nodeId!, imageName, filePath, destPath);
    res.json({ status: 'success', message: 'Arquivo movido' });
  } catch (error) {
    next(error);
  }
}

export async function analyzeProject(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    
    // 1. Get file list
    const entries = await listProjectFiles(project.nodeId!, imageName, '');
    const files = entries.map(e => e.path);

    // 2. Read key files
    const keyFiles = ['package.json', 'go.mod', 'Dockerfile', '.env.example', 'requirements.txt', 'pom.xml', 'docker-compose.yml'];
    const fileContents: Record<string, string> = {};

    for (const f of keyFiles) {
      // Check if file exists in the flat list
      const exists = entries.find(e => e.path === f && !e.isDir);
      if (exists) {
        try {
          fileContents[f] = await readProjectFile(project.nodeId!, imageName, f);
        } catch (e) {
          // ignore individual read errors
        }
      }
    }

    // 3. AI Analysis
    const analysis = await aiService.analyzeRepository(files, fileContents);
    res.json({ status: 'success', data: analysis });
  } catch (error) {
    next(error);
  }
}

export async function startLogs(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    startContainerLogs(project.nodeId!, imageName);
    res.json({ status: 'success', message: 'Log streaming iniciado' });
  } catch (error) {
    next(error);
  }
}

export async function stopLogs(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    stopContainerLogs(project.nodeId!, imageName);
    res.json({ status: 'success', message: 'Log streaming parado' });
  } catch (error) {
    next(error);
  }
}
export async function syncRepository(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { project, imageName } = await resolveNodeAndImage(req.params.id);
    await syncProjectRepository(
      project.nodeId!,
      project.repoUrl,
      project.branchTarget,
      imageName
    );
    res.json({ status: 'success', message: 'Repositório sincronizado com sucesso' });
  } catch (error) {
    next(error);
  }
}
