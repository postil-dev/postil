import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TOKEN_PREFIX = "v1";

function keyFromSecret(secret: string): Buffer {
  if (!secret.trim()) throw new Error("TRIGGER_SECRET_KEY must be set for review token encryption");
  return createHash("sha256").update(secret, "utf8").digest();
}

function aadFromContext(context: ReviewTokenContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      installationId: context.installationId,
      repoFullName: context.repoFullName,
      pullNumber: context.pullNumber,
      headSha: context.headSha,
    }),
    "utf8",
  );
}

function encode(input: Buffer): string {
  return input.toString("base64url");
}

function decode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export type ReviewTokenContext = {
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
};

export function encryptReviewInstallationToken(input: {
  token: string;
  secret: string;
  context: ReviewTokenContext;
}): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFromSecret(input.secret), iv);
  cipher.setAAD(aadFromContext(input.context));

  const ciphertext = Buffer.concat([
    cipher.update(input.token, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [TOKEN_PREFIX, encode(iv), encode(tag), encode(ciphertext)].join(".");
}

export function decryptReviewInstallationToken(input: {
  encryptedToken: string;
  secret: string;
  context: ReviewTokenContext;
}): string {
  const parts = input.encryptedToken.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) {
    throw new Error("Invalid encrypted installation token envelope");
  }

  const iv = decode(parts[1]);
  const tag = decode(parts[2]);
  const ciphertext = decode(parts[3]);

  if (iv.length !== IV_BYTES) throw new Error("Invalid encrypted installation token iv");
  if (!timingSafeEqual(Buffer.from(parts[0]), Buffer.from(TOKEN_PREFIX))) {
    throw new Error("Invalid encrypted installation token version");
  }

  const decipher = createDecipheriv(ALGORITHM, keyFromSecret(input.secret), iv);
  decipher.setAAD(aadFromContext(input.context));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
