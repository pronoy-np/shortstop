// Vite/vitest `?raw` imports (test setup and evals load fixtures and seed SQL this way).
declare module "*?raw" {
  const text: string;
  export default text;
}
