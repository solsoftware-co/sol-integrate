// The only valid ENVIRONMENT values. It's a plain string binding at runtime
// (wrangler.toml [vars] / --var), so it's parsed here rather than trusted —
// anything else, including a typo or a missing var, throws instead of
// silently falling through to some default behavior — here, a real or a
// mocked Mailchimp write. Same values as sol-notify.
export const environments = ["development", "preview", "staging", "production"] as const;

export type Environment = (typeof environments)[number];

export class InvalidEnvironmentError extends Error {
  constructor(value: unknown) {
    super(`Invalid ENVIRONMENT ${JSON.stringify(value)} — expected one of: ${environments.join(", ")}`);
    this.name = "InvalidEnvironmentError";
  }
}

export function parseEnvironment(value: unknown): Environment {
  if (typeof value === "string" && (environments as readonly string[]).includes(value)) {
    return value as Environment;
  }
  throw new InvalidEnvironmentError(value);
}
