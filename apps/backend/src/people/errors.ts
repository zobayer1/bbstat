// Typed errors thrown by PeopleStore mutations. Route handlers do
// instanceof checks to translate to HTTP status codes:
//
//   PersonNotFoundError              → 404
//   UserNotFoundError                → 404
//   UserAlreadyAttachedError         → 409 (conflict — caller must detach first)
//   UserNotAttachedToPersonError     → 400 (caller passed the wrong personId)
//
// Same naming convention as bitbucket/errors.ts.

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

// Thrown when an attach (or create-with-primary) targets a user whose
// `person_id` is already non-NULL — regardless of whether the existing
// attachment is to the same person or a different one. The caller must
// detach first if they intend to re-attach; the store does NOT
// auto-move aliases between people.
export class UserAlreadyAttachedError extends Error {
  constructor(
    public readonly userId: number,
    public readonly currentPersonId: number,
  ) {
    super(`user ${userId} is already attached to person ${currentPersonId}`);
    this.name = 'UserAlreadyAttachedError';
  }
}

// Thrown by detach / setPrimary when the user exists but isn't attached
// to the personId in the URL (either unattached or attached to a
// different person). Distinct from UserNotFoundError so the route can
// pick the right HTTP code + error code.
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
