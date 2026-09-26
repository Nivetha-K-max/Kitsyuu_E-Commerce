/* Errors thrown by the server packages. Messages are safe to show to the signed-in staff member. */
export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'DomainError'; this.code = code; }
}
/** The actor lacks a permission, or the change would give them (or someone) more than they hold. */
export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to do that.') { super('forbidden', message); this.name = 'ForbiddenError'; }
}
export class NotFoundError extends DomainError {
  constructor(message = 'Not found.') { super('not_found', message); this.name = 'NotFoundError'; }
}
/** The change conflicts with current data (duplicate email, role in use, last administrator, …). */
export class ConflictError extends DomainError {
  constructor(message: string) { super('conflict', message); this.name = 'ConflictError'; }
}
