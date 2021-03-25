import { HttpListener, jsonOk, ok, yaml, file, LoggerContext } from '@ovotech/laminar';
import { PgContext } from '@ovotech/laminar-pg';
import { QueueContext } from '@ovotech/laminar-pgboss';
import { jwtSecurityResolver } from '@ovotech/laminar-jwt';
import { join } from 'path';
import { openApiTyped } from '../../__generated__/schema';
import { EnvVars } from '../../env';
import { hydrationMeterReadsRoute } from './hydration-meter-reads.route';
import { meterReadsRoute } from './meter-reads.route';

export type HttpListenerContext = PgContext & LoggerContext & QueueContext;

export const httpListener = async (env: EnvVars): Promise<HttpListener<HttpListenerContext>> => {
  const schemaFilename = join(__dirname, '../../../schema.yaml');
  const app = await openApiTyped<HttpListenerContext>({
    api: schemaFilename,
    security: {
      BearerAuth: jwtSecurityResolver({ secret: env.SECRET }),
    },
    paths: {
      '/.well-known/health-check': {
        get: async () => jsonOk({ healthy: true }),
      },
      '/.well-known/openapi.yaml': {
        get: async () => yaml(ok(file(schemaFilename))),
      },
      '/v1/hydration/meter-reads': {
        post: hydrationMeterReadsRoute,
      },
      '/v1/meter-reads': {
        get: meterReadsRoute,
      },
    },
  });

  return app;
};
