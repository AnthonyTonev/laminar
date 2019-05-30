import { Middleware } from '../../src';

export type LoggerFunc = (message: string) => void;
export interface LoggerContext {
  logger: LoggerFunc;
}

export const withLogger = (func: LoggerFunc): Middleware<LoggerContext> => resolver => ctx =>
  resolver({ ...ctx, logger: func });
