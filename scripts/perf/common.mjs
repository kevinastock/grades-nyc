import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import https from "node:https";
import path from "node:path";

export const profiles = Object.freeze({
  localhost: { cpu: 1, latency: 0, kbps: 0, width: 1440, height: 900, dpr: 2 },
  fiber: {
    cpu: 1,
    latency: 10,
    kbps: 100000,
    width: 1440,
    height: 900,
    dpr: 2,
  },
  "5g": { cpu: 2, latency: 40, kbps: 50000, width: 390, height: 844, dpr: 2 },
  "moderate-cell": {
    cpu: 4,
    latency: 40,
    kbps: 10000,
    width: 390,
    height: 844,
    dpr: 2,
  },
});

export const outOption = { type: "string", default: ".cache/perf" };
export function cumulativeLayoutShift(entries) {
  let maximum = 0,
    session = 0,
    first = -Infinity,
    previous = -Infinity;
  for (const entry of entries) {
    if (entry.start - previous >= 1000 || entry.start - first >= 5000) {
      session = 0;
      first = entry.start;
    }
    session += entry.value;
    maximum = Math.max(maximum, session);
    previous = entry.start;
  }
  return maximum;
}
export const nameList = (value) => {
  const names = value.split(",").filter(Boolean);
  if (!names.length || names.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name)))
    throw new Error(
      "Use comma-separated names containing only letters, numbers, - or _.",
    );
  return [...new Set(names)];
};
export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

/** Keep trust limited to this fixture's key, without modifying the OS keychain.
 * Globally ignoring certificate errors disables Chromium HTTP-cache writes. */
export async function fixtureCertificate(output) {
  const directory = path.join(output, "tls");
  const certFile = path.join(directory, "cert.pem");
  const keyFile = path.join(directory, "key.pem");
  await mkdir(directory, { recursive: true });
  try {
    await readFile(certFile);
    await readFile(keyFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "365",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
    await chmod(keyFile, 0o600);
  }
  const cert = await readFile(certFile);
  const certificate = new X509Certificate(cert);
  if (Date.parse(certificate.validTo) <= Date.now())
    throw new Error(
      "Fixture TLS certificate expired; remove .cache/perf/tls and restart the server.",
    );
  const publicKey = certificate.publicKey.export({
    type: "spki",
    format: "der",
  });
  const spki = createHash("sha256").update(publicKey).digest("base64");
  return { cert, key: await readFile(keyFile), spki };
}

/** Node control traffic is restricted to the loopback fixture. Browser traffic
 * uses the certificate's SPKI instead, preserving normal HTTP caching. */
export async function fixtureRequest(
  origin,
  pathname,
  { method = "GET", body } = {},
) {
  const target = new URL(pathname, origin);
  if (
    target.protocol !== "https:" ||
    !["localhost", "127.0.0.1"].includes(target.hostname)
  )
    throw new Error(
      "Performance control requests must target the local fixture.",
    );
  return new Promise((resolve, reject) => {
    const request = https.request(
      target,
      {
        method,
        rejectUnauthorized: false,
        headers: body ? { "content-type": "application/json" } : undefined,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (response.statusCode !== 200)
            return reject(new Error(`${response.statusCode}: ${text}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
