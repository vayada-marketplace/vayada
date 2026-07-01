export function unsupportedPmsNextStackFeature<T = never>(feature: string): Promise<T> {
  return Promise.reject(new Error(`${feature} is not available on PMS next-stack yet.`));
}

export function throwUnsupportedPmsNextStackFeature(feature: string): never {
  throw new Error(`${feature} is not available on PMS next-stack yet.`);
}
