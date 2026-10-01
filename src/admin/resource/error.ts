/** Raised for invalid resource specs. Messages never embed input values. */
export class ResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceError';
  }
}
