/** HTTP errors shared by the REST API and the MCP tools. */
import type { Issue } from "./bpmn/types";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, issues: Issue[] = []) {
    super(message, 400, issues);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Process not found.") {
    super(message, 404);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, issues: Issue[]) {
    super(message, 422, issues);
  }
}
