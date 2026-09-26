export interface Env {
  API_KEY: string;
  ENVIRONMENT: string;
  SOL_API_URL: string;
  SOL_API_KEY: string;
  SOL_NOTIFY_URL: string;
  SOL_NOTIFY_API_KEY: string;
  /** Released package.json version, injected at deploy time by CI (release.yml). Unset locally. */
  APP_VERSION?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { requestId: string };
};

export enum ErrorCode {
  UNAUTHORIZED = "UNAUTHORIZED",
  NOT_FOUND = "NOT_FOUND",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: { code: ErrorCode; message: string; details?: unknown } };
