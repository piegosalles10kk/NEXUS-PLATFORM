import { Request, Response, NextFunction } from 'express';
import prisma from '../../config/database';
import { runPipeline } from '../../services/pipeline.service';

export async function handleGithubWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const event = req.headers['x-github-event'] as string;

    // Only process push events
    if (event !== 'push') {
      res.json({ status: 'ignored', message: `Event '${event}' is not handled` });
      return;
    }

    const payload = req.body;
    const branch = payload.ref?.replace('refs/heads/', '');
    const repoUrl = payload.repository?.clone_url || payload.repository?.html_url;
    const commitHash = payload.head_commit?.id?.substring(0, 7);
    const commitMsg = payload.head_commit?.message;
    const commitAuthorName = payload.head_commit?.author?.name || null;
    const commitAuthorEmail = payload.head_commit?.author?.email || null;

    if (!branch || !repoUrl) {
      res.status(400).json({ status: 'error', message: 'Invalid webhook payload' });
      return;
    }

    // Find projects that match this repo and branch, with auto-deploy enabled
    const projects = await prisma.project.findMany({
      where: {
        repoUrl: { contains: payload.repository?.full_name || repoUrl },
        branchTarget: branch,
        status: { not: 'PAUSADO' },
        autoDeployEnabled: true,
      },
    });

    if (projects.length === 0) {
      res.json({
        status: 'ignored',
        message: `No active projects with auto-deploy enabled found for ${repoUrl} on branch ${branch}`,
      });
      return;
    }

    const io = req.app.get('io');
    const deployIds: string[] = [];

    // Trigger pipeline for each matching project
    for (const project of projects) {
      const deploy = await prisma.deployHistory.create({
        data: {
          projectId: project.id,
          commitHash,
          commitMsg,
          commitAuthorName,
          commitAuthorEmail,
          status: 'RUNNING',
        },
      });

      deployIds.push(deploy.id);

      // Run pipeline asynchronously
      runPipeline({
        projectId: project.id,
        deployId: deploy.id,
        repoUrl: project.repoUrl,
        branch: project.branchTarget,
        projectName: project.name,
        environmentType: project.environmentType,
        nodeId: project.nodeId ?? undefined,
        commitHash,
        commitMsg,
        io,
      }).catch((err) => {
        console.error(`Pipeline error for project ${project.name}:`, err);
      });
    }

    res.json({
      status: 'success',
      message: `Triggered ${projects.length} pipeline(s)`,
      data: { deployIds },
    });
  } catch (error) {
    next(error);
  }
}
