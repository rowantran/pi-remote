/** Promisifying a desktop operation is harmless; invoking it still reaches its throwing stub. */
export function promisify(fn: (...args: any[]) => any) {
  return (...args: any[]): Promise<any> => new Promise((resolve, reject) => {
    fn(...args, (error: unknown, value: unknown) => error ? reject(error) : resolve(value));
  });
}
