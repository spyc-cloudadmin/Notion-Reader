export class HttpError extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
