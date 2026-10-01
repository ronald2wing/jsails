/**
 * Shared deploy-config validators.
 *
 * The Valkey, database, hardening, and hosting generators each validate their
 * inputs against a small set of conservative string shapes (identifiers, image
 * references, plain-object options). The validation logic and the emitted
 * messages are identical across modules; only the thrown error class differs,
 * so each module binds its own error via the `error` factory.
 */

/** Turns a validation message into a module-specific error. */
export type ValidatorErrorFactory = new (message: string) => Error;

/** Control characters (including newlines) that can break YAML/commands. */
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

/** Conservative identifier: letters/digits start, then letters/digits/`._-`. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Docker image reference: registry/namespace/name, tag, or digest. */
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:\-@]*$/;

/** Validate a conservative identifier (Compose names, volume, network, service). */
export function assertIdentifier(
  value: string,
  label: string,
  error: ValidatorErrorFactory,
): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new error(
      `${label} must match [A-Za-z0-9][A-Za-z0-9._-]* (no whitespace or shell characters)`,
    );
  }
  return value;
}

/**
 * Validate a Docker image reference (no shell/control characters). Unlike
 * {@link assertPinnedImage}, this does not require a pinned tag — used for the
 * application image, whose tag is managed by the deploy tooling.
 */
function assertImageRef(value: string, label: string, error: ValidatorErrorFactory): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new error(`${label} must be a non-empty image reference`);
  }
  if (CONTROL_PATTERN.test(value) || !IMAGE_PATTERN.test(value)) {
    throw new error(`${label} contains characters that are not valid in a Docker image reference`);
  }
  return value;
}

/** Extract the tag segment of an image reference, or `undefined` when untagged. */
function imageTag(ref: string): string | undefined {
  const lastSlash = ref.lastIndexOf('/');
  const last = ref.slice(lastSlash + 1);
  const at = last.indexOf('@');
  const nameAndTag = at === -1 ? last : last.slice(0, at);
  const colon = nameAndTag.lastIndexOf(':');
  return colon === -1 ? undefined : nameAndTag.slice(colon + 1);
}

/**
 * Validate a pinned image reference. Rejects floating tags (`latest`, or a bare
 * name that resolves to it) so the image is always a specific version.
 */
export function assertPinnedImage(
  value: string,
  label: string,
  error: ValidatorErrorFactory,
): string {
  assertImageRef(value, label, error);
  const tag = imageTag(value);
  const hasDigest = value.slice(value.lastIndexOf('/') + 1).includes('@');
  if (tag === undefined && !hasDigest) {
    throw new error(
      `${label} must be pinned to a tag or digest (a floating "latest" image is not allowed)`,
    );
  }
  if (tag !== undefined && tag.toLowerCase() === 'latest') {
    throw new error(`${label} must not use the "latest" tag; pin a specific version`);
  }
  return value;
}

/** Reject a non-plain-object options argument. */
export function assertPlainOptions(
  options: unknown,
  label: string,
  error: ValidatorErrorFactory,
): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new error(`${label} must be a plain object`);
  }
}
