export class ChannexAdoptionConsumptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChannexAdoptionConsumptionError";
  }
}

export function rejectAdoption(code: string, message = code): never {
  throw new ChannexAdoptionConsumptionError(code, message);
}
