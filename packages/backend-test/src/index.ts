import type { FastifyInstance, InjectOptions } from "fastify";

export type InjectJsonResponse<TBody> = {
  statusCode: number;
  body: TBody;
};

export async function injectJson<TBody>(
  app: FastifyInstance,
  options: InjectOptions,
): Promise<InjectJsonResponse<TBody>> {
  const response = await app.inject(options);

  return {
    statusCode: response.statusCode,
    body: response.json<TBody>(),
  };
}
