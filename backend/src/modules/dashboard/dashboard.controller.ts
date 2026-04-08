import { Request, Response, NextFunction } from 'express';
import prisma from '../../config/database';

export async function getWidgets(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user.id;
    const widgets = await prisma.dashboardWidget.findMany({
      where: { userId },
      orderBy: [{ y: 'asc' }, { x: 'asc' }],
    });
    res.json({ status: 'success', data: { widgets } });
  } catch (error) {
    next(error);
  }
}

export async function createWidget(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user.id;
    const { type, title, settings, x, y, w, h } = req.body;

    const widget = await prisma.dashboardWidget.create({
      data: {
        userId,
        type,
        title,
        settings: settings || {},
        x: x || 0,
        y: y || 0,
        w: w || 1,
        h: h || 1,
      },
    });

    res.status(201).json({ status: 'success', data: { widget } });
  } catch (error) {
    next(error);
  }
}

export async function deleteWidget(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const userId = (req as any).user.id;

    await prisma.dashboardWidget.delete({
      where: { id, userId },
    });

    res.json({ status: 'success', message: 'Widget removed.' });
  } catch (error) {
    next(error);
  }
}

export async function updateLayout(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user.id;
    const { widgets } = req.body as { widgets: Array<{ id: string; x: number; y: number; w: number; h: number }> };

    // Batch update using a transaction
    const updates = widgets.map((w) =>
      prisma.dashboardWidget.update({
        where: { id: w.id, userId },
        data: { x: w.x, y: w.y, w: w.w, h: w.h },
      })
    );

    await prisma.$transaction(updates);

    res.json({ status: 'success', message: 'Layout updated.' });
  } catch (error) {
    next(error);
  }
}
