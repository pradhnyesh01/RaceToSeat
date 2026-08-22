import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 does not forward a rejected promise from an async handler to
// error-handling middleware — it becomes an unhandled rejection that crashes
// the process (Node 15+ default), taking down every in-flight request, not
// just the one that errored. Wrapping routes in this forwards the error to
// `next()` instead.
export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}
