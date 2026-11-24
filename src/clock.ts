/** Current time in milliseconds since the epoch. Injected so tests can move time. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export const iso = (ms: number): string => new Date(ms).toISOString();
