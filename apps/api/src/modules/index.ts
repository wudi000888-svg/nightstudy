import type { FastifyInstance } from 'fastify';
import type { ContextResolver } from '../context.js';
import { registerContent } from './content.js';
import { registerStudy } from './study.js';
import { registerKnown } from './known.js';
import { registerAssessment } from './assessment.js';
import { registerAnalytics } from './analytics.js';
import { registerTranslation } from './translation.js';
import { registerPronunciation } from './pronunciation.js';
import { registerSystem } from './system.js';
import { registerFleet } from './fleet.js';
import { registerCustomBooks } from './custom-books.js';
import { registerDictionaryResolver } from './dictionary-resolver.js';
import { registerBookTemplates } from './book-templates.js';
import { registerLearningLibrary } from './learning-library.js';
import { registerAcademy } from './academy.js';
import { registerAppHome } from './app-home.js';
import type { FleetTransport } from './fleet-transport.js';
import type { DeepSeekTransport } from '../providers/deepseek.js';

export async function registerModules(
  app: FastifyInstance,
  getContext: ContextResolver,
  options: { fleetTransport?: FleetTransport; deepSeekTransport?: DeepSeekTransport } = {},
): Promise<void> {
  await registerContent(app, getContext);
  await registerStudy(app, getContext);
  await registerKnown(app, getContext);
  await registerAssessment(app, getContext, { transport: options.deepSeekTransport });
  await registerAnalytics(app, getContext);
  await registerTranslation(app, getContext);
  await registerPronunciation(app, getContext);
  await registerSystem(app, getContext);
  await registerFleet(app, getContext, { transport: options.fleetTransport });
  await registerCustomBooks(app, getContext);
  await registerDictionaryResolver(app, getContext);
  await registerBookTemplates(app, getContext);
  await registerLearningLibrary(app, getContext);
  await registerAcademy(app, getContext);
  await registerAppHome(app, getContext);
}
