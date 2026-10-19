// Domain errors thrown by the job service. The API layer maps them to HTTP
// status codes; the service itself knows nothing about HTTP.

export class JobNotFoundError extends Error {
  status = 404;
}

/** The job exists but is in the wrong state for this action (e.g. resume a completed job). */
export class JobStateError extends Error {
  status = 409;
}

export class JobInputError extends Error {
  status = 400;
}
