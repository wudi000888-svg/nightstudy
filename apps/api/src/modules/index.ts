import type { FastifyInstance } from 'fastify';
import type { ContextResolver } from '../context.js';
import { registerContent } from './content.js';
import { registerStudy } from './study.js';
import { registerKnown } from './known.js';
import { registerAssessment } from './assessment.js';
import { registerAnalytics } from './analytics.js';

export async function registerModules(
  app: FastifyInstance,
  getContext: ContextResolver,
): Promise<void> {
  await registerContent(app, getContext);
  await registerStudy(app, getContext);
  await registerKnown(app, getContext);
  await registerAssessment(app, getContext);
  await registerAnalytics(app, getContext);
}
