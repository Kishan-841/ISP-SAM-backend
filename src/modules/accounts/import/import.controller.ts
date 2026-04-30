import type { Request, Response } from 'express';
import { importService } from './import.service.js';

export const importController = {
  async upload(req: Request, res: Response) {
    const file = (req as Request & { file?: { buffer: Buffer; originalname?: string } }).file;
    if (!file) {
      res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
      return;
    }
    try {
      const summary = await importService.importWorkbook(file.buffer);
      res.status(200).json(summary);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Import failed',
      });
    }
  },
};
