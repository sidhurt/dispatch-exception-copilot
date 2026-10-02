// Every refusal the ERP gives. Shape matches docs/SPEC.md §5.6.

export type ErrorDetail = { code: string; target?: string; message?: string; [k: string]: unknown };

export class ErpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message);
  }

  toBody() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const notFound = (what: string) => new ErpError(404, 'NOT_FOUND', `${what} does not exist.`);
export const invalidState = (message: string) => new ErpError(409, 'INVALID_STATE', message);
export const validationFailed = (message: string, details: ErrorDetail[] = []) =>
  new ErpError(400, 'VALIDATION_FAILED', message, details);
