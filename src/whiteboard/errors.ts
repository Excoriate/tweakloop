export class WhiteboardError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "WhiteboardError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
