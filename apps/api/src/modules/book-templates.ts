import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContextResolver } from '../context.js';
import { parse } from './shared.js';

const formats = {
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;
export async function registerBookTemplates(app: FastifyInstance, context: ContextResolver) {
  app.get('/custom-books/templates/:format', async (request, reply) => {
    await context(request);
    const { format } = parse(z.object({ format: z.enum(['txt', 'docx', 'pdf']) }), request.params);
    const filename = `nightstudy-wordbook-template.${format}`;
    return reply
      .type(formats[format])
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'public, max-age=3600')
      .send(fs.createReadStream(path.resolve('docs/templates', filename)));
  });
}
