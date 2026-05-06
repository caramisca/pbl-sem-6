import { Router, type Request, type Response } from 'express';
import type { Store } from './store.js';

/**
 * Callback shape used by `POST /api/ingest`. The handler delegates to this
 * so the same validation/merge/log pipeline is shared with the WebSocket
 * path; index.ts wires the real implementation.
 */
export type IngestHandler = (
  payload: unknown,
) => { ok: true } | { ok: false; error: string };

/**
 * Build the REST API. The routes are intentionally thin: they read/write
 * the in-memory Store and the simulator does all the heavy lifting.
 */
export function buildRouter(
  store: Store,
  startedAt: number,
  ingest: IngestHandler,
): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      devices: store.listDevices().length,
    });
  });

  router.get('/devices', (_req: Request, res: Response) => {
    res.json(store.listDevices());
  });

  router.get('/telemetry/:deviceId', (req: Request, res: Response) => {
    const deviceId = req.params['deviceId'] as string;
    const device = store.getDevice(deviceId);
    if (!device) {
      res.status(404).json({ error: 'device_not_found', deviceId });
      return;
    }
    res.json({
      device,
      latest: store.getLatest(deviceId) ?? null,
      history: store.getHistory(deviceId),
    });
  });

  router.get('/alerts', (_req: Request, res: Response) => {
    res.json(store.listAlerts());
  });

  router.get('/thresholds', (_req: Request, res: Response) => {
    res.json(store.getThresholds());
  });

  router.put('/thresholds', (req: Request, res: Response) => {
    const next = store.updateThresholds(req.body);
    res.json(next);
  });

  router.post('/ingest', (req: Request, res: Response) => {
    const result = ingest(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(204).end();
  });

  return router;
}
