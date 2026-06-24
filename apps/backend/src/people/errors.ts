// Typed errors thrown by PeopleStore mutations. Route handlers instanceof-check
// these to translate to HTTP status codes:
//
//   PersonNotFoundError              → 404
//   UserNotFoundError                → 404
//   UserAlreadyAttachedError         → 409 (caller must detach first)
//   UserNotAttachedToPersonError     → 400 (wrong personId)

export class PersonNotFoundError extends Error {
  constructor(public readonly personId: number) {
    super(`person ${personId} not found`);
    this.name = 'PersonNotFoundError';
  }
}

export class UserNotFoundError extends Error {
  constructor(public readonly userId: number) {
    super(`user ${userId} not found`);
    this.name = 'UserNotFoundError';
  }
}

// Attach targeting a user whose `person_id` is already non-NULL (same or
// different person). The store does NOT auto-move aliases — caller detaches first.
export class UserAlreadyAttachedError extends Error {
  constructor(
    public readonly userId: number,
    public readonly currentPersonId: number,
  ) {
    super(`user ${userId} is already attached to person ${currentPersonId}`);
    this.name = 'UserAlreadyAttachedError';
  }
}

// detach / setPrimary when the user exists but isn't attached to the URL's
// personId. Distinct from UserNotFoundError so the route picks the right code.
export class UserNotAttachedToPersonError extends Error {
  constructor(
    public readonly userId: number,
    public readonly personId: number,
    public readonly actualPersonId: number | null,
  ) {
    super(
      actualPersonId === null
        ? `user ${userId} is not attached to any person (expected ${personId})`
        : `user ${userId} is attached to person ${actualPersonId}, not ${personId}`,
    );
    this.name = 'UserNotAttachedToPersonError';
  }
}
